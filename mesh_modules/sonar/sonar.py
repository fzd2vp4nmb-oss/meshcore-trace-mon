"""
mesh_modules/sonar/sonar.py

Modulo SONAR (docs/ARCHITECTURE.md §87): acquisisce i path dei
messaggi PUBBLICI di un canale dedicato ("TM-Sonar") e, su richiesta,
trasmette il messaggio periodico numerato che gli altri nodi
registrano.

Tre responsabilità, tutte sullo stesso canale e indipendenti dal bot:

  1. RICEZIONE — sottoscrive RX_LOG_DATA (come contact_sync, mai
     CHANNEL_MSG_RECV, che appartiene al bot e passa dalla coda
     messaggi del device) e registra in sonar_rx una riga per ogni
     ricezione fisica di un messaggio sonar ben formato, col path
     ESATTAMENTE come lo espone la libreria (mai ricostruito).
     L'appartenenza al canale è verificata dal MAC del pacchetto: la
     libreria valorizza 'chan_name' solo se l'HMAC del GRP_TXT torna
     col segreto del canale, quindi un pacchetto di un altro canale
     (o con lo stesso hash di 1 byte ma segreto diverso) non passa.

  2. TRASMISSIONE — send(): riserva il progressivo in sonar_tx, imposta
     lo scope, invia il messaggio sul canale, ripristina lo scope di
     default e registra l'esito. Chiamata SOLO dall'IPC (il daemon è
     l'unico proprietario del device); la pianificazione è del
     crontab (sonar.sh).

  3. CANALE — ensure_channel()/_resolve_channel(): trova il canale per
     nome sul device, lo adotta se il segreto coincide con quello
     configurato (o se nessun segreto è configurato), lo CREA in uno
     slot libero se manca (e se c'è un segreto da usare o ne viene
     richiesta la generazione), non sovrascrive MAI un canale
     esistente con lo stesso nome ma segreto diverso.

Principi (tutti verificati da sandbox_tests/test_sonar_*.py):

  - Nessuna eccezione esce da un handler di evento né dal costruttore:
    un errore del sonar non deve toccare bot, trace, advert, né il
    daemon (v. services/loader.py: un'eccezione del costruttore di un
    servizio ferma l'intero daemon).
  - Il segreto del canale non compare mai in log né in risposte, salvo
    la richiesta esplicita ensure_channel(reveal_secret=True).
  - Nessuna perdita silenziosa: ogni scarto o errore di scrittura è
    contato (status) e loggato (con limite di frequenza), mai ignorato.
  - Tutti i comandi al device sono serializzati da
    engine.command_lock: i task in background lo acquisiscono con
    acquire_command_lock(); send()/ensure_channel() sono invocati
    dall'IPC, che lo tiene GIÀ per tutta la durata del comando (v.
    services/ipc_server.py) e quindi NON lo riacquisiscono.
  - Il flood scope si imposta SEMPRE esplicitamente prima di inviare;
    se non si riesce a impostarlo non si invia (v. ARCHITECTURE.md
    §17/§18/§32), e dopo l'invio si ripristina il default del device
    così che un floodadv successivo (che non imposta alcuno scope)
    non erediti quello del sonar.
"""

import asyncio
import functools
import hashlib
import re
import secrets
import time

from meshcore.events import EventType

from core.config import config
from core.logger import log
from mesh_modules.contact_sync.db import ContactDB
from mesh_modules.sonar.protocol import (
    SCOPE_CMD_DEFAULT,
    build_message,
    normalize_scope,
    parse_channel_text,
    src_prefix_from_public_key,
)
from mesh_modules.sonar.settings import (
    CHANNEL_SECRET_BYTES,
    SonarSettings,
)


#
# Stati del canale (SonarModule.channel_status)
#
STATUS_NOT_STARTED = "not_started"
STATUS_CONFIG_ERROR = "config_error"
STATUS_RESOLVING = "resolving"
STATUS_READY = "ready"
STATUS_MISSING = "missing"
STATUS_CONFLICT = "conflict"
STATUS_NO_FREE_SLOT = "no_free_slot"
STATUS_CREATE_FAILED = "create_failed"
STATUS_DEVICE_UNAVAILABLE = "device_unavailable"
STATUS_ERROR = "error"

#
# Stati dopo i quali ha senso riprovare da soli: il device (o la
# connessione) non ha risposto, non ha rifiutato. Gli altri sono
# decisioni definitive che richiedono un intervento (config, canale
# in conflitto, slot liberi, ensure_channel).
#
_TRANSIENT_STATUSES = (STATUS_DEVICE_UNAVAILABLE, STATUS_ERROR)

#
# Rete di sicurezza sul numero di slot interrogati dalla scansione
# (stessa motivazione e stesso valore di BotModule.MAX_CHANNELS: la
# scansione si ferma normalmente al primo ERROR del firmware, ma non
# deve diventare infinita se quel comportamento cambiasse).
#
MAX_CHANNELS = 64

#
# Attese tra i tentativi di risoluzione del canale dopo un errore
# transitorio (secondi). L'ultimo valore si ripete: nessun tentativo
# è mai definitivamente abbandonato finché il canale non è risolto.
#
RESOLVE_RETRY_DELAYS = (10, 30, 60, 120, 300)

#
# Intervallo minimo (secondi) tra due log identici di uno stesso
# scarto in ricezione: un flusso anomalo non deve riempire il log.
# I log soppressi sono contati e riportati nel log successivo.
#
LOG_RATE_LIMIT_SECS = 60

#
# Ragioni con cui la libreria segnala "nessuna risposta" (v.
# CommandHandlerBase.send/wait_for_events): il comando può essere
# stato eseguito dal device anche se non abbiamo visto la risposta.
#
_TIMEOUT_REASONS = ("timeout", "no_event_received")

_HEX_RE = re.compile(r"^[0-9a-fA-F]*$")

#
# Tentativi di generazione di un segreto il cui hash di canale a 1 byte
# non coincida con quello di un altro canale del device: con al più 64
# slot occupati su 256 valori possibili la probabilità che servano
# tutti è trascurabile, ma il ciclo non deve mai poter diventare
# infinito.
#
_MAX_SECRET_ATTEMPTS = 64


def _channel_hash(secret):
    """
    Hash di canale a 1 byte (esadecimale) come lo calcola la libreria
    (primo byte di SHA-256 del segreto, v. reader.py CHANNEL_INFO) —
    è l'unico dato del canale che compare in chiaro in ogni pacchetto
    GRP_TXT e l'unico che il filtro del bot confronta.
    """

    return hashlib.sha256(secret).hexdigest()[0:2]

