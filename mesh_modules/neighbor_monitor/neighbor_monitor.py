import asyncio

from core.config import config
from core.logger import log

from meshcore.events import EventType


def _parse_percent(raw):
    """
    Conversione per 'get dutycycle' — a differenza degli altri
    comandi numerici, la risposta reale include un suffisso '%'
    (confermato empiricamente sul campo, 2026-08-18: '10.0%', non
    '10.0' come gli altri valori numerici). Il valore viene
    memorizzato come numero puro (10.0, non 10.0/100) — è il
    firmware stesso a esprimerlo già in percentuale, non una
    frazione — il '%' è solo notazione di visualizzazione, aggiunta
    di nuovo lato frontend.
    """

    return float(raw.rstrip("%").strip())


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
    ("hardware", "board", str),
    ("path_hash_mode", "get path.hash.mode", int),
    ("txdelay", "get txdelay", float),
    ("direct_txdelay", "get direct.txdelay", float),
    ("rxdelay", "get rxdelay", float),
    ("flood_max", "get flood.max", int),
    ("flood_max_unscoped", "get flood.max.unscoped", int),
    ("flood_max_advert", "get flood.max.advert", int),
    ("region_default", "region default", str),
    ("dutycycle", "get dutycycle", _parse_percent),
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
    Interroga un repeater remoto per status, neighbours, telemetria,
    regioni supportate e scarto orologio, via richieste dirette
    (req_status_sync/fetch_all_neighbours/req_telemetry_sync/
    req_regions_sync/req_basic_sync) — non trace/advert. Vedi
    docs/NEIGHBOR_MONITORING.md.

    Legge l'istanza MeshCore corrente dinamicamente da Engine ad
    ogni chiamata, come TraceModule/ContactSyncModule — nessuna
    copia locale, resta valido dopo una riconnessione completa.

    Nessun lock esplicito qui dentro: come TraceModule, si affida al
    fatto che IPCServer.handle_client() avvolge l'intero dispatch()
    (quindi anche get_contacts()+req_status_sync()+
    fetch_all_neighbours()+req_telemetry_sync()+req_regions_sync()+
    req_basic_sync() in sequenza) in Engine.command_lock.
    """

    def __init__(self, engine):
        self.engine = engine

        #
        # Tentativi totali per singola interrogazione radio (1 =
        # nessun retry, comportamento precedente). Globale per tutte
        # le richieste (status/neighbours/telemetry/region/login/CLI)
        # — vedi neighbor_monitoring.max_retries in config.yaml.
        #
        self.max_retries = max(
            1,
            int(config.get("neighbor_monitoring.max_retries", 3))
        )

    async def _call_with_retries(self, tag, label, factory):
        """
        Esegue factory() (una funzione richiamabile più volte, che
        ritorna una nuova coroutine ad ogni chiamata — necessario per
        poter rilanciare la STESSA richiesta) fino a self.max_retries
        tentativi, fermandosi al primo risultato diverso da None.

        Un'eccezione durante un tentativo è trattata come fallimento
        di quel solo tentativo (stesso principio già in uso in questo
        modulo: un'eccezione o un timeout su LoRa non provano che la
        richiesta non esista, vanno ritentati come un timeout
        qualunque) — non propaga, non interrompe il ciclo.

        Ritorna l'ultimo risultato ottenuto, quindi None se anche
        l'ultimo tentativo è fallito. Il chiamante resta responsabile
        del log finale specifico (stesso messaggio "nessuna risposta
        a X" di prima) quando il risultato è None.
        """

        result = None

        for attempt in range(1, self.max_retries + 1):

            try:
                result = await factory()

            except Exception:

                log.exception(
                    "NEIGHBOR_MONITOR: %s %s fallita (tentativo "
                    "%d/%d).",
                    tag,
                    label,
                    attempt,
                    self.max_retries
                )

                result = None

            if result is not None:

                if attempt > 1:

                    log.info(
                        "NEIGHBOR_MONITOR: %s %s riuscita al "
                        "tentativo %d/%d.",
                        tag,
                        label,
                        attempt,
                        self.max_retries
                    )

                return result

            if attempt < self.max_retries:

                log.info(
                    "NEIGHBOR_MONITOR: %s %s nessuna risposta "
                    "(tentativo %d/%d), riprovo subito.",
                    tag,
                    label,
                    attempt,
                    self.max_retries
                )

        return result

    async def query(self, repeater_name):
        """
        Risolve repeater_name in chiave pubblica via get_contacts(),
        poi interroga status, neighbours, telemetria, regioni e
        scarto orologio in sequenza.

        Ritorna None su qualunque fallimento (repeater non trovato
        nella lista contatti, timeout, permesso ACL mancante) —
        questi ultimi due sono indistinguibili a livello di
        libreria, vedi docs/NEIGHBOR_MONITORING.md §2. Il dettaglio
        va solo nei log, mai nella risposta IPC — stesso principio
        già adottato altrove nel progetto (!meteo, !status).

        Se anche solo una delle cinque richieste va a buon fine, il
        risultato viene comunque restituito con i campi mancanti a
        None — meglio un dato parziale che nessun dato, dato che
        sono richieste radio indipendenti. Nota: req_regions_sync()
        e req_basic_sync() non richiedono ACL (AnonReqType, non
        BinaryReqType come le altre tre) — possono quindi riuscire
        anche quando status/neighbours/telemetry falliscono per un
        problema ACL, non solo per un timeout radio genuino.
        """

        tag = f"[repeater:{repeater_name}]"

        if not self.engine.connected:

            log.warning(
                "NEIGHBOR_MONITOR: %s connessione non attiva, "
                "query annullata.",
                tag
            )

            return None

        contacts_ok = False

        for attempt in range(1, self.max_retries + 1):

            try:
                await self.engine.mesh.commands.get_contacts()
                contacts_ok = True

                if attempt > 1:

                    log.info(
                        "NEIGHBOR_MONITOR: %s get_contacts() riuscita "
                        "al tentativo %d/%d.",
                        tag,
                        attempt,
                        self.max_retries
                    )

                break

            except Exception:

                log.exception(
                    "NEIGHBOR_MONITOR: %s get_contacts() fallita "
                    "(tentativo %d/%d).",
                    tag,
                    attempt,
                    self.max_retries
                )

                if attempt < self.max_retries:

                    log.info(
                        "NEIGHBOR_MONITOR: %s get_contacts() riprovo "
                        "subito.",
                        tag
                    )

        if not contacts_ok:

            log.warning(
                "NEIGHBOR_MONITOR: %s get_contacts() fallita dopo %d "
                "tentativi, query annullata.",
                tag,
                self.max_retries
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

        status = await self._call_with_retries(
            tag,
            "req_status_sync",
            lambda: self.engine.mesh.commands.req_status_sync(public_key)
        )

        if status is None:

            log.warning(
                "NEIGHBOR_MONITOR: %s nessuna risposta a req_status "
                "dopo %d tentativi (timeout, o permesso ACL mancante "
                "— indistinguibili a questo livello).",
                tag,
                self.max_retries
            )

        neighbours = await self._call_with_retries(
            tag,
            "fetch_all_neighbours",
            lambda: self.engine.mesh.commands.fetch_all_neighbours(public_key)
        )

        if neighbours is None:

            log.warning(
                "NEIGHBOR_MONITOR: %s nessuna risposta a "
                "req_neighbours dopo %d tentativi (timeout, o "
                "permesso ACL mancante — indistinguibili a questo "
                "livello).",
                tag,
                self.max_retries
            )

        telemetry = await self._call_with_retries(
            tag,
            "req_telemetry_sync",
            lambda: self.engine.mesh.commands.req_telemetry_sync(public_key)
        )

        if telemetry is None:

            log.warning(
                "NEIGHBOR_MONITOR: %s nessuna risposta a "
                "req_telemetry dopo %d tentativi (timeout, o "
                "permesso ACL mancante — indistinguibili a questo "
                "livello).",
                tag,
                self.max_retries
            )

        region = await self._call_with_retries(
            tag,
            "req_regions_sync",
            lambda: self.engine.mesh.commands.req_regions_sync(public_key)
        )

        if region is None:

            log.warning(
                "NEIGHBOR_MONITOR: %s nessuna risposta a req_regions "
                "dopo %d tentativi (nessun ACL richiesto per questa "
                "richiesta — un fallimento qui è più probabilmente "
                "un timeout radio genuino che un problema di "
                "permessi).",
                tag,
                self.max_retries
            )

        clock = None

        raw_clock = await self._call_with_retries(
            tag,
            "req_basic_sync",
            lambda: self.engine.mesh.commands.req_basic_sync(public_key)
        )

        if raw_clock is None:

            log.warning(
                "NEIGHBOR_MONITOR: %s nessuna risposta a req_basic "
                "dopo %d tentativi (nessun ACL richiesto per questa "
                "richiesta — un fallimento qui è più probabilmente "
                "un timeout radio genuino che un problema di "
                "permessi).",
                tag,
                self.max_retries
            )

        else:

            #
            # Il clock del repeater è nei byte [0:4] di 'data',
            # little-endian uint32 (epoch secondi) — non ancora
            # esposto/decodificato da meshcore_py, va fatto qui.
            # Offset confermato empiricamente sul campo (log
            # diagnostico con dump byte grezzi + doppia
            # interpretazione, 2026-08-17): l'ipotesi iniziale [4:8]
            # da analisi statica del firmware era sbagliata, dava
            # uno scarto di ~56 anni. Un payload troppo corto non
            # solleva da solo (lo slicing di bytes non fallisce,
            # produce solo meno byte) — il controllo esplicito di
            # lunghezza evita di calcolare uno scarto senza senso da
            # un payload malformato invece di segnalarlo.
            #
            try:
                raw_bytes = bytes.fromhex(raw_clock.get("data", ""))

                if len(raw_bytes) < 4:
                    raise ValueError(
                        f"payload troppo corto ({len(raw_bytes)} byte)"
                    )

                remote_clock = int.from_bytes(raw_bytes[0:4], "little")
                clock = {"remote_clock": remote_clock}

            except (ValueError, TypeError, AttributeError):

                log.warning(
                    "NEIGHBOR_MONITOR: %s risposta req_basic non "
                    "decodificabile.",
                    tag,
                    exc_info=True
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
            clock is None and
            config is None
        ):
            return None

        log.info(
            "NEIGHBOR_MONITOR: %s query completata (status=%s, "
            "neighbours=%s, telemetry=%s, region=%s, clock=%s, "
            "config=%s).",
            tag,
            "ok" if status is not None else "mancante",
            "ok" if neighbours is not None else "mancante",
            "ok" if telemetry is not None else "mancante",
            "ok" if region is not None else "mancante",
            "ok" if clock is not None else "mancante",
            "ok" if config is not None else "mancante"
        )

        return {
            "public_key": public_key,
            "adv_name": adv_name,
            "status": status,
            "neighbours": neighbours,
            "telemetry": telemetry,
            "region": region,
            "clock": clock,
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

        Per tutta la durata della funzione, public_key resta
        registrata in Engine.active_cli_sessions (try/finally, così
        la rimozione avviene sempre, anche sulle uscite anticipate) —
        le risposte a login/comandi arrivano come CONTACT_MSG_RECV,
        lo stesso evento delle DM vere: senza questo registro
        BotModule non avrebbe modo di distinguerle (vedi
        BotModule._on_contact_message()).
        """

        self.engine.mark_cli_session_active(public_key)

        try:

            login_result = await self._call_with_retries(
                tag,
                "send_login_sync",
                lambda: self.engine.mesh.commands.send_login_sync(
                    public_key,
                    "",
                    timeout=CLI_RESPONSE_TIMEOUT
                )
            )

            if login_result is None:

                log.warning(
                    "NEIGHBOR_MONITOR: %s login fallito dopo %d "
                    "tentativi (nessuna risposta — timeout radio, o "
                    "il richiedente non ha il bit admin nell'ACL: "
                    "indistinguibili a questo livello). Comandi CLI "
                    "saltati.",
                    tag,
                    self.max_retries
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

        finally:

            self.engine.mark_cli_session_done(public_key)

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
        MESSAGES_WAITING poi get_msg()). Rieseguito fino a
        self.max_retries tentativi in caso di fallimento (invio
        locale, timeout, o errore di parsing) — None solo se anche
        l'ultimo tentativo fallisce. Mai un'eccezione che risalga a
        _query_cli_config(), un comando fallito non deve impedire i
        successivi.

        La coda messaggi in ingresso non è isolata per contatto: un
        qualunque traffico mesh non correlato (advert, DM di altri
        nodi, elenco neighbours di terzi) può arrivare nella stessa
        finestra e viene scartato da _wait_for_own_response() tramite
        il confronto su pubkey_prefix — stesso campo già usato da
        BotModule._on_contact_message() per il filtro complementare
        (vedi Engine.active_cli_sessions). Scoperto da un caso reale
        sul campo: 'get flood.max.advert' falliva il parsing perché
        get_msg() restituiva testo di un advert/neighbours estraneo,
        non la risposta al comando appena inviato.
        """

        async def _wait_for_own_response():

            while True:

                await self.engine.mesh.wait_for_event(
                    EventType.MESSAGES_WAITING
                )

                msg_event = await self.engine.mesh.commands.get_msg()

                sender_prefix = msg_event.payload.get("pubkey_prefix")

                if sender_prefix and public_key.startswith(sender_prefix):
                    return msg_event

                log.info(
                    "NEIGHBOR_MONITOR: %s '%s' messaggio spurio "
                    "scartato (da %s, non dal repeater interrogato) "
                    "durante l'attesa della risposta.",
                    tag,
                    cmd_text,
                    sender_prefix or "mittente sconosciuto"
                )

        for attempt in range(1, self.max_retries + 1):

            try:
                send_result = await self.engine.mesh.commands.send_cmd(
                    public_key,
                    cmd_text
                )

                if send_result.type == EventType.ERROR:

                    log.warning(
                        "NEIGHBOR_MONITOR: %s invio '%s' fallito "
                        "localmente (tentativo %d/%d).",
                        tag,
                        cmd_text,
                        attempt,
                        self.max_retries
                    )

                else:

                    msg_event = await asyncio.wait_for(
                        _wait_for_own_response(),
                        timeout=CLI_RESPONSE_TIMEOUT
                    )

                    raw_text = msg_event.payload.get("text", "")

                    #
                    # Le risposte numeriche arrivano con un prefisso
                    # "> " (echo in stile CLI) — la versione firmware
                    # no. Confermato nel test reale (exp09).
                    #
                    cleaned = raw_text.lstrip(">").strip()

                    value = value_type(cleaned)

                    if attempt > 1:

                        log.info(
                            "NEIGHBOR_MONITOR: %s '%s' riuscita al "
                            "tentativo %d/%d.",
                            tag,
                            cmd_text,
                            attempt,
                            self.max_retries
                        )

                    return value

            except asyncio.TimeoutError:

                log.warning(
                    "NEIGHBOR_MONITOR: %s '%s' nessuna risposta entro "
                    "%ss (tentativo %d/%d) — normale su LoRa, non "
                    "implica che il comando non esista.",
                    tag,
                    cmd_text,
                    CLI_RESPONSE_TIMEOUT,
                    attempt,
                    self.max_retries
                )

            except Exception:

                log.exception(
                    "NEIGHBOR_MONITOR: %s '%s' fallito durante il "
                    "parsing della risposta (tentativo %d/%d).",
                    tag,
                    cmd_text,
                    attempt,
                    self.max_retries
                )

            if attempt < self.max_retries:

                log.info(
                    "NEIGHBOR_MONITOR: %s '%s' riprovo subito.",
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
