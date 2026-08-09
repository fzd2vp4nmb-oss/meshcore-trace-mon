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
# noto, instradamento in flood" sul contatto.
#
OUT_PATH_UNKNOWN = 255

#
# Vita massima delle cache di correlazione/dedup, in secondi.
#
CORRELATION_TTL = 15
DM_DEDUP_TTL = 60


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
        #
        self._pending_scope_info = {}

        #
        # Dedup DM: chiave (pubkey_prefix, sender_timestamp), valore
        # timestamp di inserimento. I retry del mittente prima
        # dell'ACK condividono lo stesso sender_timestamp.
        #
        self._pending_dm_dedup = {}

        self.engine.register_rebind(self._on_rebind)

    async def start(self):

        await self._resolve_channel()

        #
        # Popola la cache contatti della libreria, necessaria per
        # risolvere pubkey_prefix -> nome/out_path sui DM. Un
        # ulteriore refresh viene comunque fatto prima di ogni
        # singolo lookup (vedi _on_contact_message) — questo qui
        # serve solo ad avere una cache non vuota fin dal primo
        # istante. Serializzato con command_lock come ogni comando
        # sulla connessione condivisa.
        #
        async with self.engine.command_lock:
            await self.engine.mesh.commands.get_contacts()

        self._subscribe()

        await self.engine.mesh.start_auto_message_fetching()

        log.info(
            "BotModule: in ascolto su %s (idx=%s) e sui DM, comandi "
            "disponibili: %s.",
            self.channel["channel_name"],
            self.channel["channel_idx"],
            ", ".join(sorted(COMMANDS)) or "(nessuno)"
        )

    async def _resolve_channel(self):

        idx = 0

        while True:

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

        asyncio.create_task(
            self._rebind_async()
        )

    async def _rebind_async(self):

        log.info(
            "BotModule: rebinding dopo reconnect."
        )

        try:
            await self._resolve_channel()

            async with self.engine.command_lock:
                await self.engine.mesh.commands.get_contacts()

            self._subscribe()

            await self.engine.mesh.start_auto_message_fetching()

        except Exception:
            log.exception(
                "BotModule: rebind fallito."
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

        self._prune_dict(self._pending_scope_info, CORRELATION_TTL)

        self._pending_scope_info[sender_timestamp] = {
            "transport_code": transport_code,
            "payload_type": payload.get("payload_type"),
            "payload": payload_bytes,
            "added_at": time.monotonic()
        }

    def _resolve_scope_for_message(self, sender_timestamp, tag):

        info = self._pending_scope_info.pop(sender_timestamp, None)

        if info is None:
            log.warning(
                "BOT: %s nessuna info di scope correlata per il messaggio.",
                tag
            )
            return None

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

        body = body.strip()

        if not body.startswith(self.COMMAND_PREFIX):
            return

        command, arg = _parse_command(
            body[len(self.COMMAND_PREFIX):]
        )

        handler = COMMANDS.get(command)

        tag = _tag(payload.get("sender_timestamp"))

        if handler is None:
            log.info(
                "BotModule: %s comando canale sconosciuto '%s'.",
                tag,
                command
            )
            return

        log.info(
            "BotModule: %s comando canale '%s' (arg=%r) da '%s'.",
            tag,
            command,
            arg,
            sender_name
        )

        #
        # Piccola attesa: RX_LOG_DATA a volte arriva a ridosso di
        # CHANNEL_MSG_RECV, non sempre prima.
        #
        await asyncio.sleep(0.3)

        region = self._resolve_scope_for_message(
            payload.get("sender_timestamp"),
            tag
        )

        prefix = f"@[{sender_name}] "
        budget = max(self.max_reply_length - len(prefix), 0)

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

        encoded = text.encode("utf-8")

        if len(encoded) > self.max_reply_length:
            text = encoded[:self.max_reply_length - 1].decode(
                "utf-8", errors="ignore"
            ) + "…"

        if region == "":
            scope_to_set = "*"
        elif region is None:
            scope_to_set = ""
        else:
            scope_to_set = region

        async with self.engine.command_lock:

            try:
                await self.engine.mesh.commands.set_flood_scope(scope_to_set)

            except Exception:
                log.exception(
                    "BOT: %s set_flood_scope('%s') fallito.",
                    tag,
                    scope_to_set
                )

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
            async with self.engine.command_lock:
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

        sender_name = contact.get("adv_name", pubkey_prefix)

        text = (payload.get("text", "") or "").strip()

        if not text.startswith(self.COMMAND_PREFIX):
            return

        command, arg = _parse_command(
            text[len(self.COMMAND_PREFIX):]
        )

        handler = COMMANDS.get(command)

        if handler is None:
            log.info(
                "BotModule: %s comando DM sconosciuto '%s' da '%s'.",
                tag,
                command,
                sender_name
            )
            return

        log.info(
            "BotModule: %s comando DM '%s' (arg=%r) da '%s'.",
            tag,
            command,
            arg,
            sender_name
        )

        out_path_len = contact.get("out_path_len", OUT_PATH_UNKNOWN)
        out_path = contact.get("out_path", "")

        if out_path_len == OUT_PATH_UNKNOWN:
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

        encoded = text.encode("utf-8")

        if len(encoded) > self.max_reply_length:
            text = encoded[:self.max_reply_length - 1].decode(
                "utf-8", errors="ignore"
            ) + "…"

        async with self.engine.command_lock:

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
