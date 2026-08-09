import asyncio

from core.logger import log

from meshcore.events import EventType


#
# Comandi CLI testuali interrogati dopo il login (vedi
# docs/NEIGHBOR_MONITORING.md §12). Ogni voce: (chiave risultato,
# comando da inviare, funzione di conversione del valore testuale).
# path.hash.mode confermato esistente dall'utente (via app, manuale)
# nonostante un primo test in timeout — su LoRa un mancato invio non
# prova mai che un comando non esista, va sempre riprovato come gli
# altri.
#
CLI_QUERIES = [
    ("firmware_version", "ver", str),
    ("path_hash_mode", "get path.hash.mode", int),
    ("txdelay", "get txdelay", float),
    ("direct_txdelay", "get direct.txdelay", float),
    ("rxdelay", "get rxdelay", float),
    ("flood_max", "get flood.max", int),
    ("flood_max_unscoped", "get flood.max.unscoped", int),
    ("flood_max_advert", "get flood.max.advert", int),
]

#
# Timeout per singola risposta — stesso valore usato nello script
# diagnostico (experiments/exp09_login_cli_test.py), sufficiente per
# tutte le risposte riuscite nel test reale (max 2.03s) con margine
# ampio per la variabilità radio.
#
CLI_RESPONSE_TIMEOUT = 10.0


