import asyncio
import time

from meshcore.events import EventType

from core.config import config
from core.logger import log
from mesh_modules.bot.region_resolver import resolve_region
from mesh_modules.bot.commands.context import CommandContext
from mesh_modules.bot.commands.registry import COMMANDS


#
# out_path_len usato dal firmware per indicare "path non ancora
# noto, instradamento in flood" sul contatto. A livello di frame
# seriale è sempre un byte 0..255 (0xFF = sconosciuto, v.
# docs/FIRMWARE_ANALYSIS.md §4, ContactInfo.h) — ma nei dati reali
# compare anche il valore -1: bug confermato lato meshcore_py (byte
# letto come signed in un punto della catena di parsing lato
# libreria, non un comportamento del firmware — v. FIRMWARE_ANALYSIS.md
# §4), non un caso raro isolato.
#
# Finding 3, code review 2026-08-20 (review indipendente successiva a
# Rev.6) — segnalato in docs/CONTACT_MANAGEMENT.md §6 come bug ancora
# APERTO ("Va corretto ad accettare anche -1"), MAI una scelta di
# design di non gestirlo qui: verificato con un audit esplicito
# dell'intera documentazione del progetto (ARCHITECTURE.md,
# CONTACT_MANAGEMENT.md, FIRMWARE_ANALYSIS.md, tutte le
# REVIEW_FULL_EXTENSIVE_2026-08-20*.md, notes/findings.md) — nessuna
# decisione contraria trovata da nessuna parte. Il progetto usa già
# questo stesso pattern altrove (tools/test_contact.py,
# tools/test_contact_list.py: `UNKNOWN_OUT_PATH_VALUES = (255, -1)`,
# esplicitamente riconosciuto come "il pattern difensivo osservato
# sistematicamente nel progetto" in REVIEW_FULL_EXTENSIVE_2026-08-20_
# Rev6.md — una deviazione da esso è lì classificata come difetto, non
# come stile alternativo deliberato) — bot.py era rimasto l'unico
# punto del progetto che interpreta out_path_len ancora indietro
# rispetto a quel pattern, dalla sua introduzione originale
# (ARCHITECTURE.md §21, 2026-08-06), precedente alla scoperta del
# caso -1 (CONTACT_MANAGEMENT.md §6, 2026-08-07/08) e mai più
# rivisitato da allora.
#
OUT_PATH_UNKNOWN = 255
UNKNOWN_OUT_PATH_VALUES = (OUT_PATH_UNKNOWN, -1)

#
# Vita massima delle cache di correlazione/dedup, in secondi.
#
# CORRELATION_TTL: a differenza delle DM (che hanno un pubkey_prefix
# per correlare in modo univoco RX_LOG_DATA/CHANNEL_MSG_RECV allo
# stesso mittente), un messaggio di canale non porta alcun
# identificativo di mittente a livello di protocollo — né
# PACKET_LOG_DATA né PACKET_CHANNEL_MSG_RECV ne espongono uno (il
# "nome" che si vede nei log è testo libero dentro il messaggio
# stesso, non un campo verificabile). L'unica correlazione possibile
# resta quindi (canale, sender_timestamp) — vedi
# _pending_scope_info/_resolve_scope_for_message più sotto, che ora
# rileva esplicitamente il caso ambiguo invece di sceglierne uno alla
# cieca. Restringere la finestra qui riduce la probabilità che due
# mittenti diversi collidano sullo stesso sender_timestamp (risoluzione
# di un secondo): 3s è ampiamente sufficiente rispetto al tetto massimo
# di CHANNEL_SCOPE_CORRELATION_TIMEOUT (0.3s, sotto) più il margine
# osservato empiricamente per RX_LOG_DATA "a ridosso" di
# CHANNEL_MSG_RECV.
#
CORRELATION_TTL = 3
DM_DEDUP_TTL = 60

#
# Tetto massimo di attesa per la correlazione RX_LOG_DATA ->
# CHANNEL_MSG_RECV in _on_channel_message() (Finding 4, review
# affidabilità 2026-08-21 — v. ARCHITECTURE.md §50). Fino a questo fix
# era un'attesa CIECA e fissa (asyncio.sleep(0.3)) prima di ogni
# risoluzione di scope, pagata da OGNI messaggio di canale — anche
# quando l'informazione era già disponibile o arrivava quasi subito.
# Ora è solo il tetto massimo di un'attesa basata su evento
# (asyncio.Event per sender_timestamp, segnalato da _on_log_data()):
# si procede SUBITO appena l'informazione arriva (o è già presente),
# questo valore scatta solo se non arriva affatto entro la finestra.
# Stesso valore numerico di prima (0.3s), deliberatamente, per non
# cambiare il caso peggiore già osservato empiricamente — cambia solo
# il caso comune, ora molto più reattivo. V. ARCHITECTURE.md §50 anche
# per il compromesso esplicito sulla rilevazione di ambiguità
# (candidati multipli collidenti sullo stesso sender_timestamp, v.
# _resolve_scope_for_message più sotto) che questo cambio comporta.
#
CHANNEL_SCOPE_CORRELATION_TIMEOUT = 0.3

#
# Lunghezza massima di sender_name prima di costruire il prefisso
# "@[...] " (code review 2026-08-20, §3.3) — sender_name è testo
# completamente controllato da chi scrive sul canale (parte prima di
# ": " nel testo del messaggio) o dal nome annunciato via ADVERT per
# le DM, senza alcun limite imposto dal protocollo (fino a ~100
# caratteri, limitato solo dal budget del pacchetto in ingresso).
# Senza un limite qui, un mittente può consumare gran parte del
# budget di risposta disponibile con un nome lungo, lasciando ai
# comandi pochissimo spazio — di fatto un "megafono" per un proprio
# testo che fa sparire il contenuto reale del comando. 32 caratteri
# sono ampiamente sufficienti per un nome leggibile e lasciano
# comunque margine al contenuto della risposta anche con
# max_reply_length ridotto.
#
MAX_SENDER_NAME_LEN = 32