#
# Coerenza del path esposto dalla libreria: lunghezza massima in hop
# (path_len è 6 bit nel formato del pacchetto) e dimensioni ammesse
# dell'hash di ciascun hop.
#
_MAX_PATH_HOPS = 63
_VALID_HASH_SIZES = (1, 2, 3, 4)


def _is_indeterminate(payload):
    """
    True se l'Event(ERROR) NON è un rifiuto del firmware ma un esito
    sconosciuto: timeout in attesa della risposta ('reason' in
    _TIMEOUT_REASONS) oppure eccezione di trasporto ('error' senza
    'error_code'). In questi casi il comando potrebbe comunque essere
    stato eseguito. Un ERROR con 'error_code' (o vuoto) è invece un
    rifiuto esplicito del firmware: il comando NON è stato eseguito.
    """

    if not isinstance(payload, dict):
        return True

    if payload.get("reason") in _TIMEOUT_REASONS:
        return True

    return "error" in payload and "error_code" not in payload


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _num_or_none(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None

    return value


def _short(payload, limit=120):
    """Rappresentazione breve e sicura di un payload di errore."""

    text = repr(payload)

    return text if len(text) <= limit else text[:limit] + "..."


class SonarModule:

    def __init__(self, engine, settings=None):

        self.engine = engine

        self.settings = (
            settings if settings is not None
            else SonarSettings.from_config(config)
        )

        #
        # Aperto in modo pigro e ripetibile da _run_db(): un database
        # momentaneamente non apribile (disco, permessi) non deve
        # impedire l'avvio del modulo né richiedere un riavvio per
        # riprendere.
        #
        self.db = None
        self._db_lock = asyncio.Lock()

        #
        # Info del canale così come restituita da get_channel()
        # (CONTIENE il segreto: mai loggare né esporre questo dict), o
        # None se il canale non è utilizzabile in questo momento.
        #
        self.channel = None
        self.channel_status = STATUS_NOT_STARTED
        self.channel_detail = ""

        self._subscribed_mesh = None
        self._resolve_task = None
        self._rebind_tasks = set()

        #
        # Hash di canale a 1 byte -> nome, degli ALTRI canali occupati
        # visti dall'ultima scansione degli slot (v. _scan_channels): se
        # un altro canale ha lo stesso byte del nostro, i filtri che
        # confrontano il solo chan_hash (BotModule._on_log_data) non li
        # distinguono. Serve a evitarlo in generazione e a segnalarlo.
        #
        self._other_channel_hashes = {}

        #
        # Ultimo prefisso noto di QUESTO companion, solo per riconoscere
        # in ricezione l'eco dei nostri stessi messaggi (§87.13): mai
        # usato per trasmettere (v. _rx_local_prefix).
        #
        self._last_local_prefix = None

        self._counters = {
            #
            # Imbuto di ricezione (tools/sonar_status.py): eventi
            # RX_LOG_DATA visti -> messaggi di canale (GRP_TXT, di
            # qualunque canale) -> con l'hash del nostro canale -> esito.
            # I contatori successivi sono le uscite dell'imbuto.
            #
            "rx_events": 0,
            "rx_grp_txt": 0,
            "rx_channel_hash": 0,
            "rx_stored": 0,
            "rx_local_echo": 0,
            "rx_local_unknown": 0,
            "rx_ignored_text": 0,
            "rx_no_text": 0,
            "rx_bad_path": 0,
            "rx_unverified": 0,
            "rx_db_errors": 0,
            "rx_errors": 0,
            "tx_sent": 0,
            "tx_failed": 0,
            "tx_unknown": 0,
            "tx_skipped": 0,
        }

        # chiave -> [istante ultimo log, numero soppressi dopo di esso]
        self._log_limits = {}

        if self.settings.rx_ok:
            self.engine.register_rebind(self._on_rebind)

    # ------------------------------------------------------------
    # DIAGNOSTICA
    # ------------------------------------------------------------

    def _count(self, name, amount=1):
        self._counters[name] = self._counters.get(name, 0) + amount

    def _log_limited(self, key, level, message, *args):
        """
        Log con limite di frequenza per chiave (LOG_RATE_LIMIT_SECS).
        I messaggi soppressi tra due log sono contati e riportati in
        coda al log successivo: nulla viene nascosto, solo
        raggruppato.
        """

        now = time.monotonic()
        entry = self._log_limits.get(key)

        if entry is not None and now - entry[0] < LOG_RATE_LIMIT_SECS:
            entry[1] += 1
            return

        suppressed = entry[1] if entry is not None else 0

        self._log_limits[key] = [now, 0]

        if suppressed:
            message += " (+%d analoghi soppressi nell'ultimo intervallo)"
            args = args + (suppressed,)

        getattr(log, level)(message, *args)

    def _set_channel_state(self, status, detail=""):

        changed = (
            status != self.channel_status or detail != self.channel_detail
        )

        self.channel_status = status
        self.channel_detail = detail

        if not changed:
            return

        if status == STATUS_READY:
            log.info("SonarModule: canale pronto — %s", detail)

        elif status in (STATUS_RESOLVING, STATUS_NOT_STARTED):
            log.info("SonarModule: %s %s", status, detail)

        else:
            log.warning("SonarModule: canale non utilizzabile (%s) — %s",
                        status, detail)

    def status(self):
        """
        Stato per il comando IPC 'status' e per i test. Mai il segreto.
        """

        channel = self.channel

        return {
            "settings": self.settings.public_dict(),
            "channel_status": self.channel_status,
            "channel_detail": self.channel_detail,
            "channel_idx": channel["channel_idx"] if channel else None,
            "channel_hash": channel["channel_hash"] if channel else None,
            "hash_collision_with": (
                self._other_channel_hashes.get(channel["channel_hash"])
                if channel else None
            ),
            "subscribed": self._subscribed_mesh is not None,
            "src_prefix": self._local_src_prefix(),
            "counters": dict(self._counters),
        }

    # ------------------------------------------------------------
    # DATABASE
    # ------------------------------------------------------------

    def _open_db_sync(self):
        """
        Apre contacts.db (crea le tabelle sonar se mancano, idempotente
        — v. ContactDB.SCHEMA) e porta a 'unknown' gli invii rimasti
        'pending' da un'esecuzione precedente. Eseguito in un thread
        da _run_db(), una sola volta per processo (quando l'apertura
        riesce).
        """

        db = ContactDB(self.settings.db_path)

        try:
            swept = db.mark_stale_sonar_tx_unknown()

        except Exception:
            db.close()
            raise

        if swept:
            log.warning(
                "SonarModule: %d invio/i sonar risultavano ancora "
                "'pending' (richiesta interrotta da un riavvio o "
                "dall'arresto del daemon): marcati 'unknown'.",
                swept
            )

        return db

    async def _run_db(self, method, *args, **kwargs):
        """
        Esegue un metodo di ContactDB in un thread (v.
        ContactSyncModule._run_db: sqlite3 è bloccante e con
        busy_timeout può attendere secondi). Serializzato da
        _db_lock perché la connessione è condivisa tra i thread
        dell'executor. Apre il database al primo uso (e ritenta ad
        ogni uso finché non ci riesce).
        """

        loop = asyncio.get_event_loop()

        async with self._db_lock:

            if self.db is None:
                self.db = await loop.run_in_executor(
                    None,
                    self._open_db_sync
                )

            return await loop.run_in_executor(
                None,
                functools.partial(getattr(self.db, method), *args, **kwargs)
            )

    # ------------------------------------------------------------
    # AVVIO / RIBIND
    # ------------------------------------------------------------

    async def start(self):
        """
        Avvio in background (chiamato da SonarService, che ne tiene il
        task). Non solleva per errori di configurazione, database o
        device: li registra nello stato e continua/riprova.
        """

        settings = self.settings

        if not settings.rx_ok:

            self._set_channel_state(
                STATUS_CONFIG_ERROR,
                "; ".join(settings.channel_errors)
            )

            log.error(
                "SonarModule: configurazione non valida, servizio "
                "inattivo (nessuna ricezione, nessuna trasmissione): %s",
                "; ".join(settings.channel_errors)
            )

            return

        log.info(
            "SonarModule: avvio (canale=%s, chiave %s, trasmissione "
            "%s, scope=%r, min_interval=%ss).",
            settings.channel_name,
            "configurata" if settings.channel_secret else "non configurata",
            "abilitata" if settings.tx_ok and settings.tx_enabled
            else "disabilitata",
            settings.tx_scope,
            settings.min_interval
        )

        for error in settings.tx_errors:
            log.error("SonarModule: trasmissione disattivata — %s", error)

        #
        # Apre subito il database (e fa la pulizia dei 'pending'
        # residui): un problema qui si vede all'avvio, non al primo
        # messaggio ricevuto. Non fatale: _run_db() ritenterà.
        #
        try:
            await self._run_db("last_sonar_tx")

        except Exception:
            log.exception(
                "SonarModule: apertura/lettura di %s fallita (non "
                "fatale: ogni uso successivo ritenta).",
                settings.db_path
            )

        self._launch_resolve()

    def _on_rebind(self, mesh):
        """
        Callback di Engine.register_rebind(): dopo una riconnessione
        completa self.engine.mesh è una NUOVA istanza, il cui parser
        non conosce il canale (nessun 'chan_name') e che non ha la
        nostra sottoscrizione. Lo stato del canale va quindi
        riguadagnato da zero.
        """

        self.channel = None
        self._subscribed_mesh = None

        self._set_channel_state(STATUS_RESOLVING, "dopo riconnessione")

        log.info("SonarModule: rebinding dopo reconnect.")

        self._launch_resolve()

    def _launch_resolve(self):
        """
        (Ri)avvia il task di risoluzione del canale, sostituendo un
        eventuale task precedente ancora in corso (uno solo alla
        volta: due task concorrenti sarebbero solo lavoro doppio
        serializzato dal command_lock).
        """

        previous = self._resolve_task

        if previous is not None and not previous.done():
            previous.cancel()

        task = asyncio.create_task(self._resolve_loop())

        self._resolve_task = task
        self._rebind_tasks.add(task)
        task.add_done_callback(self._rebind_tasks.discard)

    async def _resolve_loop(self):

        attempt = 0

        while True:

            try:
                await self._resolve_in_background()

            except asyncio.CancelledError:
                raise

            except Exception:
                #
                # Rete di sicurezza: _resolve_channel() non solleva,
                # ma un task in background di cui nessuno attende
                # l'esito non deve mai morire in silenzio.
                #
                log.exception("SonarModule: risoluzione canale fallita.")
                self._set_channel_state(STATUS_ERROR, "eccezione imprevista")

            if self.channel_status not in _TRANSIENT_STATUSES:
                return

            delay = RESOLVE_RETRY_DELAYS[
                min(attempt, len(RESOLVE_RETRY_DELAYS) - 1)
            ]

            attempt += 1

            log.info(
                "SonarModule: nuovo tentativo di risoluzione del canale "
                "tra %ss (stato: %s).",
                delay,
                self.channel_status
            )

            await asyncio.sleep(delay)

    async def _resolve_in_background(self):

        if not self.engine.connected:

            self._set_channel_state(
                STATUS_DEVICE_UNAVAILABLE,
                "connessione al device non attiva"
            )

            return

        #
        # Il lock serializza la scansione/creazione con ogni altro
        # comando (IPC, bot, trace): a differenza del bot, che chiama
        # get_channel() senza lock, qui si può anche SCRIVERE sul
        # device (set_channel).
        #
        async with self.engine.acquire_command_lock("sonar:resolve_channel"):

            await self._resolve_channel(
                create=self.settings.channel_secret is not None,
                generate=False
            )

    # ------------------------------------------------------------
    # CANALE
    # ------------------------------------------------------------

    async def _scan_channels(self, mesh):
        """
        Scorre gli slot del device (get_channel) cercando il canale per
        nome. Ritorna (info, free_idx): info del canale trovato o None,
        primo slot libero visto prima di fermarsi o None. Uno slot è
        LIBERO solo se nome vuoto E segreto tutto a zero: mai si
        considera libero (quindi sovrascrivibile) uno slot con
        qualunque contenuto.

        Un ERROR del firmware chiude la scansione (fine della tabella,
        stessa convenzione di BotModule._resolve_channel); un ERROR
        indeterminato (timeout) la interrompe con _Indeterminate: non
        permette di concludere nulla né sull'esistenza del canale né
        sugli slot liberi.

        Come effetto collaterale aggiorna _other_channel_hashes con gli
        hash a 1 byte degli altri canali occupati visti: COMPLETO se il
        nostro canale non c'è (tutti gli slot scorsi), parziale (solo gli
        slot prima del nostro) se è stato trovato. Su un esito
        indeterminato resta il valore della scansione precedente.

        get_channel() chiama packet_parser.newChannel(): ogni slot
        letto viene registrato nel parser della libreria, ed è ciò che
        permette di ottenere 'chan_name' (validato dal MAC) in
        RX_LOG_DATA per il nostro canale.
        """

        free_idx = None

        others = {}

        for idx in range(MAX_CHANNELS):

            result = await mesh.commands.get_channel(idx)

            if result.type == EventType.ERROR:

                if _is_indeterminate(result.payload):
                    raise _Indeterminate(
                        f"get_channel({idx}): {_short(result.payload)}"
                    )

                break

            info = result.payload

            name = info.get("channel_name")

            if name == self.settings.channel_name:
                self._other_channel_hashes = others
                return info, free_idx

            is_free = (
                name == ""
                and not any(info.get("channel_secret") or b"")
            )

            if is_free:

                if free_idx is None:
                    free_idx = idx

            elif isinstance(info.get("channel_hash"), str):
                others.setdefault(info["channel_hash"], name or f"slot {idx}")

        self._other_channel_hashes = others

        return None, free_idx

    async def _read_channel(self, mesh, idx):
        """get_channel(idx) -> info oppure None (ERROR firmware);
        _Indeterminate se timeout/trasporto."""

        result = await mesh.commands.get_channel(idx)

        if result.type == EventType.ERROR:

            if _is_indeterminate(result.payload):
                raise _Indeterminate(
                    f"get_channel({idx}): {_short(result.payload)}"
                )

            return None

        return result.payload

    async def _resolve_channel(self, create=False, generate=False):
        """
        Trova (e, se richiesto, crea) il canale e sottoscrive la
        ricezione. DA CHIAMARE CON command_lock GIÀ TENUTO. Non solleva
        (salvo CancelledError): ogni esito è in self.channel_status/
        channel_detail e nel valore di ritorno.

        create   crea il canale se manca, ma SOLO con un segreto da
                 usare (quello configurato; senza segreto configurato
                 serve generate=True) — mai si crea un canale con una
                 chiave a caso senza che sia stato chiesto.
        generate se manca e non c'è un segreto configurato, ne genera
                 uno casuale (secrets, 16 byte).

        Ritorna un dict:
            {"status": ..., "detail": ..., "created": bool}
        """

        settings = self.settings

        created = False

        if not settings.rx_ok:

            self._set_channel_state(
                STATUS_CONFIG_ERROR,
                "; ".join(settings.channel_errors)
            )

            return self._resolution(created)

        if not self.engine.connected:

            self._set_channel_state(
                STATUS_DEVICE_UNAVAILABLE,
                "connessione al device non attiva"
            )

            return self._resolution(created)

        mesh = self.engine.mesh

        try:

            info, free_idx = await self._scan_channels(mesh)

            if info is not None:
                self._adopt_or_conflict(mesh, info)
                return self._resolution(created)

            secret = settings.channel_secret

            if secret is None and generate:
                secret = self._generate_secret()

            if not create or secret is None:

                self._set_channel_state(
                    STATUS_MISSING,
                    f"il canale '{settings.channel_name}' non esiste sul "
                    f"device"
                    + (
                        "" if secret is not None else
                        ": configurare sonar.channel_secret (o usare "
                        "tools/sonar_channel.py --create) per crearlo"
                    )
                )

                return self._resolution(created)

            if free_idx is None:

                self._set_channel_state(
                    STATUS_NO_FREE_SLOT,
                    f"il canale '{settings.channel_name}' non esiste e "
                    f"il device non ha slot di canale liberi: liberarne "
                    f"uno (nessun canale esistente viene sovrascritto)"
                )

                return self._resolution(created)

            created = await self._create_channel(mesh, free_idx, secret)

        except _Indeterminate as exc:

            self.engine.report_possible_failure()

            self._set_channel_state(STATUS_ERROR, str(exc))

        except asyncio.CancelledError:
            raise

        except Exception:

            log.exception("SonarModule: risoluzione del canale fallita.")

            self.engine.report_possible_failure()

            self._set_channel_state(STATUS_ERROR, "eccezione imprevista")

        return self._resolution(created)

    def _generate_secret(self):
        """
        Segreto casuale di 16 byte il cui hash di canale a 1 byte NON
        coincide con quello di un altro canale occupato del device (in
        particolare #bot): il filtro del bot confronta solo quel byte
        e un'omonimia farebbe passare i pacchetti del sonar nel suo
        pre-filtro (v. ARCHITECTURE.md §87.8). Vale solo per i segreti
        GENERATI qui; uno configurato dall'utente non si cambia mai (si
        segnala soltanto, _warn_hash_collision).
        """

        candidate = secrets.token_bytes(CHANNEL_SECRET_BYTES)

        for _ in range(_MAX_SECRET_ATTEMPTS - 1):

            if _channel_hash(candidate) not in self._other_channel_hashes:
                break

            candidate = secrets.token_bytes(CHANNEL_SECRET_BYTES)

        return candidate

    def _warn_hash_collision(self, channel_hash):
        """
        Avvisa (senza bloccare nulla) se il canale sonar ha lo stesso
        hash a 1 byte di un altro canale del device: i filtri che
        confrontano il solo chan_hash — il BotModule — non li
        distinguono. Il sonar stesso non ne risente (verifica il MAC).
        """

        other = self._other_channel_hashes.get(channel_hash)

        if other is None or other == self.settings.channel_name:
            return

        self._log_limited(
            "hash_collision", "warning",
            "SonarModule: l'hash a 1 byte del canale '%s' (%s) coincide "
            "con quello del canale '%s': il filtro del bot (che confronta "
            "solo quel byte) può accodare i pacchetti del sonar. Nessun "
            "dato viene perso né il bot smette di funzionare; per evitarlo "
            "usare un'altra chiave (tools/sonar_channel.py genera sempre "
            "una chiave senza questa omonimia).",
            self.settings.channel_name,
            channel_hash,
            other
        )

    def _resolution(self, created):

        #
        # Il canale resta valorizzato solo se pronto, o se l'esito è
        # transitorio (device che non risponde: quello che sapevamo
        # prima non è smentito, e la ricezione già attiva non va
        # interrotta per un timeout). Ogni esito DEFINITIVO di
        # "non utilizzabile" lo azzera: senza canale la ricezione non
        # registra nulla e send() non trasmette.
        #
        if self.channel_status not in (
            STATUS_READY, STATUS_DEVICE_UNAVAILABLE, STATUS_ERROR
        ):
            self.channel = None

        return {
            "status": self.channel_status,
            "detail": self.channel_detail,
            "created": created,
        }

    def _adopt_or_conflict(self, mesh, info):
        """
        Il canale esiste già col nostro nome: lo si adotta SOLO se il
        segreto coincide con quello configurato, oppure se nessun
        segreto è configurato (il device è la fonte). In caso di
        conflitto non si modifica nulla sul device.
        """

        configured = self.settings.channel_secret

        if configured is not None and info.get("channel_secret") != configured:

            self._set_channel_state(
                STATUS_CONFLICT,
                f"il canale '{self.settings.channel_name}' esiste già sul "
                f"device (slot {info.get('channel_idx')}) con una chiave "
                f"DIVERSA da sonar.channel_secret: non viene modificato"
            )

            return

        self.channel = info

        self._subscribe(mesh)

        self._set_channel_state(
            STATUS_READY,
            f"'{info.get('channel_name')}' slot {info.get('channel_idx')} "
            f"(hash {info.get('channel_hash')})"
        )

        self._warn_hash_collision(info.get("channel_hash"))

    async def _create_channel(self, mesh, idx, secret):
        """
        set_channel() in uno slot libero + rilettura di verifica
        (get_channel registra anche il canale nel parser). Ritorna True
        se il canale è stato creato e adottato; altrimenti imposta lo
        stato (create_failed definitivo, o errore transitorio) e
        ritorna False.
        """

        name = self.settings.channel_name

        result = await mesh.commands.set_channel(idx, name, secret)

        if result.type == EventType.ERROR:

            self.engine.report_possible_failure()

            if _is_indeterminate(result.payload):
                raise _Indeterminate(
                    f"set_channel({idx}): {_short(result.payload)}"
                )

            self._set_channel_state(
                STATUS_CREATE_FAILED,
                f"il device ha rifiutato la creazione del canale nello "
                f"slot {idx}: {_short(result.payload)}"
            )

            return False

        info = await self._read_channel(mesh, idx)

        if (
            info is None
            or info.get("channel_name") != name
            or info.get("channel_secret") != secret
        ):

            self._set_channel_state(
                STATUS_CREATE_FAILED,
                f"verifica dopo la creazione nello slot {idx} fallita: "
                f"il device non riporta il canale atteso"
            )

            return False

        log.info(
            "SonarModule: canale '%s' creato nello slot %d (chiave %s).",
            name,
            idx,
            "da configurazione" if self.settings.channel_secret == secret
            else "generata"
        )

        self.channel = info

        self._subscribe(mesh)

        self._set_channel_state(
            STATUS_READY,
            f"'{name}' slot {idx} (hash {info.get('channel_hash')}) "
            f"— creato"
        )

        self._warn_hash_collision(info.get("channel_hash"))

        return True

    def _subscribe(self, mesh):
        """
        Sottoscrive RX_LOG_DATA sull'istanza mesh corrente (una sola
        volta per istanza) e abilita la decifratura dei messaggi di
        canale nei log (stessa chiamata del bot: impostazione globale
        del parser, idempotente).
        """

        if self._subscribed_mesh is mesh:
            return

        mesh.set_decrypt_channel_logs(True)

        mesh.subscribe(EventType.RX_LOG_DATA, self._on_log_data)

        self._subscribed_mesh = mesh

    # ------------------------------------------------------------
    # RICEZIONE
    # ------------------------------------------------------------

    def _local_src_prefix(self):
        """
        Prefisso (8 esadecimali) della chiave pubblica di QUESTO
        companion, da mesh.self_info — stessa sorgente usata altrove
        nel progetto — oppure None se non disponibile.
        """

        mesh = getattr(self.engine, "mesh", None)

        info = getattr(mesh, "self_info", None)

        if not isinstance(info, dict):
            return None

        return src_prefix_from_public_key(info.get("public_key"))

    def _rx_local_prefix(self):
        """
        Prefisso di QUESTO companion per riconoscere, in ricezione,
        l'eco dei nostri stessi messaggi (docs/ARCHITECTURE.md §87.13):
        il valore vivo di self_info; se manca (per esempio per qualche
        istante durante una riconnessione) l'ultimo noto; None solo se
        non è mai stato noto dall'avvio.

        Serve SOLO alla ricezione. La trasmissione usa sempre
        _local_src_prefix() (valore vivo, o errore no_self_info): un
        messaggio non deve mai partire con un mittente memorizzato.
        """

        prefix = self._local_src_prefix()

        if prefix is not None:
            self._last_local_prefix = prefix
            return prefix

        return self._last_local_prefix

    async def _on_log_data(self, event):
        """
        Handler di RX_LOG_DATA. Non solleva MAI: un errore qui non deve
        propagarsi al dispatcher della libreria, che serve anche gli
        handler di bot e contact_sync sullo stesso evento.
        """

        try:
            await self._handle_log_data(event)

        except asyncio.CancelledError:
            raise

        except Exception:

            self._count("rx_errors")

            self._log_limited(
                "rx_exception", "exception",
                "SonarModule: errore imprevisto in ricezione."
            )

    async def _handle_log_data(self, event):

        channel = self.channel

        if channel is None:
            return

        payload = event.payload

        if not isinstance(payload, dict):
            return

        #
        # Ogni pacchetto che il companion sente (non solo il nostro
        # canale) arriva qui: il contatore dice se il ricevitore è vivo.
        #
        self._count("rx_events")

        if payload.get("payload_typename") != "GRP_TXT":
            return

        #
        # Messaggio di canale di QUALUNQUE canale (Public, #bot, il
        # nostro...): distingue «non sento nessun messaggio di canale»
        # da «ne sento, ma non del nostro canale».
        #
        self._count("rx_grp_txt")

        if payload.get("chan_hash") != channel.get("channel_hash"):
            return

        self._count("rx_channel_hash")

        #
        # 'chan_name' è valorizzato dalla libreria solo se il MAC del
        # pacchetto torna col segreto di un canale che conosce: è la
        # verifica di appartenenza al canale. Hash uguale ma nome
        # assente = MAC non valido (altro canale con lo stesso hash di
        # 1 byte, pacchetto corrotto/forgiato) oppure canale non
        # ancora noto al parser: non è nostro, ma si conta per poter
        # diagnosticare un parser "cieco".
        #
        if payload.get("chan_name") != channel.get("channel_name"):
            self._count("rx_unverified")
            return

        message = payload.get("message")

        if not isinstance(message, str):
            self._count("rx_no_text")
            self._log_limited(
                "rx_no_text", "warning",
                "SonarModule: pacchetto del canale verificato ma senza "
                "testo decifrato (decifratura dei log non attiva?)."
            )
            return

        sonar = parse_channel_text(message)

        if sonar is None:
            #
            # Testo qualunque di un utente del canale, o versione del
            # formato diversa: normale su un canale condiviso, non
            # un errore. Contato, non loggato.
            #
            self._count("rx_ignored_text")
            return

        local_prefix = self._rx_local_prefix()

        if local_prefix is not None and sonar.src_prefix == local_prefix:
            #
            # Eco del NOSTRO stesso messaggio, rilanciato da un repeater:
            # non è una ricezione da un altro nodo e NON si registra in
            # sonar_rx (§87.13, richiesta dell'utente dopo la prova su
            # hardware). Solo contatore e log, perché si veda che il
            # messaggio è uscito ed è stato ripetuto. Il controllo
            # precede quello del path: un'eco con path incoerente è
            # comunque un'eco, non un dato scartato per il path.
            #
            self._count("rx_local_echo")

            echo_row = self._extract_path(payload)

            log.info(
                "SonarModule: eco del proprio messaggio, NON registrato "
                "src=%s seq=%d scope=%s hop=%s path=%s",
                sonar.src_prefix,
                sonar.seq,
                sonar.scope_tag,
                echo_row[1] if echo_row is not None
                else "?",
                (echo_row[0] or "(diretto)") if echo_row is not None
                else "(path incoerente)"
            )

            return

        row = self._extract_path(payload)

        if row is None:

            self._count("rx_bad_path")

            self._log_limited(
                "rx_bad_path", "warning",
                "SonarModule: messaggio sonar scartato, struttura del "
                "path incoerente (src=%s seq=%d path_len=%r "
                "path_hash_size=%r path=%r).",
                sonar.src_prefix,
                sonar.seq,
                payload.get("path_len"),
                payload.get("path_hash_size"),
                str(payload.get("path"))[:64]
            )

            return

        path_hex, hop_count, hash_size = row

        if local_prefix is None:
            #
            # Chiave pubblica del companion mai nota dall'avvio: non si
            # può dire se sia un'eco. La ricezione NON si perde (una
            # ricezione scartata non si recupera, una riga con
            # is_local NULL si può ripulire dopo, per src_prefix) ma si
            # conta e si avvisa.
            #
            self._count("rx_local_unknown")

            self._log_limited(
                "rx_local_unknown", "warning",
                "SonarModule: chiave pubblica del companion non ancora "
                "nota: non posso riconoscere l'eco dei miei messaggi "
                "(registro con is_local NULL)."
            )

        recv_time = payload.get("recv_time")

        sender_timestamp = payload.get("sender_timestamp")
        msg_hash = payload.get("msg_hash")
        pkt_hash = payload.get("pkt_hash")

        transport_code = payload.get("transport_code")
        route_type = payload.get("route_typename")

        try:

            await self._run_db(
                "insert_sonar_rx",
                observed_at=(
                    recv_time if _is_int(recv_time) else int(time.time())
                ),
                src_prefix=sonar.src_prefix,
                seq=sonar.seq,
                scope_tag=sonar.scope_tag,
                channel=channel["channel_name"],
                sender_timestamp=(
                    sender_timestamp if _is_int(sender_timestamp) else None
                ),
                msg_hash=msg_hash if _is_int(msg_hash) else None,
                pkt_hash=pkt_hash if _is_int(pkt_hash) else None,
                route_type=route_type if isinstance(route_type, str) else None,
                transport_code=(
                    transport_code if isinstance(transport_code, str)
                    else None
                ),
                path_hex=path_hex,
                hop_count=hop_count,
                hash_size=hash_size,
                rssi=_num_or_none(payload.get("rssi")),
                snr=_num_or_none(payload.get("snr")),
                #
                # Qui il mittente non è mai questo companion (le eco
                # sono uscite sopra): 0 = determinato, NULL = prefisso
                # locale mai noto.
                #
                is_local=None if local_prefix is None else False
            )

        except Exception:

            self._count("rx_db_errors")

            self._log_limited(
                "rx_db", "exception",
                "SonarModule: scrittura sonar_rx fallita (src=%s seq=%d): "
                "la ricezione è PERSA.",
                sonar.src_prefix,
                sonar.seq
            )

            return

        self._count("rx_stored")

        log.info(
            "SonarModule: ricevuto src=%s seq=%d scope=%s hop=%d path=%s",
            sonar.src_prefix,
            sonar.seq,
            sonar.scope_tag,
            hop_count,
            path_hex or "(diretto)"
        )

    @staticmethod
    def _extract_path(payload):
        """
        Path ESATTAMENTE come lo espone la libreria: 'path' (hex, ordine
        sorgente -> gateway), 'path_len' (hop) e 'path_hash_size'
        (byte per hop). Nessuna ricostruzione: i valori vengono solo
        controllati. Ritorna (path_hex, hop_count, hash_size) oppure
        None se la struttura è incoerente (testo non esadecimale o di
        lunghezza dispari, hop fuori intervallo, lunghezza che non
        torna con hop * dimensione hash).
        """

        path_hex = payload.get("path")

        if path_hex is None:
            path_hex = ""

        if (
            not isinstance(path_hex, str)
            or not _HEX_RE.match(path_hex)
            or len(path_hex) % 2
        ):
            return None

        hop_count = payload.get("path_len")

        if hop_count is None:
            hop_count = 0

        if not _is_int(hop_count) or not 0 <= hop_count <= _MAX_PATH_HOPS:
            return None

        hash_size = payload.get("path_hash_size")

        if hash_size is not None:

            #
            # _is_int() PRIMA dell'appartenenza: True == 1, quindi
            # 'True in (1, 2, 3, 4)' sarebbe vero.
            #
            if not _is_int(hash_size) or hash_size not in _VALID_HASH_SIZES:
                return None

            if len(path_hex) != hop_count * hash_size * 2:
                return None

        else:

            #
            # Dimensione dell'hash non esposta: si controlla solo
            # quanto è comunque certo (nessun hop <=> nessun path, e
            # path suddivisibile in hop di pari lunghezza).
            #
            if (hop_count == 0) != (path_hex == ""):
                return None

            if hop_count and len(path_hex) % (hop_count * 2):
                return None

        return path_hex, hop_count, hash_size

    # ------------------------------------------------------------
    # TRASMISSIONE
    # ------------------------------------------------------------

    @staticmethod
    def _fail(code, message, **extra):
        result = {"ok": False, "code": code, "message": message}
        result.update(extra)
        return result

    async def _verify_channel(self, mesh):
        """
        Prima di trasmettere: lo slot memorizzato contiene ancora il
        nostro canale (stesso nome e stesso segreto)? Se l'utente lo
        avesse riassegnato dall'app a un altro canale, send_chan_msg()
        scriverebbe il messaggio sonar su QUEL canale. Un'unica
        get_channel(), a costo trascurabile. True/False; False anche
        per esito indeterminato (si ricade nella risoluzione completa,
        che imposta lo stato giusto).
        """

        channel = self.channel

        if channel is None:
            return False

        try:
            info = await self._read_channel(mesh, channel["channel_idx"])

        except _Indeterminate:
            return False

        return (
            info is not None
            and info.get("channel_name") == channel.get("channel_name")
            and info.get("channel_secret") == channel.get("channel_secret")
        )

    async def send(self, scope=None):
        """
        Trasmette UN messaggio sonar sul canale. Invocata dall'IPC:
        command_lock è già tenuto dal chiamante, quindi due richieste
        sovrapposte sono serializzate e la seconda vede la prima in
        sonar_tx (guardia min_interval compresa).

        Sequenza (ogni passo che fallisce lascia la riga di sonar_tx in
        uno stato finale e spiegato, mai 'pending'):
          1. configurazione/connessione/canale verificati;
          2. guardia min_interval (persistente);
          3. progressivo RISERVATO in sonar_tx (prima di inviare);
          4. set_flood_scope() esplicito — se fallisce NON si invia;
          5. send_chan_msg();
          6. ripristino dello scope di default del device;
          7. esito registrato (sent / failed / unknown).

        Ritorna un dict {"ok": True, ...} oppure {"ok": False, "code",
        "message", ...} — mai un'eccezione (salvo CancelledError, dopo
        aver registrato l'esito come 'unknown').
        """

        settings = self.settings

        if not settings.rx_ok:
            return self._fail("config", "; ".join(settings.channel_errors))

        if settings.tx_errors:
            return self._fail("config", "; ".join(settings.tx_errors))

        if not settings.tx_enabled:
            return self._fail(
                "tx_disabled",
                "trasmissione disabilitata (sonar.tx.enabled=false)"
            )

        try:
            scope_cmd, scope_tag = normalize_scope(
                settings.tx_scope if scope is None else scope
            )

        except ValueError as exc:
            return self._fail("bad_scope", str(exc))

        if not self.engine.connected:
            return self._fail(
                "device_unavailable", "connessione al device non attiva"
            )

        mesh = self.engine.mesh

        channel_ok = False

        if self.channel is not None:
            channel_ok = await self._verify_channel(mesh)

        if not channel_ok:

            resolution = await self._resolve_channel(
                create=settings.channel_secret is not None,
                generate=False
            )

            #
            # Si trasmette solo con il canale VERIFICATO in questa
            # chiamata: un esito transitorio della risoluzione
            # (timeout) può lasciare self.channel valorizzato per la
            # ricezione, ma non basta a escludere che lo slot sia
            # stato riassegnato.
            #
            if resolution["status"] != STATUS_READY or self.channel is None:
                return self._fail(
                    "channel_unavailable",
                    f"canale '{settings.channel_name}' non utilizzabile "
                    f"({self.channel_status}): {self.channel_detail}"
                )

        prefix = self._local_src_prefix()

        if prefix is None:
            return self._fail(
                "no_self_info",
                "chiave pubblica del companion non disponibile "
                "(self_info assente)"
            )

        channel_idx = self.channel["channel_idx"]

        now = int(time.time())

        try:

            last = await self._run_db("last_sonar_tx_attempt_at")

        except Exception:

            log.exception("SonarModule: lettura di sonar_tx fallita.")

            return self._fail(
                "db_error", "database non accessibile: nessun invio"
            )

        #
        # Guardia persistente tra invii. Un orologio andato INDIETRO
        # (elapsed negativo) non blocca: altrimenti un salto dell'ora
        # (NTP) fermerebbe la trasmissione per tutta la differenza.
        #
        if last is not None and settings.min_interval > 0:

            elapsed = now - last

            if 0 <= elapsed < settings.min_interval:

                self._count("tx_skipped")

                return self._fail(
                    "too_soon",
                    f"ultimo invio {elapsed}s fa, intervallo minimo "
                    f"{settings.min_interval}s",
                    retry_after=settings.min_interval - elapsed
                )

        try:

            seq = await self._run_db(
                "reserve_sonar_tx",
                now, prefix, settings.channel_name, scope_tag
            )

        except Exception:

            log.exception(
                "SonarModule: riserva del progressivo fallita: nessun "
                "invio (mai un messaggio senza numero persistito)."
            )

            return self._fail(
                "db_error", "database non scrivibile: nessun invio"
            )

        return await self._send_reserved(
            mesh, seq, prefix, channel_idx, scope_cmd, scope_tag
        )

    async def _send_reserved(
        self, mesh, seq, prefix, channel_idx, scope_cmd, scope_tag
    ):
        """
        Parte della trasmissione DOPO la riserva del progressivo: da
        qui ogni uscita (anche per CancelledError) registra l'esito
        della riga 'seq'.
        """

        status = None          # 'sent' | 'failed' | 'unknown'
        error = None
        sent_at = None
        msg_timestamp = None
        text = None
        scope_dirty = False
        scope_restored = True
        result = None

        try:

            text = build_message(prefix, seq, scope_tag)

            #
            # Scope SEMPRE esplicito prima di inviare; se non si riesce
            # a impostarlo non si invia (v. docstring del modulo).
            #
            try:
                event = await mesh.commands.set_flood_scope(scope_cmd)

            except Exception as exc:

                log.exception(
                    "SonarModule: set_flood_scope(%r) fallita: nessun "
                    "invio.", scope_cmd
                )

                self.engine.report_possible_failure()

                scope_dirty = True

                status, error = "failed", (
                    f"set_flood_scope: {type(exc).__name__}"
                )

            else:

                if event.type == EventType.ERROR:

                    log.warning(
                        "SonarModule: set_flood_scope(%r) fallita (%s): "
                        "nessun invio.", scope_cmd, _short(event.payload)
                    )

                    self.engine.report_possible_failure()

                    #
                    # Un rifiuto esplicito del firmware non ha cambiato
                    # lo stato; un esito indeterminato sì, forse.
                    #
                    scope_dirty = _is_indeterminate(event.payload)

                    status, error = "failed", (
                        f"set_flood_scope: {_short(event.payload)}"
                    )

                else:
                    scope_dirty = scope_cmd != SCOPE_CMD_DEFAULT

            if status is None:

                msg_timestamp = int(time.time())

                try:
                    event = await mesh.commands.send_chan_msg(
                        channel_idx, text, msg_timestamp
                    )

                except Exception as exc:

                    log.exception("SonarModule: send_chan_msg() fallita.")

                    self.engine.report_possible_failure()

                    status, error = "unknown", (
                        f"send_chan_msg: {type(exc).__name__}"
                    )

                else:

                    if event.type == EventType.ERROR:

                        log.warning(
                            "SonarModule: invio sonar fallito: %s",
                            _short(event.payload)
                        )

                        self.engine.report_possible_failure()

                        if _is_indeterminate(event.payload):
                            status, error = "unknown", (
                                f"send_chan_msg: {_short(event.payload)}"
                            )

                        else:
                            status, error = "failed", (
                                f"send_chan_msg: {_short(event.payload)}"
                            )

                    else:
                        status, sent_at = "sent", int(time.time())

        except asyncio.CancelledError:

            if status is None:
                status, error = "unknown", "richiesta interrotta"

            raise

        except Exception as exc:

            log.exception("SonarModule: errore imprevisto in send().")

            if status is None:
                status, error = "unknown", (
                    f"errore imprevisto: {type(exc).__name__}"
                )

        finally:

            if scope_dirty:
                scope_restored = await self._restore_scope(mesh)

            if status is None:
                status, error = "unknown", "interrotto prima dell'esito"

            await self._finish_tx(
                seq, status, sent_at, msg_timestamp, error
            )

            #
            # Nel finally (non dopo): anche una richiesta cancellata
            # lascia una riga 'unknown' in sonar_tx, e il contatore
            # deve restare coerente con la tabella.
            #
            self._count({
                "sent": "tx_sent", "failed": "tx_failed"
            }.get(status, "tx_unknown"))

        if status == "sent":

            log.info(
                "SonarModule: inviato seq=%d scope=%s canale idx=%d "
                "(conferma locale del companion, non della rete).",
                seq, scope_tag, channel_idx
            )

            result = {
                "ok": True,
                "seq": seq,
                "scope_tag": scope_tag,
                "text": text,
                "channel": self.settings.channel_name,
                "channel_idx": channel_idx,
                "msg_timestamp": msg_timestamp,
                "scope_restored": scope_restored,
            }

        else:

            result = self._fail(
                "tx_failed" if status == "failed" else "tx_unknown",
                error or status,
                seq=seq,
                tx_status=status,
                scope_restored=scope_restored
            )

        return result

    async def _restore_scope(self, mesh):
        """
        Riporta lo scope di invio al default del device
        (set_flood_scope("")) dopo una trasmissione sonar, così
        nessun altro invio (floodadv, che non imposta alcuno scope)
        eredita lo scope del sonar. Ritorna False se non riuscito: in
        quel caso lo scope del sonar resta attivo sul device fino al
        prossimo set_flood_scope() (log WARNING esplicito).
        """

        try:
            event = await mesh.commands.set_flood_scope(SCOPE_CMD_DEFAULT)

        except asyncio.CancelledError:
            raise

        except Exception:

            log.exception(
                "SonarModule: ripristino dello scope di default fallito: "
                "lo scope del sonar resta attivo sul device."
            )

            self.engine.report_possible_failure()

            return False

        if event.type == EventType.ERROR:

            log.warning(
                "SonarModule: ripristino dello scope di default fallito "
                "(%s): lo scope del sonar resta attivo sul device.",
                _short(event.payload)
            )

            self.engine.report_possible_failure()

            return False

        return True

    async def _finish_tx(self, seq, status, sent_at, msg_timestamp, error):
        """
        Registra l'esito. Un errore di scrittura lascia la riga
        'pending': verrà portata a 'unknown' al prossimo avvio (v.
        _open_db_sync) — l'esito non va mai perso del tutto, ma non
        deve nemmeno far fallire la risposta di un invio già fatto.
        """

        try:

            await self._run_db(
                "finish_sonar_tx",
                seq, status,
                sent_at=sent_at,
                msg_timestamp=msg_timestamp,
                error=error
            )

        except asyncio.CancelledError:
            raise

        except Exception:

            log.exception(
                "SonarModule: registrazione dell'esito di seq=%d (%s) "
                "fallita: la riga resta 'pending' fino al prossimo "
                "avvio.",
                seq, status
            )

    # ------------------------------------------------------------
    # COMANDI (via IPC)
    # ------------------------------------------------------------

    async def ensure_channel(self, create=False, reveal_secret=False):
        """
        Verifica (e, con create=True, crea) il canale sul device.
        Invocata dall'IPC (command_lock già tenuto).

        create=False: cerca il canale per nome e lo adotta se c'è;
        non scrive nulla sul device.
        create=True: se manca lo crea in uno slot libero col segreto
        configurato o, se non ce n'è uno, con un segreto GENERATO.

        reveal_secret=True include nella risposta il segreto (hex) del
        canale pronto, per propagarlo agli altri nodi tramite
        sonar.channel_secret: è l'unico punto in cui il segreto esce
        dal modulo, solo su richiesta esplicita.
        """

        settings = self.settings

        if not settings.rx_ok:
            return self._fail("config", "; ".join(settings.channel_errors))

        if not self.engine.connected:
            return self._fail(
                "device_unavailable", "connessione al device non attiva"
            )

        resolution = await self._resolve_channel(
            create=bool(create),
            generate=bool(create)
        )

        if resolution["status"] != STATUS_READY or self.channel is None:
            return self._fail(
                resolution["status"], resolution["detail"]
            )

        result = {
            "ok": True,
            "channel_status": resolution["status"],
            "detail": resolution["detail"],
            "created": resolution["created"],
            "channel_name": self.channel["channel_name"],
            "channel_idx": self.channel["channel_idx"],
            "channel_hash": self.channel["channel_hash"],
        }

        if reveal_secret:
            result["channel_secret"] = self.channel["channel_secret"].hex()

        return result


class _Indeterminate(Exception):
    """
    Il device non ha risposto (timeout/trasporto) a un comando di
    scansione o creazione del canale: nessuna conclusione possibile.
    Interna a questo modulo; _resolve_channel() la converte in stato
    STATUS_ERROR (transitorio, ritentato dal loop di risoluzione).
    """
