import asyncio
import time

from core.config import config
from core.logger import log
from core.contact_lookup import find_contact_by_name
from core.event_correlation import wait_for_matching_event

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

#
# Soglia di durata oltre la quale query() segnala un WARNING invece
# del solito INFO (code review 2026-08-20, Rev.6 — discussione con
# l'utente sul worst-case teorico del lock condiviso: chi gestisce
# trace-mon gestisce anche l'elenco dei repeater da interrogare, non
# è una condizione generica e imprevedibile — un repeater che non
# risponde più può essere rimosso da neighbor_monitoring.repeaters
# dall'operatore stesso, ma solo se se ne accorge). Non cambia alcun
# comportamento (nessun timeout aggiuntivo, nessun'interruzione
# anticipata) — segnala soltanto, a consuntivo, che quella
# interrogazione ha impiegato più del previsto, così l'operatore ha
# un segnale concreto nei log invece di dover notare l'assenza di
# nuovi dati o ricalcolare a mano il worst-case teorico. 120s scelto
# perché ampiamente sopra la durata normale (un giro completo di 17
# richieste con risposte pronte impiega tipicamente sotto il minuto,
# v. commento sopra) ma una piccola frazione del worst-case teorico
# con max_retries=3 (fino a ~510s per un'interruzione totale e
# sostenuta) — un margine sufficiente a non generare falsi allarmi su
# normali fluttuazioni radio (un singolo retry isolato aggiunge al
# più CLI_RESPONSE_TIMEOUT=10s), ma abbastanza basso da avvisare ben
# prima che la campagna raggiunga il caso limite.
#
SLOW_QUERY_WARNING_THRESHOLD = 120.0


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

    def _warn_if_slow(self, tag, start_time):
        """
        V. SLOW_QUERY_WARNING_THRESHOLD in cima al file — segnala,
        SOLO nei log (nessun cambiamento di comportamento), quando
        un'interrogazione ha impiegato più del limite di attenzione.
        Richiamata da entrambi i punti di uscita di query() (fallimento
        totale e successo, parziale o completo) così l'operatore vede
        il segnale in ogni caso, non solo quando la query riesce.
        """

        elapsed = time.monotonic() - start_time

        if elapsed < SLOW_QUERY_WARNING_THRESHOLD:
            return

        log.warning(
            "NEIGHBOR_MONITOR: %s interrogazione completata in %.0fs "
            "(soglia di attenzione: %.0fs) — possibile problema di "
            "raggiungibilità radio prolungato su questo repeater. Se "
            "non è più di interesse, valutare di rimuoverlo da "
            "neighbor_monitoring.repeaters in config.yaml per evitare "
            "che interrogazioni ripetutamente lente rosicchino il "
            "margine verso il prossimo trace.sh.",
            tag,
            elapsed,
            SLOW_QUERY_WARNING_THRESHOLD
        )

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

        #
        # v. SLOW_QUERY_WARNING_THRESHOLD sopra — misura la durata
        # dell'intera interrogazione (dalla risoluzione del contatto
        # alla fine, inclusi tutti i retry di tutte le 17 richieste)
        # per poterla confrontare col limite di attenzione ad ogni
        # punto di uscita della funzione, riuscito o fallito.
        #
        start_time = time.monotonic()

        if not self.engine.connected:

            log.warning(
                "NEIGHBOR_MONITOR: %s connessione non attiva, "
                "query annullata.",
                tag
            )

            return None

        contacts_ok = False

        #
        # get_contacts() (a differenza dei comandi "_sync" interrogati
        # più sotto in questo stesso metodo) non è pre-unwrappata
        # dalla libreria: su timeout/fallimento non solleva mai
        # un'eccezione, ritorna un Event(ERROR, ...) grezzo
        # (verificato leggendo meshcore_py/commands/contact.py — code
        # review 2026-08-20, audit successivo al Finding 2 di una
        # review indipendente). Il solo except Exception sotto non lo
        # intercettava mai: il PRIMO tentativo veniva sempre
        # considerato riuscito, anche quando il device non aveva
        # risposto — il meccanismo di retry, costruito apposta per
        # get_contacts(), non scattava mai per la sua causa di
        # fallimento più diretta.
        #
        for attempt in range(1, self.max_retries + 1):

            try:
                result = await self.engine.mesh.commands.get_contacts()

                if result.type == EventType.ERROR:

                    log.warning(
                        "NEIGHBOR_MONITOR: %s get_contacts() fallita "
                        "(%s) (tentativo %d/%d).",
                        tag,
                        result.payload,
                        attempt,
                        self.max_retries
                    )

                    if attempt < self.max_retries:

                        log.info(
                            "NEIGHBOR_MONITOR: %s get_contacts() "
                            "riprovo subito.",
                            tag
                        )

                    continue

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

        #
        # Nome locale deliberatamente diverso da "config" — quel nome
        # resta il termine di dominio per questa categoria di
        # risultato in tutto il resto del modulo (chiave del dict
        # restituito, tabella repeater_config, sezione frontend
        # "Config", v. docs/NEIGHBOR_MONITORING.md §12, dove la
        # convenzione status/neighbours/telemetry/region/config è
        # stata scelta deliberatamente). Qui però "config" andrebbe
        # in shadowing di "from core.config import config" importato
        # in cima al file, per l'intera durata di query() — mai
        # notato nelle tre estensioni precedenti di questa funzione.
        # Rinominato (fix successivo a Rev.6, code review 2026-08-20)
        # per eliminare il rischio di un futuro UnboundLocalError se
        # questa funzione dovesse mai referenziare core.config.get(...)
        # in un punto qualsiasi, anche prima di questa riga. Nessun
        # cambiamento di comportamento: la chiave "config" nel dict
        # restituito da query() resta invariata.
        #
        cli_config = await self._query_cli_config(
            public_key,
            tag
        )

        #
        # Segnalazione "collegamento probabilmente perso" (richiesta
        # utente 2026-08-20) — distinta da SLOW_QUERY_WARNING_THRESHOLD
        # (quello segnala QUANTO ha impiegato una query lenta ma
        # comunque parzialmente riuscita; questo segnala che NESSUNA
        # delle due categorie di richiesta ha prodotto risposta:
        # né le 5 che non richiedono login (status/neighbours/
        # telemetry/region/clock) né la sessione CLI protetta da
        # login). È il segnale più forte di irraggiungibilità
        # radio del repeater, da distinguere da un fallimento isolato
        # su una singola richiesta (già segnalato punto per punto dai
        # warning esistenti sopra, e dal nuovo warning per-comando in
        # _query_cli_config()).
        #
        # `no_login_group_failed` riusa esattamente la stessa
        # condizione già presente nel return None sotto (nessun
        # cambiamento di comportamento). `config_all_failed` è invece
        # più ampia della sola `config is None` usata dal return:
        # copre anche il caso in cui il login sia riuscito ma OGNI
        # singolo comando CLI_QUERIES sia fallito (config è allora un
        # dict con tutti i valori a None, non None stesso) — un caso
        # che il return esistente non intercetta, ma che ai fini di
        # QUESTO log conta comunque come "categoria login fallita per
        # intero". Usata solo per il log: non altera in alcun modo
        # cosa query() restituisce.
        #
        no_login_group_failed = (
            status is None and
            neighbours is None and
            telemetry is None and
            region is None and
            clock is None
        )

        config_all_failed = (
            cli_config is None or
            (
                isinstance(cli_config, dict) and
                all(v is None for v in cli_config.values())
            )
        )

        if no_login_group_failed and config_all_failed:

            log.warning(
                "NEIGHBOR_MONITOR: %s nessuna risposta a NESSUNA "
                "richiesta in questo giro — né alle richieste senza "
                "bisogno di login (status/neighbours/telemetry/"
                "region/clock) né a quelle della sessione CLI — "
                "probabile perdita del collegamento radio con "
                "questo repeater, non un fallimento isolato su una "
                "singola richiesta.",
                tag
            )

        if no_login_group_failed and cli_config is None:
            self._warn_if_slow(tag, start_time)
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
            "ok" if cli_config is not None else "mancante"
        )

        self._warn_if_slow(tag, start_time)

        return {
            "public_key": public_key,
            "adv_name": adv_name,
            "status": status,
            "neighbours": neighbours,
            "telemetry": telemetry,
            "region": region,
            "clock": clock,
            "config": cli_config
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

        mark_cli_session_active()/done() sono ATTESE esplicitamente
        (Finding 3, 2026-08-21 — v. ARCHITECTURE.md §48): l'attesa su
        mark_cli_session_active() garantisce che l'eventuale
        sospensione dell'auto-fetch del bot (il vero scopo della
        registrazione, non solo la classificazione già esistente in
        BotModule._on_contact_message()) sia effettiva PRIMA che
        send_login_sync() invii il primo comando — altrimenti
        l'auto-fetch del bot potrebbe ancora "vincere" la corsa su
        get_msg() per la risposta al login, la stessa race che questo
        fix esiste per chiudere.
        """

        await self.engine.mark_cli_session_active(public_key)

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

                #
                # Segnalazione per-comando al raggiungimento del
                # max_retries (richiesta utente 2026-08-20) — stesso
                # principio già in uso per le 5 richieste binarie/
                # anonime e per il login (un log.warning dal
                # chiamante quando l'esito finale è None), mancante
                # finora per i singoli CLI_QUERIES: _send_cli_command()
                # logga già ogni tentativo fallito, ma non c'era una
                # riga consolidata che confermasse l'esaurimento dei
                # tentativi per QUESTO comando specifico. Utile per
                # distinguere un fallimento isolato di un comando
                # (fenomeno occasionale, normale su LoRa) da un
                # pattern ripetuto sullo stesso comando in giri
                # successivi (sintomo di un problema più specifico).
                # Nessun cambiamento di comportamento: result[key]
                # resta None come prima, nessun retry aggiuntivo.
                #
                if result[key] is None:

                    log.warning(
                        "NEIGHBOR_MONITOR: %s '%s' fallito dopo %d "
                        "tentativi (nessuna risposta valida "
                        "ricevuta) — comando saltato per questo "
                        "giro, valore risultante None.",
                        tag,
                        cmd_text,
                        self.max_retries
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

            await self.engine.mark_cli_session_done(public_key)

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

        #
        # get_next()/is_match() qui sotto usano wait_for_matching_event()
        # condiviso con TraceModule (code review 2026-08-20, §3.2) —
        # v. core/event_correlation.py. La finestra di timeout
        # complessiva è gestita dall'helper stesso, non più da un
        # asyncio.wait_for esterno.
        #
        async def _get_next_message():

            await self.engine.mesh.wait_for_event(
                EventType.MESSAGES_WAITING
            )

            return await self.engine.mesh.commands.get_msg()

        def _is_own_response(msg_event):

            sender_prefix = msg_event.payload.get("pubkey_prefix")

            return bool(
                sender_prefix and
                public_key.startswith(sender_prefix)
            )

        def _on_discard(msg_event):

            sender_prefix = msg_event.payload.get("pubkey_prefix")

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

                    msg_event = await wait_for_matching_event(
                        get_next=_get_next_message,
                        is_match=_is_own_response,
                        timeout=CLI_RESPONSE_TIMEOUT,
                        on_discard=_on_discard
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
        Cerca repeater_name (match case-sensitive esatto su
        adv_name, nessun fallback per sottostringa — v.
        core/contact_lookup.py per la motivazione) tra i contatti
        attualmente in cache sulla libreria — popolata dalla
        get_contacts() appena eseguita in query().
        """

        try:
            contacts = self.engine.mesh.contacts

        except AttributeError:
            return None

        return find_contact_by_name(
            contacts,
            repeater_name,
            allow_substring=False,
            case_sensitive=True
        )