def _tag(sender_timestamp):
    """
    Tag breve e leggibile per correlare le righe di log dello stesso
    comando (ricezione, dedup, esito invio) anche quando più comandi
    sono in lavorazione in parallelo — non serializzati in ricezione,
    solo l'invio lo è. Ultimi 4 caratteri di sender_timestamp: non
    identifica univocamente in astratto, ma è più che sufficiente in
    pratica su una finestra temporale ristretta.
    """

    s = str(sender_timestamp) if sender_timestamp is not None else "????"

    return f"[ts:{s[-4:]}]"


#
# Ellissi usata per segnalare un troncamento — un solo codepoint, ma
# 3 byte in UTF-8 (U+2026, non un "..." ASCII a 3 caratteri separati).
# Il costo in byte va riservato esplicitamente nel budget disponibile,
# mai assunto pari a 1 byte.
#
TRUNCATION_SUFFIX = "…"
TRUNCATION_SUFFIX_BYTES = len(TRUNCATION_SUFFIX.encode("utf-8"))


def _truncate_utf8_safe(text, max_bytes):
    """
    Tronca `text` in modo che la sua codifica UTF-8 non superi mai
    `max_bytes` — anche includendo l'ellissi di troncamento, quando
    serve aggiungerla.

    Punto unico condiviso tra risposte su canale e DM: un fix o una
    modifica del margine di sicurezza si applica così a entrambi i
    percorsi (in precedenza la stessa logica era duplicata identica
    in _send_channel_reply e _send_dm_reply — v. code review
    2026-08-20, §2.4).

    NOTA sul fix: la versione precedente riservava solo 1 byte per
    l'ellissi (`max_reply_length - 1`), ma "…" occupa 3 byte in UTF-8
    — il risultato finale poteva quindi superare `max_bytes` fino a 2
    byte, contraddicendo la garanzia dichiarata in ARCHITECTURE.md
    §16 ("la rete di sicurezza finale misura in byte UTF-8... mai
    affidarsi al fatto che di solito ci sta"). Qui si riservano
    esplicitamente TRUNCATION_SUFFIX_BYTES byte per l'ellissi.
    `errors="ignore"` sul decode scarta eventuali byte finali di un
    carattere multi-byte tagliato a metà dal cutoff — nessun
    carattere viene mai spezzato nel testo finale.
    """

    encoded = text.encode("utf-8")

    if len(encoded) <= max_bytes:
        return text

    cutoff = max(max_bytes - TRUNCATION_SUFFIX_BYTES, 0)

    candidate = (
        encoded[:cutoff].decode("utf-8", errors="ignore")
        + TRUNCATION_SUFFIX
    )

    #
    # Se max_bytes è più piccolo di TRUNCATION_SUFFIX_BYTES (3, "…" in
    # UTF-8), cutoff viene azzerato da max(..., 0) sopra ma il
    # suffisso da solo pesa comunque 3 byte — il risultato supererebbe
    # ugualmente max_bytes (code review Rev.6, trovato ESEGUENDO un
    # test mirato con budget=0/1/2: la garanzia in byte dichiarata nel
    # docstring di questa funzione ("non superi mai max_bytes") non
    # reggeva in questo caso limite). Non risulta oggi raggiungibile
    # da config.yaml (bot.max_reply_length non è tra i parametri
    # esposti da config.sh/tools/edit_config.py, v. NUMERIC_SUFFIXES),
    # ma resta un valore modificabile a mano nel file, e la funzione
    # deve comunque rispettare il contratto che dichiara di offrire in
    # OGNI caso, non solo in quelli oggi raggiungibili dall'interfaccia
    # — coerente con lo stesso principio "mai un errore grezzo, sempre
    # un valore difensivo" già seguito altrove nel progetto. Fallback:
    # tronca senza riservare spazio per l'ellissi, che a questo punto
    # non ci starebbe comunque.
    #
    if len(candidate.encode("utf-8")) > max_bytes:
        return encoded[:max(max_bytes, 0)].decode("utf-8", errors="ignore")

    return candidate


def _parse_command(text):
    """
    Separa il testo dopo il prefisso '!' in (nome_comando, arg).

    Solo il nome comando è normalizzato in minuscolo — l'argomento
    (es. il nome di una città per un futuro "!meteo Milano") resta
    così come digitato, dato che potrebbe averne bisogno case-
    sensitive. arg è None se il comando non ha argomento, che è il
    comportamento invariato per i comandi esistenti (!path, !ping,
    !info) — nessuna modifica richiesta a loro.
    """

    command, _, arg = text.strip().partition(" ")

    return command.lower(), (arg.strip() or None)