class NeighborMonitorModule:
    """
    Interroga un repeater remoto per status, neighbours, telemetria
    e regioni supportate, via richieste dirette (req_status_sync/
    fetch_all_neighbours/req_telemetry_sync/req_regions_sync) — non
    trace/advert. Vedi docs/NEIGHBOR_MONITORING.md.

    Legge l'istanza MeshCore corrente dinamicamente da Engine ad
    ogni chiamata, come TraceModule/ContactSyncModule — nessuna
    copia locale, resta valido dopo una riconnessione completa.

    Nessun lock esplicito qui dentro: come TraceModule, si affida al
    fatto che IPCServer.handle_client() avvolge l'intero dispatch()
    (quindi anche get_contacts()+req_status_sync()+
    fetch_all_neighbours()+req_telemetry_sync()+req_regions_sync()
    in sequenza) in Engine.command_lock.
    """

    def __init__(self, engine):
        self.engine = engine

    async def query(self, repeater_name):
        """
        Risolve repeater_name in chiave pubblica via get_contacts(),
        poi interroga status, neighbours, telemetria e regioni in
        sequenza.

        Ritorna None su qualunque fallimento (repeater non trovato
        nella lista contatti, timeout, permesso ACL mancante) —
        questi ultimi due sono indistinguibili a livello di
        libreria, vedi docs/NEIGHBOR_MONITORING.md §2. Il dettaglio
        va solo nei log, mai nella risposta IPC — stesso principio
        già adottato altrove nel progetto (!meteo, !status).

        Se anche solo una delle quattro richieste va a buon fine, il
        risultato viene comunque restituito con i campi mancanti a
        None — meglio un dato parziale che nessun dato, dato che
        sono richieste radio indipendenti. Nota: req_regions_sync()
        non richiede ACL (usa AnonReqType, non BinaryReqType come le
        altre tre) — può quindi riuscire anche quando status/
        neighbours/telemetry falliscono per un problema ACL, non
        solo per un timeout radio genuino.
        """

        tag = f"[repeater:{repeater_name}]"

        if not self.engine.connected:

            log.warning(
                "NEIGHBOR_MONITOR: %s connessione non attiva, "
                "query annullata.",
                tag
            )

            return None

        try:
            await self.engine.mesh.commands.get_contacts()

        except Exception:

            log.exception(
                "NEIGHBOR_MONITOR: %s get_contacts() fallito.",
                tag
            )

            return None

        contact = self._resolve_contact(repeater_name)

        if contact is None:

            log.warning(
                "NEIGHBOR_MONITOR: %s non presente nella lista "
                "contatti del device.",
                tag
            )

            return None

        public_key = contact.get("public_key")
        adv_name = contact.get("adv_name")

        status = None
        neighbours = None
        telemetry = None
        region = None

        try:
            status = await self.engine.mesh.commands.req_status_sync(
                public_key
            )

        except Exception:

            log.exception(
                "NEIGHBOR_MONITOR: %s req_status_sync() fallita.",
                tag
            )

        if status is None:

            log.warning(
                "NEIGHBOR_MONITOR: %s nessuna risposta a req_status "
                "(timeout, o permesso ACL mancante — indistinguibili "
                "a questo livello).",
                tag
            )

        try:
            neighbours = await self.engine.mesh.commands.fetch_all_neighbours(
                public_key
            )

        except Exception:

            log.exception(
                "NEIGHBOR_MONITOR: %s fetch_all_neighbours() fallita.",
                tag
            )

        if neighbours is None:

            log.warning(
                "NEIGHBOR_MONITOR: %s nessuna risposta a "
                "req_neighbours (timeout, o permesso ACL mancante — "
                "indistinguibili a questo livello).",
                tag
            )

        try:
            telemetry = await self.engine.mesh.commands.req_telemetry_sync(
                public_key
            )

        except Exception:

            log.exception(
                "NEIGHBOR_MONITOR: %s req_telemetry_sync() fallita.",
                tag
            )

        if telemetry is None:

            log.warning(
                "NEIGHBOR_MONITOR: %s nessuna risposta a "
                "req_telemetry (timeout, o permesso ACL mancante — "
                "indistinguibili a questo livello).",
                tag
            )

        try:
            region = await self.engine.mesh.commands.req_regions_sync(
                public_key
            )

        except Exception:

            log.exception(
                "NEIGHBOR_MONITOR: %s req_regions_sync() fallita.",
                tag
            )

        if region is None:

            log.warning(
                "NEIGHBOR_MONITOR: %s nessuna risposta a "
                "req_regions (nessun ACL richiesto per questa "
                "richiesta — un fallimento qui è più probabilmente "
                "un timeout radio genuino che un problema di "
                "permessi).",
                tag
            )

        config = await self._query_cli_config(
            public_key,
            tag
        )

        if (
            status is None and
            neighbours is None and
            telemetry is None and
            region is None and
            config is None
        ):
            return None

        log.info(
            "NEIGHBOR_MONITOR: %s query completata (status=%s, "
            "neighbours=%s, telemetry=%s, region=%s, config=%s).",
            tag,
            "ok" if status is not None else "mancante",
            "ok" if neighbours is not None else "mancante",
            "ok" if telemetry is not None else "mancante",
            "ok" if region is not None else "mancante",
            "ok" if config is not None else "mancante"
        )

        return {
            "public_key": public_key,
            "adv_name": adv_name,
            "status": status,
            "neighbours": neighbours,
            "telemetry": telemetry,
            "region": region,
            "config": config
        }

    async def _query_cli_config(self, public_key, tag):
        """
        Login (password vuota — confermato empiricamente sufficiente
        quando il richiedente ha già il bit admin nell'ACL, vedi
        docs/NEIGHBOR_MONITORING.md §12) seguito dai comandi CLI
        testuali di CLI_QUERIES, poi logout esplicito a fine sessione
        indipendentemente da quali comandi siano riusciti.

        Ritorna un dict con tutte le chiavi di CLI_QUERIES, ciascuna
        a None se quel singolo comando non ha ricevuto risposta —
        MAI un'assunzione che il comando non esista: su LoRa un
        mancato invio è normale amministrazione, non un'anomalia
        (confermato da un caso reale: path_hash_mode risultava
        assente in un giro, presente subito dopo via app).

        Ritorna None solo se il login stesso fallisce — senza una
        sessione attiva nessun comando ha senso di essere tentato.
        """

        try:
            login_result = await self.engine.mesh.commands.send_login_sync(
                public_key,
                "",
                timeout=CLI_RESPONSE_TIMEOUT
            )

        except Exception:

            log.exception(
                "NEIGHBOR_MONITOR: %s send_login_sync() fallita.",
                tag
            )

            return None

        if login_result is None:

            log.warning(
                "NEIGHBOR_MONITOR: %s login fallito (nessuna "
                "risposta — timeout radio, o il richiedente non ha "
                "il bit admin nell'ACL: indistinguibili a questo "
                "livello). Comandi CLI saltati.",
                tag
            )

            return None

        log.info(
            "NEIGHBOR_MONITOR: %s login riuscito (permissions=%s).",
            tag,
            login_result.payload.get("permissions")
        )

        result = {}

        for key, cmd_text, value_type in CLI_QUERIES:

            result[key] = await self._send_cli_command(
                public_key,
                tag,
                key,
                cmd_text,
                value_type
            )

        try:
            await self.engine.mesh.commands.send_logout(
                public_key
            )

        except Exception:

            #
            # Non blocca il risultato già ottenuto — il logout è
            # igiene della sessione, non condiziona la validità dei
            # dati appena raccolti.
            #
            log.exception(
                "NEIGHBOR_MONITOR: %s send_logout() fallita (dati "
                "comunque validi).",
                tag
            )

        return result

    async def _send_cli_command(
        self,
        public_key,
        tag,
        key,
        cmd_text,
        value_type
    ):
        """
        Un singolo comando CLI: invio + attesa della risposta con lo
        stesso schema validato empiricamente (wait_for_event
        MESSAGES_WAITING poi get_msg()). None su qualunque esito non
        riuscito — mai un'eccezione che risalga a _query_cli_config(),
        un comando fallito non deve impedire i successivi.
        """

        try:
            send_result = await self.engine.mesh.commands.send_cmd(
                public_key,
                cmd_text
            )

            if send_result.type == EventType.ERROR:

                log.warning(
                    "NEIGHBOR_MONITOR: %s invio '%s' fallito "
                    "localmente.",
                    tag,
                    cmd_text
                )

                return None

            await asyncio.wait_for(
                self.engine.mesh.wait_for_event(
                    EventType.MESSAGES_WAITING
                ),
                timeout=CLI_RESPONSE_TIMEOUT
            )

            msg_event = await self.engine.mesh.commands.get_msg()

            raw_text = msg_event.payload.get("text", "")

            #
            # Le risposte numeriche arrivano con un prefisso "> "
            # (echo in stile CLI) — la versione firmware no.
            # Confermato nel test reale (exp09).
            #
            cleaned = raw_text.lstrip(">").strip()

            return value_type(cleaned)

        except asyncio.TimeoutError:

            log.warning(
                "NEIGHBOR_MONITOR: %s '%s' nessuna risposta entro "
                "%ss — normale su LoRa, non implica che il comando "
                "non esista.",
                tag,
                cmd_text,
                CLI_RESPONSE_TIMEOUT
            )

            return None

        except Exception:

            log.exception(
                "NEIGHBOR_MONITOR: %s '%s' fallito durante il "
                "parsing della risposta.",
                tag,
                cmd_text
            )

            return None

    def _resolve_contact(self, repeater_name):
        """
        Cerca repeater_name (match esatto su adv_name) tra i
        contatti attualmente in cache sulla libreria — popolata
        dalla get_contacts() appena eseguita in query().
        """

        try:
            contacts = self.engine.mesh.contacts

        except AttributeError:
            return None

        for c in contacts.values():

            if c.get("adv_name") == repeater_name:
                return c

        return None