class BotModule:
    """
    Ascolta i comandi (prefisso '!') ricevuti sia sul canale
    configurato (default '#bot') sia via DM, fa da router verso i
    comandi registrati in mesh_modules/bot/commands/registry.py, e
    invia la risposta di conseguenza — sul canale con lo stesso
    flood-scope del messaggio originale, in DM con conferma di
    consegna (ACK) quando possibile.

    Non conosce la logica di alcun comando specifico — si occupa solo
    di: connessione/rebind, normalizzazione del contesto (canale vs
    DM), dispatch verso il comando giusto, invio/troncamento di
    sicurezza della risposta.

    Legge l'istanza MeshCore corrente dinamicamente da Engine ad ogni
    chiamata — non ne tiene mai una copia locale.

    NOTA (docs/CONTACT_MANAGEMENT.md §12): un DM da un mittente non
    presente nella contact list del device non genera MAI l'evento
    CONTACT_MSG_RECV — il device non riesce a decifrarlo senza la
    chiave pubblica del mittente, limite crittografico strutturale.
    _on_contact_message quindi non viene invocato per quel caso, non
    esiste un modo per "reagire" a un DM da uno sconosciuto (né per
    loggarlo, né per ripristinarlo) — confermato con test reale,
    tentativo di ripristino su richiesta rimosso di conseguenza.
    """

    COMMAND_PREFIX = "!"

    def __init__(self, engine):

        self.engine = engine

        self.channel_name = config.get(
            "bot.channel_name",
            "#bot"
        )

        self.max_reply_length = config.get(
            "bot.max_reply_length",
            140
        )

        self.known_regions = config.get(
            "bot.known_regions",
            []
        )

        self.channel = None

        #
        # Correlazione RX_LOG_DATA -> CHANNEL_MSG_RECV (scope canale).
        # Valore: LISTA di candidati per quel sender_timestamp, non un
        # singolo dict — nessun identificativo di mittente è
        # disponibile a questo livello (vedi nota su CORRELATION_TTL),
        # quindi due RX_LOG_DATA con lo stesso sender_timestamp sullo
        # stesso canale sono, per quanto ne sappiamo, entrambi
        # candidati legittimi. _resolve_scope_for_message() tratta più
        # di un candidato come ambiguo — non sceglie quale dei due sia
        # quello giusto, ma risponde comunque con lo scope ampio di
        # default (vedi commento lì) invece di uno scope stretto
        # potenzialmente sbagliato.
        #
        self._pending_scope_info = {}

        #
        # Un asyncio.Event per sender_timestamp, creato on-demand da
        # _on_channel_message() quando l'informazione di scope non è
        # ancora disponibile e serve attendere che arrivi (Finding 4,
        # review affidabilità 2026-08-21 — v. ARCHITECTURE.md §50,
        # sostituisce l'attesa fissa asyncio.sleep(0.3) di prima). Di
        # proprietà di chi aspetta, non un registro persistente: viene
        # sempre rimosso da _on_channel_message() stesso appena finita
        # l'attesa (successo o timeout) — nessuna pulizia periodica
        # necessaria qui, a differenza di _pending_scope_info.
        #
        self._scope_info_events = {}

        #
        # Dedup DM: chiave (pubkey_prefix, sender_timestamp), valore
        # timestamp di inserimento. I retry del mittente prima
        # dell'ACK condividono lo stesso sender_timestamp.
        #
        self._pending_dm_dedup = {}

        #
        # Riferimenti ai task di rebind creati da _on_rebind() (code
        # review 2026-08-20, §3.1 — stesso pattern già corretto in
        # mesh_modules/contact_sync/contact_sync.py) — un task senza
        # riferimenti può essere garbage collected in modo
        # imprevedibile prima del completamento.
        #
        self._rebind_tasks = set()

        #
        # Stato locale di "auto-fetch sospeso per una sessione CLI di
        # neighbor_monitor in corso" (Finding 3, 2026-08-21 — v.
        # ARCHITECTURE.md §48). Non è solo un rispecchiamento di
        # Engine.active_cli_sessions: serve anche a start()/
        # _rebind_async() per decidere se questa (ri)apertura deve
        # NON avviare l'auto-fetch perché una sessione CLI era già
        # attiva al momento del rebind (tipicamente una disconnessione
        # avvenuta a metà di una sessione neighbor_monitor).
        #
        self._auto_fetch_paused = False

        self.engine.register_rebind(self._on_rebind)
        self.engine.register_cli_session_listener(
            self._on_cli_session_change
        )

    async def start(self):

        await self._resolve_channel()

        #
        # Popola la cache contatti della libreria, necessaria per
        # risolvere pubkey_prefix -> nome/out_path sui DM. Un
        # ulteriore refresh viene comunque fatto prima di ogni
        # singolo lookup (vedi _on_contact_message) — questo qui
        # serve solo ad avere una cache non vuota fin dal primo
        # istante. Serializzato con command_lock (via
        # acquire_command_lock(), Finding 1/5 — v. ARCHITECTURE.md
        # §49) come ogni comando sulla connessione condivisa.
        #
        async with self.engine.acquire_command_lock("bot:start_get_contacts"):
            await self.engine.mesh.commands.get_contacts()

        self._subscribe()

        if self.engine.active_cli_sessions:

            #
            # Difesa in profondità, non un caso realmente
            # raggiungibile oggi (neighbor_monitor è IPC-driven, v.
            # ARCHITECTURE.md §2.1: nessuna richiesta esterna può
            # essere già in corso prima che IPCServer sia in ascolto
            # durante l'avvio del daemon) — ma mantiene vera
            # l'invariante "mai avviare l'auto-fetch mentre una
            # sessione CLI è marcata attiva" senza doverla dedurre
            # dall'ordine di avvio dei moduli (Finding 3, §48).
            #
            self._auto_fetch_paused = True

            log.info(
                "BotModule: avvio con auto-fetch sospeso — sessione "
                "CLI neighbor_monitor già attiva."
            )

        else:
            await self.engine.mesh.start_auto_message_fetching()

        log.info(
            "BotModule: in ascolto su %s (idx=%s) e sui DM, comandi "
            "disponibili: %s.",
            self.channel["channel_name"],
            self.channel["channel_idx"],
            ", ".join(sorted(COMMANDS)) or "(nessuno)"
        )

    #
    # Rete di sicurezza indipendente sul numero di canali interrogati
    # da _resolve_channel() (code review 2026-08-20, §3.3) — prima il
    # loop si affidava esclusivamente al comportamento della libreria
    # (fermarsi a EventType.ERROR) per terminare: se quel
    # comportamento cambiasse (libreria/firmware), il loop
    # diventerebbe infinito durante il rebind. Il firmware MeshCore
    # supporta un numero di canali limitato; questo valore è
    # deliberatamente generoso rispetto a qualunque configurazione
    # reale nota, per non rischiare falsi negativi.
    #
    MAX_CHANNELS = 64

    async def _resolve_channel(self):

        idx = 0

        while idx < self.MAX_CHANNELS:

            result = await self.engine.mesh.commands.get_channel(idx)

            if result.type == EventType.ERROR:
                raise RuntimeError(
                    f"Canale '{self.channel_name}' non trovato."
                )

            info = result.payload

            if info["channel_name"] == self.channel_name:
                self.channel = info
                return

            idx += 1

        raise RuntimeError(
            f"Canale '{self.channel_name}' non trovato entro i primi "
            f"{self.MAX_CHANNELS} indici — interrotto per sicurezza "
            "(v. code review 2026-08-20, §3.3)."
        )

    def _subscribe(self):

        #
        # Necessario per avere chan_hash/cipher_mac/crypted popolati
        # in RX_LOG_DATA (correlazione scope canale).
        #
        self.engine.mesh.set_decrypt_channel_logs(True)

        self.engine.mesh.subscribe(
            EventType.CHANNEL_MSG_RECV,
            self._on_channel_message
        )

        self.engine.mesh.subscribe(
            EventType.RX_LOG_DATA,
            self._on_log_data
        )

        self.engine.mesh.subscribe(
            EventType.CONTACT_MSG_RECV,
            self._on_contact_message
        )

    def _on_rebind(self, mesh):

        task = asyncio.create_task(
            self._rebind_async()
        )

        self._rebind_tasks.add(task)
        task.add_done_callback(
            self._rebind_tasks.discard
        )

    async def _rebind_async(self):

        log.info(
            "BotModule: rebinding dopo reconnect."
        )

        try:
            await self._resolve_channel()

            async with self.engine.acquire_command_lock("bot:rebind_get_contacts"):
                await self.engine.mesh.commands.get_contacts()

            self._subscribe()

            if self.engine.active_cli_sessions:

                #
                # Caso reale, non solo difesa in profondità: una
                # disconnessione può avvenire a metà di una sessione
                # CLI di neighbor_monitor — Engine.active_cli_sessions
                # resta popolato finché quella sessione non esce dal
                # proprio try/finally, indipendentemente dallo stato
                # della connessione. Riavviare l'auto-fetch qui
                # incondizionatamente lo farebbe ripartire su
                # un'istanza mesh nuova senza che
                # _on_cli_session_change(False) sia mai stato
                # notificato per QUESTA sessione — riaprendo proprio
                # nella finestra più delicata (una riconnessione) la
                # stessa race che il fix esiste per chiudere (Finding
                # 3, §48). Resta sospeso qui; la ripresa arriva
                # comunque tramite il listener quando la sessione
                # (fallita o meno per via della disconnessione) esce
                # dal proprio finally.
                #
                self._auto_fetch_paused = True

                log.info(
                    "BotModule: rebind con auto-fetch sospeso — "
                    "sessione CLI neighbor_monitor ancora attiva."
                )

            else:
                await self.engine.mesh.start_auto_message_fetching()

        except Exception:
            log.exception(
                "BotModule: rebind fallito."
            )

    async def _on_cli_session_change(self, active):
        """
        Registrata su Engine (Finding 3, 2026-08-21 — v.
        ARCHITECTURE.md §48): sospende l'auto-fetch dei messaggi
        finché almeno una sessione CLI di neighbor_monitor è in
        corso, per non competere con essa su get_msg() a livello di
        device — get_msg() PRELEVA il messaggio dalla coda del
        device, non è un evento broadcast: se a vincere la corsa è
        l'auto-fetch del bot invece di neighbor_monitor, quest'ultimo
        non riceve mai la risposta che stava aspettando (Finding 3 di
        REVIEW_AFFIDABILITA_2026-08-21.md).

        Scelta di design esplicitamente confermata dall'utente,
        coerente con un trade-off già in vigore nel progetto (v.
        ARCHITECTURE.md §44: "sacrificio del BOT quando
        neighbor_monitor occupa a lungo command_lock"): il bot resta
        il consumatore meno prioritario del device. I messaggi/DM
        diretti al bot restano semplicemente in coda SUL DEVICE (non
        persi, non scartati — get_msg() li preleverà non appena
        l'auto-fetch riprende) per la durata della sessione CLI,
        stesso genere di attesa che il bot subisce già oggi per
        l'invio delle proprie risposte quando si accoda dietro
        neighbor_monitor su command_lock (Finding 1, non ancora
        affrontato).
        """

        self._auto_fetch_paused = active

        try:
            if active:

                await self.engine.mesh.stop_auto_message_fetching()

                log.info(
                    "BotModule: auto-fetch sospeso (sessione CLI "
                    "neighbor_monitor in corso)."
                )

            else:

                await self.engine.mesh.start_auto_message_fetching()

                log.info(
                    "BotModule: auto-fetch ripreso (nessuna sessione "
                    "CLI neighbor_monitor più attiva)."
                )

        except Exception:
            log.exception(
                "BotModule: %s dell'auto-fetch fallita (active=%s) — "
                "un rebind successivo lo riallineerà comunque.",
                "sospensione" if active else "ripresa",
                active
            )

    #
    # ------------------------------------------------------------
    # CANALE
    # ------------------------------------------------------------
    #

    async def _on_log_data(self, event):

        if self.channel is None:
            return

        payload = event.payload

        if payload.get("payload_typename") != "GRP_TXT":
            return

        if payload.get("chan_hash") != self.channel["channel_hash"]:
            return

        sender_timestamp = payload.get("sender_timestamp")

        if sender_timestamp is None:
            return

        transport_code_hex = payload.get("transport_code")

        transport_code = None

        if transport_code_hex:
            #
            # Solo i primi 2 byte (transport_code_1) contano, i
            # successivi 2 sono riservati.
            #
            transport_code = int.from_bytes(
                bytes.fromhex(transport_code_hex)[:2],
                "little"
            )

        try:
            payload_bytes = (
                bytes.fromhex(payload["chan_hash"]) +
                bytes.fromhex(payload["cipher_mac"]) +
                bytes.fromhex(payload["crypted"])
            )
        except (KeyError, ValueError):
            return

        self._prune_scope_info()

        #
        # Accoda invece di sovrascrivere: se un altro RX_LOG_DATA con
        # lo stesso sender_timestamp arriva prima che questo venga
        # consumato, _resolve_scope_for_message() deve poterli vedere
        # entrambi per riconoscere l'ambiguità, non solo l'ultimo.
        #
        self._pending_scope_info.setdefault(
            sender_timestamp,
            []
        ).append(
            {
                "transport_code": transport_code,
                "payload_type": payload.get("payload_type"),
                "payload": payload_bytes,
                "added_at": time.monotonic()
            }
        )

        #
        # Sveglia immediatamente un _on_channel_message() già in
        # attesa per questo sender_timestamp, se esiste (Finding 4,
        # review affidabilità 2026-08-21 — v. ARCHITECTURE.md §50).
        # Se non c'è nessuna attesa in corso (RX_LOG_DATA arrivato
        # PRIMA di CHANNEL_MSG_RECV, il caso comune per il commento
        # originale su questa correlazione) non c'è nulla da
        # svegliare — il candidato resta comunque in
        # _pending_scope_info, letto subito senza alcuna attesa dal
        # prossimo _on_channel_message() per lo stesso
        # sender_timestamp.
        #
        scope_event = self._scope_info_events.get(sender_timestamp)

        if scope_event is not None:
            scope_event.set()

    def _resolve_scope_for_message(self, sender_timestamp, tag):

        candidates = self._pending_scope_info.pop(sender_timestamp, None)

        if not candidates:
            log.warning(
                "BOT: %s nessuna info di scope correlata per il messaggio.",
                tag
            )
            return None

        if len(candidates) > 1:

            #
            # Nessun identificativo di mittente disponibile a questo
            # livello per decidere quale dei candidati appartenga a
            # QUESTO messaggio (vedi nota su CORRELATION_TTL) — non
            # possiamo scegliere il candidato giusto, ma NON è lo
            # stesso caso di "scope non riconosciuto" (quello ritorna
            # None più sotto, trattato con scope_to_set="" da
            # _send_channel_reply): qui torniamo "" (default/ampio,
            # stesso scope_to_set="*" già usato per i messaggi
            # nativamente unscoped) di proposito, non None. Un
            # candidato scartato dall'ambiguità potrebbe comunque
            # appartenere a un mittente scoped su una regione stretta
            # — rispondere con lo scope ampio dà a TUTTI i mittenti
            # coinvolti nella collisione una possibilità di ricevere
            # la risposta, invece di rischiare un pacchetto unscoped
            # che alcuni nodi potrebbero non ritrasmettere. Caso raro
            # per costruzione (stesso canale, stesso secondo, finestra
            # di pochi secondi), ma va comunque gestito con l'invio
            # più permissivo, non con quello più silenzioso.
            #
            log.warning(
                "BOT: %s scope ambiguo, %d candidati con lo stesso "
                "sender_timestamp sullo stesso canale — risposta "
                "inviata con scope ampio di default.",
                tag,
                len(candidates)
            )

            return ""

        info = candidates[0]

        if info["transport_code"] is None:
            return ""

        if not self.known_regions:
            log.warning(
                "BOT: %s messaggio scoped ma bot.known_regions è vuoto "
                "in config, impossibile risalire al nome.",
                tag
            )
            return None

        region = resolve_region(
            info["payload_type"],
            info["payload"],
            info["transport_code"],
            self.known_regions
        )

        if region is None:
            log.warning(
                "BOT: %s scope non riconosciuto tra known_regions "
                "(transport_code=%s).",
                tag,
                info["transport_code"]
            )

        return region

    async def _on_channel_message(self, event):

        payload = event.payload

        if self.channel is None:
            return

        if payload.get("channel_idx") != self.channel["channel_idx"]:
            return

        text = payload.get("text", "")

        if ": " in text:
            sender_name, _, body = text.partition(": ")
        else:
            sender_name, body = "", text

        #
        # v. MAX_SENDER_NAME_LEN — mittente non autenticato, testo
        # libero senza limite di protocollo (code review 2026-08-20,
        # §3.3).
        #
        sender_name = sender_name[:MAX_SENDER_NAME_LEN]

        body = body.strip()

        if not body.startswith(self.COMMAND_PREFIX):
            return

        command, arg = _parse_command(
            body[len(self.COMMAND_PREFIX):]
        )

        handler = COMMANDS.get(command)

        tag = _tag(payload.get("sender_timestamp"))

        #
        # %r invece di %s per command/sender_name (code review
        # 2026-08-20, §4) — entrambi provengono da testo radio non
        # autenticato (v. MAX_SENDER_NAME_LEN sopra); %r applica
        # repr(), che esegue l'escape di newline/caratteri di
        # controllo, impedendo a un mittente malevolo di iniettare
        # righe di log false (es. un sender_name contenente "\n2026-
        # 01-01 CRITICAL: ...") spacciandole per voci legittime
        # generate da questo processo. arg era già protetto da %r.
        #
        if handler is None:
            log.info(
                "BotModule: %s comando canale sconosciuto %r.",
                tag,
                command
            )
            return

        log.info(
            "BotModule: %s comando canale %r (arg=%r) da %r.",
            tag,
            command,
            arg,
            sender_name
        )

        sender_timestamp = payload.get("sender_timestamp")

        #
        # Attesa basata su evento invece di un'attesa fissa (Finding 4,
        # review affidabilità 2026-08-21 — v. ARCHITECTURE.md §50):
        # RX_LOG_DATA a volte arriva a ridosso di CHANNEL_MSG_RECV, non
        # sempre prima. Se è già arrivato (già in _pending_scope_info)
        # si procede SUBITO, senza attendere nulla. Altrimenti si
        # attende un segnale esplicito da _on_log_data() — non un
        # tempo fisso — con CHANNEL_SCOPE_CORRELATION_TIMEOUT come
        # UNICO tetto massimo: stesso valore di prima (0.3s), quindi
        # nessuna regressione sul caso peggiore, solo sul caso comune
        # (ora molto più reattivo, non più un ritardo pagato da ogni
        # singolo messaggio di canale indipendentemente da cosa serva
        # davvero).
        #
        scope_event = self._scope_info_events.setdefault(
            sender_timestamp,
            asyncio.Event()
        )

        try:
            if sender_timestamp not in self._pending_scope_info:
                try:
                    await asyncio.wait_for(
                        scope_event.wait(),
                        timeout=CHANNEL_SCOPE_CORRELATION_TIMEOUT
                    )
                except asyncio.TimeoutError:
                    #
                    # Nessun RX_LOG_DATA arrivato entro il tetto
                    # massimo — comportamento identico a prima del
                    # fix: _resolve_scope_for_message() sotto non
                    # troverà candidati, loggherà e ritornerà None
                    # (scope sconosciuto), gestito a valle da
                    # _send_channel_reply() esattamente come oggi.
                    #
                    pass
        finally:
            #
            # Rimosso qui, non da _on_log_data(): questo Event è di
            # proprietà di QUESTA attesa, non un registro persistente
            # — se un secondo RX_LOG_DATA per lo stesso
            # sender_timestamp arriva DOPO che questa funzione ha già
            # smesso di aspettare (successo o timeout), non c'è più
            # nessuno interessato a QUESTO Event specifico: un futuro
            # _on_channel_message() per lo stesso sender_timestamp, se
            # mai arriva, ne creerà uno nuovo e troverà comunque quel
            # candidato già in _pending_scope_info, invariato.
            #
            self._scope_info_events.pop(sender_timestamp, None)

        region = self._resolve_scope_for_message(
            sender_timestamp,
            tag
        )

        prefix = f"@[{sender_name}] "

        #
        # Budget sui BYTE UTF-8 del prefisso, non sui caratteri (code
        # review 2026-08-20 Rev5) — max_reply_length è un limite in byte
        # (vedi ARCHITECTURE.md §16, _truncate_utf8_safe), ma sender_name
        # è testo libero non autenticato (fino a MAX_SENDER_NAME_LEN
        # caratteri) e può contenere UTF-8 multi-byte: usare len(prefix)
        # (caratteri) sottostimava l'ingombro reale del prefisso in byte,
        # sovrastimando così ctx.reply_budget passato ai comandi. In
        # particolare PathCommand/format_path() tronca sui confini degli
        # hop assumendo che il budget ricevuto sia già corretto in byte
        # ("mai un hash tagliato a metà" — invariante di ARCHITECTURE.md
        # §16): con un budget sovrastimato, la rete di sicurezza finale
        # (_truncate_utf8_safe in _send_channel_reply) poteva tagliare la
        # stringa combinata (prefix+content) a un confine di byte che non
        # rispetta più i confini di hop già calcolati, spezzando un hash
        # a metà — esattamente l'invariante che PathCommand dichiara di
        # rispettare. Non riguarda il DM (reply_budget=max_reply_length
        # lì, nessun prefisso).
        #
        budget = max(self.max_reply_length - len(prefix.encode("utf-8")), 0)

        ctx = CommandContext(
            engine=self.engine,
            is_dm=False,
            sender_name=sender_name,
            region=region,
            path_hex=payload.get("path", "") or "",
            path_len=payload.get("path_len", 0),
            rssi=payload.get("RSSI"),
            snr=payload.get("SNR"),
            reply_budget=budget,
            arg=arg,
            channel=self.channel
        )

        content = await self._run_command(handler, command, ctx, tag)

        if not content:
            return

        await self._send_channel_reply(f"{prefix}{content}", region, tag)

    async def _send_channel_reply(self, text, region, tag):

        if not self.engine.connected:
            log.warning(
                "BOT: %s connessione non attiva, risposta canale annullata.",
                tag
            )
            return

        text = _truncate_utf8_safe(text, self.max_reply_length)

        if region == "":
            scope_to_set = "*"
        elif region is None:
            scope_to_set = ""
        else:
            scope_to_set = region

        # acquire_command_lock() invece dell'accesso diretto al lock
        # (Finding 1/5, review affidabilità 2026-08-21 — v.
        # ARCHITECTURE.md §49).
        async with self.engine.acquire_command_lock("bot:send_channel_reply"):

            #
            # Prima di questo fix (code review 2026-08-20, §3.3), un
            # errore qui veniva solo loggato: a differenza di
            # send_chan_msg()/send_msg_with_retry() sotto, non
            # chiamava report_possible_failure() né interrompeva
            # l'invio — il messaggio partiva comunque con lo scope
            # RESIDUO della chiamata precedente, contraddicendo
            # l'invariante "mai stato residuo" dichiarato per gli
            # altri casi (v. classe CommandContext/region più sopra).
            # Se non possiamo garantire lo scope corretto, è più
            # sicuro non inviare affatto la risposta con uno scope
            # potenzialmente sbagliato (rischio: canale troppo ampio o
            # troppo stretto rispetto a quanto atteso) che segnalare
            # la connessione come sospetta, come già fa l'heartbeat in
            # casi analoghi.
            #
            # Quel fix però non funzionava mai (audit successivo al
            # Finding 2 di una review indipendente, 2026-08-20):
            # set_flood_scope() non è pre-unwrappata dalla libreria —
            # su fallimento non solleva un'eccezione, ritorna un
            # Event(ERROR, ...) grezzo (verificato leggendo
            # meshcore_py/commands/messaging.py) — quindi il solo
            # except Exception sotto non intercettava mai un
            # fallimento reale del comando, ed esattamente lo scenario
            # che questo fix credeva di aver chiuso restava aperto.
            # Ora controlliamo .type, non solo un except dedicato,
            # stesso principio già applicato in advert.py/trace.py/
            # clock_sync.py e in _get_stats_safe() di contact_sync.py.
            #
            try:
                event = await self.engine.mesh.commands.set_flood_scope(
                    scope_to_set
                )

            except Exception:

                log.exception(
                    "BOT: %s set_flood_scope('%s') fallito — "
                    "risposta canale annullata per evitare di "
                    "inviare con uno scope residuo/incerto.",
                    tag,
                    scope_to_set
                )

                self.engine.report_possible_failure()

                return

            if event.type == EventType.ERROR:

                log.warning(
                    "BOT: %s set_flood_scope('%s') fallito (%s) — "
                    "risposta canale annullata per evitare di "
                    "inviare con uno scope residuo/incerto.",
                    tag,
                    scope_to_set,
                    event.payload
                )

                self.engine.report_possible_failure()

                return

            log.info(
                "BOT: %s reply canale (scope=%r, applicato=%r) -> %s",
                tag,
                region,
                scope_to_set,
                text
            )

            try:
                event = await self.engine.mesh.commands.send_chan_msg(
                    self.channel["channel_idx"],
                    text
                )

            except Exception:
                log.exception(
                    "BOT: %s send_chan_msg() failed",
                    tag
                )
                self.engine.report_possible_failure()
                raise

        if event.type == EventType.ERROR:
            log.warning(
                "BOT: %s reply canale failed: %r",
                tag,
                event.payload
            )
            self.engine.report_possible_failure()

    #
    # ------------------------------------------------------------
    # DM
    # ------------------------------------------------------------
    #

    async def _on_contact_message(self, event):
        """
        NOTA: per un mittente non presente nella contact list del
        device, questo handler non viene MAI invocato — l'evento
        CONTACT_MSG_RECV stesso non scatta (vedi docstring della
        classe). Il controllo 'contact is None' qui sotto resta solo
        come rete di sicurezza difensiva per casi limite imprevisti,
        non copre realisticamente "mittente sconosciuto/rimosso".
        """

        payload = event.payload

        pubkey_prefix = payload.get("pubkey_prefix")

        if not pubkey_prefix:
            return

        sender_timestamp = payload.get("sender_timestamp")

        tag = _tag(sender_timestamp)

        #
        # Le risposte a login/comandi CLI di neighbor_monitor
        # arrivano come CONTACT_MSG_RECV — stesso evento delle DM
        # vere, indistinguibile a livello di protocollo. Un repeater
        # non avvia mai una DM legittima verso il bot di sua
        # iniziativa (solo i device chat lo fanno): se il mittente è
        # una chiave verso cui è in corso una sessione CLI, la
        # risposta è certamente per neighbor_monitor, non per il bot
        # — usciamo subito, prima del dedup e di qualunque altra
        # elaborazione (incluso il refresh get_contacts() più sotto,
        # che altrimenti scatterebbe inutilmente ad ogni risposta).
        # Vedi Engine.active_cli_sessions.
        #
        if any(
            full_key.startswith(pubkey_prefix)
            for full_key in self.engine.active_cli_sessions
        ):

            log.info(
                "BOT: %s ignorato, risposta CLI attesa da "
                "neighbor_monitor (non una DM) da %s.",
                tag,
                pubkey_prefix
            )

            return

        #
        # Dedup: i retry del mittente prima dell'ACK condividono lo
        # stesso sender_timestamp.
        #
        dedup_key = (pubkey_prefix, sender_timestamp)

        self._prune_dict(self._pending_dm_dedup, DM_DEDUP_TTL)

        if dedup_key in self._pending_dm_dedup:
            log.info(
                "BOT: %s DM duplicato (retry pre-ACK) ignorato da %s.",
                tag,
                pubkey_prefix
            )
            return

        self._pending_dm_dedup[dedup_key] = time.monotonic()

        #
        # Refresh esplicito prima del lookup: get_contact_by_key_prefix()
        # legge dalla cache locale della libreria, che riflette solo
        # l'ultimo get_contacts() eseguito.
        #
        try:
            # acquire_command_lock() invece dell'accesso diretto al
            # lock (Finding 1/5, review affidabilità 2026-08-21 — v.
            # ARCHITECTURE.md §49).
            async with self.engine.acquire_command_lock("bot:contact_message_refresh_contacts"):
                await self.engine.mesh.commands.get_contacts()

        except Exception:
            log.exception(
                "BOT: %s refresh contatti fallito, uso la cache esistente.",
                tag
            )

        contact = self.engine.mesh.get_contact_by_key_prefix(pubkey_prefix)

        if contact is None:
            #
            # Rete di sicurezza difensiva — non dovrebbe accadere
            # (vedi nota in cima al metodo), ma se succede evitiamo
            # un crash su contact.get(...) più sotto.
            #
            log.warning(
                "BOT: %s contatto non trovato dopo CONTACT_MSG_RECV "
                "(%s) — caso imprevisto.",
                tag,
                pubkey_prefix
            )
            return

        #
        # v. MAX_SENDER_NAME_LEN — adv_name proviene dalla rete
        # mesh, controllato dal device remoto (code review
        # 2026-08-20, §3.3).
        #
        sender_name = (
            contact.get("adv_name") or pubkey_prefix
        )[:MAX_SENDER_NAME_LEN]

        text = (payload.get("text", "") or "").strip()

        if not text.startswith(self.COMMAND_PREFIX):
            return

        command, arg = _parse_command(
            text[len(self.COMMAND_PREFIX):]
        )

        handler = COMMANDS.get(command)

        #
        # %r invece di %s per command/sender_name — stessa
        # motivazione di _on_channel_message() (code review
        # 2026-08-20, §4): protezione da log injection via testo
        # radio non autenticato.
        #
        if handler is None:
            log.info(
                "BotModule: %s comando DM sconosciuto %r da %r.",
                tag,
                command,
                sender_name
            )
            return

        log.info(
            "BotModule: %s comando DM %r (arg=%r) da %r.",
            tag,
            command,
            arg,
            sender_name
        )

        out_path_len = contact.get("out_path_len", OUT_PATH_UNKNOWN)
        out_path = contact.get("out_path", "")

        if out_path_len in UNKNOWN_OUT_PATH_VALUES:
            path_hex, path_len = None, None
        else:
            path_hex, path_len = out_path, out_path_len

        ctx = CommandContext(
            engine=self.engine,
            is_dm=True,
            sender_name=sender_name,
            region=None,
            path_hex=path_hex,
            path_len=path_len,
            rssi=payload.get("RSSI"),
            snr=payload.get("SNR"),
            reply_budget=self.max_reply_length,
            arg=arg,
            contact=contact
        )

        content = await self._run_command(handler, command, ctx, tag)

        if not content:
            return

        await self._send_dm_reply(content, contact, tag)

    async def _run_command(self, handler, command, ctx, tag):

        try:
            return await handler.handle(ctx)

        except Exception:
            log.exception(
                "BotModule: %s comando '%s' fallito.",
                tag,
                command
            )
            return None

    async def _send_dm_reply(self, text, contact, tag):
        """
        Invia la risposta in DM con conferma di consegna (ACK).

        NOTA: su percorsi radio asimmetrici l'ACK può non tornare
        anche se il messaggio è stato ricevuto correttamente (vedi
        ARCHITECTURE.md) — un mancato ACK viene quindi loggato come
        tale, non come "invio fallito", e NON viene considerato un
        segnale di guasto della connessione locale
        (report_possible_failure() non viene chiamato in quel caso).

        send_msg_with_retry() può tornare None quando i tentativi si
        esauriscono senza ricevere ACK (non sempre un Event con
        type=ERROR come inizialmente assunto — confermato da un
        crash reale in produzione, 2026-08-07) — va gestito
        esplicitamente, non solo controllato via .type.
        """

        if not self.engine.connected:
            log.warning(
                "BOT: %s connessione non attiva, risposta DM annullata.",
                tag
            )
            return

        text = _truncate_utf8_safe(text, self.max_reply_length)

        #
        # Il sito esatto del Finding 1 (review affidabilità
        # 2026-08-21 — v. ARCHITECTURE.md §49): send_msg_with_retry()
        # qui sotto può tenere command_lock per l'intera sequenza di
        # retry (fino a 3 tentativi, uno in flood dopo un
        # reset_path() intermedio), superando abbondantemente il
        # vecchio DEFAULT_IPC_TIMEOUT di 30s — acquire_command_lock()
        # non cambia questo comportamento (resta la stessa scelta
        # architetturale deliberata: un DM non viene interrotto a
        # metà), ma rende diagnosticabile chi resta bloccato dietro
        # di esso.
        #
        async with self.engine.acquire_command_lock("bot:send_dm_reply"):

            try:
                event = await self.engine.mesh.commands.send_msg_with_retry(
                    contact,
                    text
                )

            except Exception:
                log.exception(
                    "BOT: %s send_msg_with_retry() failed",
                    tag
                )
                self.engine.report_possible_failure()
                raise

        if event is None:

            log.warning(
                "BOT: %s DM reply — nessun ACK ricevuto, tentativi "
                "esauriti (possibile percorso radio asimmetrico, il "
                "messaggio potrebbe comunque essere arrivato).",
                tag
            )

        elif event.type == EventType.ERROR:

            log.warning(
                "BOT: %s DM reply — nessun ACK ricevuto o errore di invio "
                "(possibile percorso radio asimmetrico, il messaggio "
                "potrebbe comunque essere arrivato): %r",
                tag,
                event.payload
            )

        else:
            log.info(
                "BOT: %s DM reply confermata (ACK ricevuto) -> %s",
                tag,
                text
            )

    #
    # ------------------------------------------------------------
    # Utility condivisa
    # ------------------------------------------------------------
    #

    def _prune_dict(self, d, ttl):

        now = time.monotonic()

        expired = [
            k for k, added_at in (
                (k, v["added_at"] if isinstance(v, dict) else v)
                for k, v in d.items()
            )
            if now - added_at > ttl
        ]

        for k in expired:
            del d[k]

    def _prune_scope_info(self):
        """
        Variante di _prune_dict() per _pending_scope_info: qui il
        valore è una LISTA di candidati per sender_timestamp (non un
        singolo dict/timestamp), quindi la potatura va fatta voce per
        voce dentro ciascuna lista, non sull'intera chiave — un
        candidato vecchio non deve trascinare con sé uno scaduto da
        poco per lo stesso sender_timestamp. Le chiavi rimaste con
        lista vuota vengono rimosse.
        """

        now = time.monotonic()

        empty_keys = []

        for key, candidates in self._pending_scope_info.items():

            candidates[:] = [
                c for c in candidates
                if now - c["added_at"] <= CORRELATION_TTL
            ]

            if not candidates:
                empty_keys.append(key)

        for key in empty_keys:
            del self._pending_scope_info[key]
