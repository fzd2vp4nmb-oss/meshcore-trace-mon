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
# Timeout per il polling LOCALE della coda messaggi in
# _drain_pending_messages() (rimedio definitivo alla contaminazione
# incrociata tra risposte CLI, 2026-08-22 — v.
# claude/finding-cross-command-cli-response-contamination-2026-08-22.md
# §15). NON è un'attesa via radio verso il repeater: get_msg()
# interroga solo il device collegato direttamente (seriale/BLE/TCP),
# che risponde in modo pressoché immediato con un messaggio già in
# coda o con NO_MORE_MSGS — un valore breve è quindi sufficiente e
# non introduce un rallentamento percepibile nel caso comune (coda
# già vuota, un solo giro). _DRAIN_MAX_ITERATIONS è un tetto di
# sicurezza puramente difensivo (mai osservato un backlog reale
# superiore a poche unità), per evitare un ciclo indefinito se il
# device si comportasse in modo anomalo.
#
_DRAIN_TIMEOUT = 3.0
_DRAIN_MAX_ITERATIONS = 20

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

    async def _drain_pending_messages(self, public_key, tag, context_label):
        """
        Svuota, per quanto possibile, la coda dei messaggi già in
        attesa sul device LOCALE (get_msg() diretto, non la
        subscription MESSAGES_WAITING/CONTACT_MSG_RECV usata da
        BotModule) — rimedio definitivo alla contaminazione incrociata
        tra risposte CLI, 2026-08-22 (v.
        claude/finding-cross-command-cli-response-contamination-2026-08-22.md
        §15, e docs/ARCHITECTURE.md/NEIGHBOR_MONITORING.md per
        l'analisi completa che ha portato a questo fix, inclusa la
        ricostruzione storica sui 18 giorni di log che ha escluso una
        regressione introdotta dalle modifiche del 2026-08-21).

        NON sostituisce i filtri su pubkey_prefix/formato in
        _send_cli_command() — li ANTICIPA: un residuo
        già seduto nella coda locale del device (risposta tardiva o
        duplicata di un comando precedente di QUESTA sessione, o
        persino della sessione PRECEDENTE contro lo stesso repeater —
        ipotesi coerente con l'anomalia osservata sul campo in cui
        'board' riceveva un valore ('default scope is it') che
        assomiglia alla risposta di 'region default', un comando
        molto più avanti nello stesso giro: solo un residuo
        proveniente dalla CODA di un giro precedente, non ancora
        consumato quando il giro successivo inizia con 'ver'/'board',
        spiega un salto così all'indietro nell'ordine dei comandi)
        viene qui scartato PRIMA che il prossimo send_cmd() venga
        inviato, così non può più essere confuso con la risposta al
        comando che sta per partire. Non elimina un residuo che arriva
        DOPO l'invio, durante l'attesa vera e propria — per quello
        restano i filtri in _send_cli_command()/_is_own_response() —
        ma riduce concretamente la finestra di contaminazione, l'unica
        parte del problema su cui il lato client ha reale controllo:
        il protocollo dei comandi CLI via login (send_cmd(), libreria
        meshcore_py commands/messaging.py) non porta alcun ID di
        correlazione nel pacchetto, a differenza di
        TraceModule.send_trace() (un 'tag' numerico incorporato
        esplicitamente) o di send_msg_with_retry() (correlazione via
        ACK — expected_ack/EventType.ACK). Senza un ID nel protocollo
        stesso, nessun filtro lato client può distinguere con certezza
        matematica una risposta CLI genuina da un residuo dallo stesso
        mittente con lo stesso txt_type — questo fix riduce il rischio,
        non lo azzera, ed è documentato onestamente come tale (v.
        docstring di _send_cli_command()).

        CORREZIONE (2026-08-22, notte — segnalazione diretta
        dell'utente su un log reale, v. finding doc §18): fino a
        questa correzione, il metodo trattava QUALUNQUE messaggio
        prelevato da get_msg() — CONTACT_MSG_RECV da un mittente
        qualsiasi, o perfino CHANNEL_MSG_RECV (messaggi del canale
        #bot) — come "residuo" della sessione CLI, senza mai
        verificare che venisse davvero dal repeater interrogato.
        L'utente ha giustamente contestato il criterio, ribadendo un
        principio del progetto valido dal giorno 0 (v.
        BotModule._on_contact_message(), che applica la regola
        SPECULARE: mai trattare come DM per il bot un messaggio il cui
        mittente è un repeater con sessione CLI attiva): un repeater
        non genera MAI un messaggio su un canale chat, né una DM
        diretta al bot di propria iniziativa — genera solo risposte
        dirette (CONTACT_MSG_RECV) al richiedente della sessione CLI.
        Di conseguenza, l'unico criterio corretto per "questo è
        plausibilmente un residuo della NOSTRA sessione CLI" è:
        CONTACT_MSG_RECV il cui pubkey_prefix corrisponde esattamente
        a public_key (il repeater interrogato in QUESTA sessione).
        Qualunque altro messaggio prelevato — CHANNEL_MSG_RECV di
        qualunque canale (mai possibile da un repeater: il payload
        CHANNEL_MSG_RECV, verificato sul sorgente reale della libreria
        meshcore, `reader.py`, non porta nemmeno un campo
        pubkey_prefix — non è un'omissione, è strutturale), o
        CONTACT_MSG_RECV da un contatto diverso dal repeater
        interrogato — non è "residuo" di nulla: è traffico locale
        ordinario che si trovava a transitare sulla stessa coda
        fisica del device nello stesso momento, per ragioni del tutto
        indipendenti da questa sessione CLI.

        Questo NON significa che tale traffico venga perso da
        BotModule. Verificato sul sorgente reale della libreria
        meshcore installata (non un'ipotesi): `reader.py::handle_rx()`
        chiama `dispatcher.dispatch(event)` in modo incondizionato per
        OGNI risposta del device, indipendentemente da quale chiamante
        abbia effettuato la richiesta get_msg() che l'ha originata;
        `EventDispatcher._process_events()` (`events.py`) inoltra poi
        quello stesso evento a TUTTE le sottoscrizioni attive che ne
        combaciano il tipo — e le sottoscrizioni di BotModule
        (`_on_channel_message`/`_on_contact_message`, registrate una
        sola volta in `_subscribe()`) restano sempre attive, MAI
        rimosse o sospese da `_auto_fetch_paused`: quel flag ferma
        solo il loop proprio di BotModule che chiamerebbe get_msg() di
        propria iniziativa (per non competere sulla richiesta con
        questa sessione CLI, v. Finding 3/ARCHITECTURE.md §48), non le
        sue sottoscrizioni al dispatcher condiviso. In pratica: un
        messaggio del canale #bot prelevato da QUESTO metodo viene
        comunque recapitato, in parallelo e indipendentemente, al
        gestore giusto di BotModule tramite lo stesso evento — questo
        metodo lo vede solo per decidere (ora correttamente) che non
        è rilevante per la CORRELAZIONE della risposta CLI, non lo
        sottrae a nessuno.

        Il criterio sopra, ora applicato esplicitamente riga per riga
        (non più per assenza accidentale di un campo), è esattamente
        quello richiesto dall'utente: "i messaggi che neighbor_monitor
        deve prendere in considerazione devono arrivare solo dal
        repeater interrogato" — lo stesso già in vigore, correttamente,
        in _is_own_response() (dove però funzionava per un effetto
        collaterale onesto ma implicito: pubkey_prefix è semplicemente
        assente sul payload CHANNEL_MSG_RECV, quindi il confronto
        falliva comunque — ora reso esplicito anche lì in questo
        stesso aggiornamento, non solo qui).

        get_msg() qui è una richiesta LOCALE al device collegato
        (seriale/BLE/TCP), non un round-trip LoRa: risponde in modo
        pressoché immediato con o un messaggio già in coda o
        NO_MORE_MSGS, indipendentemente dai tempi radio verso il
        repeater remoto — per questo _DRAIN_TIMEOUT può restare breve
        senza rallentare percettibilmente una sessione CLI normale (0
        messaggi da scartare nel caso comune, quindi un solo giro).

        Limite dichiarato onestamente (nuovo, reso visibile da questa
        correzione): _DRAIN_MAX_ITERATIONS conta OGNI messaggio
        prelevato, non solo i residui genuini — su un canale #bot
        molto attivo, un numero di messaggi di canale superiore al
        tetto potrebbe esaurire le iterazioni disponibili prima che il
        drain raggiunga un eventuale residuo CLI genuino più indietro
        nella coda, lasciandolo sul device per essere poi eventualmente
        intercettato dal filtro in _is_own_response()/_on_discard()
        durante l'attesa vera e propria (nessuna regressione rispetto
        a prima di questo fix, solo un limite pratico del tetto di
        sicurezza condiviso tra i due tipi di traffico).

        Best-effort per costruzione: qualunque eccezione qui viene
        loggata e la funzione ritorna silenziosamente, MAI propagata —
        uno svuotamento fallito non deve mai impedire l'invio del
        comando reale che segue. context_label è solo per i log,
        distingue la chiamata a inizio sessione (prima del login,
        contro un eventuale residuo della sessione precedente) da
        quella prima di ogni singolo comando CLI.
        """

        try:

            drained = 0

            for _ in range(_DRAIN_MAX_ITERATIONS):

                msg_event = await self.engine.mesh.commands.get_msg(
                    timeout=_DRAIN_TIMEOUT
                )

                if msg_event.type == EventType.NO_MORE_MSGS:
                    break

                if msg_event.type == EventType.ERROR:

                    log.debug(
                        "NEIGHBOR_MONITOR: %s svuotamento coda (%s) "
                        "interrotto (ERROR locale, non bloccante).",
                        tag,
                        context_label
                    )

                    break

                if msg_event.type in (
                    EventType.CONTACT_MSG_RECV,
                    EventType.CHANNEL_MSG_RECV
                ):

                    #
                    # Criterio forte, esplicito (correzione 2026-08-22
                    # notte, v. docstring sopra): solo un CONTACT_MSG_RECV
                    # il cui mittente è ESATTAMENTE il repeater
                    # interrogato in questa sessione conta come
                    # "residuo". CHANNEL_MSG_RECV non ha nemmeno un
                    # pubkey_prefix nel payload (v. libreria,
                    # reader.py) — un repeater non genera mai un
                    # messaggio di canale, quindi non può mai
                    # combaciare per costruzione.
                    #
                    pubkey_prefix = msg_event.payload.get("pubkey_prefix")

                    is_from_repeater = bool(
                        msg_event.type == EventType.CONTACT_MSG_RECV and
                        pubkey_prefix and
                        public_key.startswith(pubkey_prefix)
                    )

                    if is_from_repeater:

                        drained += 1

                        log.info(
                            "NEIGHBOR_MONITOR: %s svuotamento coda "
                            "(%s) — scartato messaggio residuo #%d "
                            "(da=%s txt_type=%r sender_timestamp=%r "
                            "testo=%r).",
                            tag,
                            context_label,
                            drained,
                            pubkey_prefix,
                            msg_event.payload.get("txt_type"),
                            msg_event.payload.get("sender_timestamp"),
                            msg_event.payload.get("text", "")[:80]
                        )

                    else:

                        #
                        # Non è un residuo della nostra sessione CLI —
                        # traffico locale ordinario (messaggio di
                        # canale, o DM di un contatto diverso dal
                        # repeater interrogato) che si trovava sulla
                        # stessa coda fisica del device. Livello DEBUG
                        # deliberato: non è un'anomalia, e questo
                        # prelievo non lo sottrae a BotModule (v.
                        # docstring — recapitato comunque tramite il
                        # dispatcher condiviso della libreria).
                        #
                        log.debug(
                            "NEIGHBOR_MONITOR: %s svuotamento coda "
                            "(%s) — attraversato (non scartato come "
                            "residuo, non pertinente a questa "
                            "sessione CLI) traffico locale di tipo=%s "
                            "da=%s txt_type=%r testo=%r.",
                            tag,
                            context_label,
                            msg_event.type,
                            pubkey_prefix or "n/d (messaggio di canale)",
                            msg_event.payload.get("txt_type"),
                            msg_event.payload.get("text", "")[:80]
                        )

                    continue

                #
                # Tipo evento non atteso da get_msg() in questo punto
                # (v. libreria, commands/messaging.py: solo
                # CONTACT_MSG_RECV/CHANNEL_MSG_RECV/ERROR/NO_MORE_MSGS
                # sono possibili) — non blocca, ma non ha senso
                # continuare a scartare qualcosa che non riconosciamo.
                #
                break

            if drained:

                log.info(
                    "NEIGHBOR_MONITOR: %s svuotamento coda (%s) "
                    "completato: %d messaggio/i residuo/i scartato/i "
                    "prima dell'invio.",
                    tag,
                    context_label,
                    drained
                )

        except Exception:

            log.warning(
                "NEIGHBOR_MONITOR: %s svuotamento coda (%s) fallito "
                "(non bloccante, il comando viene comunque inviato).",
                tag,
                context_label,
                exc_info=True
            )

    async def _query_cli_config(self, public_key, tag):
        """
        Login (password vuota — confermato empiricamente sufficiente
        quando il richiedente ha già il bit admin nell'ACL, vedi
        docs/NEIGHBOR_MONITORING.md §12) seguito dai comandi CLI
        testuali di CLI_QUERIES, poi logout esplicito a fine sessione
        indipendentemente da quali comandi siano riusciti.

        RIMEDIO DEFINITIVO (2026-08-22, sera — v.
        claude/finding-cross-command-cli-response-contamination-2026-08-22.md
        §11-§15): l'analisi storica completa dei log (18 giorni) ha
        escluso una regressione introdotta dalle modifiche del
        2026-08-21 — il fenomeno è presente fin dall'11-08, segue un
        pattern giornaliero a finestra oraria tipico di una causa
        esterna (traffico/carico radio), non di un bug di codice
        introdotto in un momento preciso — e l'indagine sul firmware
        reale (docs/FIRMWARE_ANALYSIS.md §11.2) ha spiegato perché il
        primo fix (ordine cronologico via sender_timestamp, v. sotto)
        si è rivelato inefficace sul campo: il Companion sostituisce
        sender_timestamp con il proprio RTC ad ogni trasmissione/
        ritrasmissione di un messaggio CLI, rendendolo un indicatore
        di QUANDO il pacchetto è stato spedito l'ultima volta, non di
        QUALE comando risponda — per costruzione inutile per ordinare
        risposte CLI tra loro. Il rimedio adottato ora è a più strati,
        deliberatamente NON basato su quell'ipotesi smentita:
        svuotamento esplicito della coda locale prima del login (sotto)
        e prima di ogni singolo comando (_drain_pending_messages(),
        chiamato da _send_cli_command()), più un controllo di
        plausibilità sul FORMATO del contenuto integrato nel filtro di
        match stesso (_is_own_response()) — v. docstring di
        _send_cli_command() per il dettaglio completo, inclusa la
        limitazione onestamente residua sui tre comandi a testo libero.

        AGGIORNAMENTO (2026-08-22, notte — decisione esplicita
        dell'utente, v. finding doc §17): il filtro cronologico via
        sender_timestamp ("Option A", il primo tentativo di fix,
        citato sopra) è stato RIMOSSO dal codice, non solo lasciato
        inattivo — non svolgeva alcuna funzione reale (dimostrato
        inefficace dall'analisi firmware E da due run reali senza un
        solo scarto "RESIDUO"), e tenere in vita codice morto sulla
        base di un'ipotesi futura non verificabile ("un domani il
        firmware potrebbe cambiare") è stato esplicitamente rifiutato:
        non c'è più uno stato di sessione condiviso tra le chiamate a
        _send_cli_command() (niente più cli_session_state, niente
        parametro aggiuntivo passato al metodo). Restano attivi solo i
        due livelli validati contro il protocollo/firmware reale:
        svuotamento della coda locale e controllo di plausibilità sul
        formato. Lo stato del problema NON è dichiarato risolto al
        100%: l'utente ha osservato che nelle proprie esecuzioni
        manuali precedenti il fenomeno non si era mai presentato, a
        differenza del giorno in cui è stato diagnosticato — un punto
        che l'utente considera ancora da chiarire, non spiegato in modo
        per loro convincente solo dal pattern orario nei log storici.
        Il monitoraggio prosegue con esecuzioni più frequenti di
        neighbor_monitor per raccogliere ulteriore evidenza prima di
        considerare la questione chiusa — v. finding doc §17 per il
        testo completo della decisione.

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

            #
            # Rimedio definitivo, 2026-08-22 — v. docstring del
            # metodo e di _drain_pending_messages(): svuota un
            # eventuale residuo lasciato in coda dalla sessione CLI
            # PRECEDENTE contro questo stesso repeater, prima ancora
            # di tentare il login di QUESTA sessione.
            #
            await self._drain_pending_messages(
                public_key,
                tag,
                "inizio sessione, prima del login"
            )

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

        Il filtro solo-per-mittente (_is_own_response, sotto) accetta
        come "nostra risposta" qualunque messaggio dal repeater giusto
        al primo turno utile, a prescindere da QUANDO quel messaggio
        sia stato davvero generato dal repeater — un residuo (arrivato
        in ritardo, o duplicato da una ritrasmissione LoRa) di un
        comando precedente della stessa sessione viene quindi accettato
        come risposta al comando appena inviato, con un ValueError
        visibile se il cast fallisce, o — più insidioso — un valore
        sbagliato scritto silenziosamente in contacts.db se il cast
        riesce comunque.

        STORIA — "Option A" (2026-08-22, primo tentativo, RIMOSSA la
        sera dello stesso giorno, v. AGGIORNAMENTO più sotto e finding
        doc §17): il primo fix tentato aggiungeva qui un filtro
        cronologico via sender_timestamp, condiviso tra tutte le
        chiamate a questo metodo nella stessa sessione tramite un dict
        passato dal chiamante (session_state, creato in
        _query_cli_config()) con due chiavi — "last_accepted_timestamp"
        (sender_timestamp dell'ultima risposta CLI accettata in questa
        sessione) e "timestamp_field_seen" (diagnostico, True se il
        campo era mai stato osservato) — e scartava un messaggio dal
        repeater giusto se il suo sender_timestamp non era successivo
        all'ultimo già accettato, con fail-open esplicito se il campo
        era assente o il confronto sollevava TypeError. Questo
        meccanismo, il dict che lo sosteneva e il parametro
        session_state non esistono più nel codice — rimossi
        interamente, non solo disattivati (v. AGGIORNAMENTO sotto per
        il perché).

        AGGIORNAMENTO (2026-08-22, pomeriggio, run reale
        dell'utente): la stessa identica cascata di contaminazione è
        stata osservata anche CON questo filtro attivo, con in più
        valori residui mai visti nella diagnosi originale ('default
        scope is it', '10.0%') — e senza NESSUN log "scartato come
        RESIDUO" nel giro incriminato, quindi il filtro cronologico
        non ha rifiutato nulla in quella sessione: l'ipotesi
        dell'ordine cronologico come discriminante affidabile per
        questo campo, su questo specifico percorso, non è ancora
        confermata sul campo (anzi è ora in dubbio) — v. log
        diagnostico aggiunto sotto e
        claude/finding-cross-command-cli-response-contamination-2026-08-22.md
        §10 per l'analisi completa e le ipotesi al vaglio.

        RIMEDIO DEFINITIVO (2026-08-22, sera — v. §11-§15 del finding
        doc citato sopra e docs/FIRMWARE_ANALYSIS.md §11.2): l'ipotesi
        cronologica è stata SMENTITA, non solo "non confermata" — il
        firmware del Companion sostituisce sender_timestamp con il
        proprio RTC (getCurrentTimeUnique()) ad ogni trasmissione o
        RITRASMISSIONE di un messaggio di tipo CLI_DATA, per evitare
        di far scattare la protezione anti-replay lato ricevente
        (commento originale nel firmware: "Use node's RTC instead of
        app timestamp to avoid tripping replay protection"). Per
        simmetria, lo stesso vale quando è il REPEATER a generare la
        propria risposta CLI: sender_timestamp riflette quindi
        SEMPRE l'istante dell'ultimo invio/reinvio lato repeater, non
        l'ordine logico dei comandi — è per questo che nei run reali
        cresce in modo monotono indipendentemente dal contenuto, e
        nessun rifiuto "RESIDUO" è mai comparso nei log.

        AGGIORNAMENTO (2026-08-22, notte — decisione esplicita
        dell'utente, v. finding doc §17): il filtro cronologico
        ("Option A", sopra) è stato RIMOSSO dal codice — non lasciato
        "a costo zero" come inizialmente ipotizzato. Motivazione
        dell'utente, riportata quasi testualmente: codice che non fa
        nulla di misurabile non va tenuto in base alla sola ipotesi
        che un firmware futuro possa renderlo utile, un'ipotesi che
        nessuno ha modo di verificare oggi — il rischio concreto è
        codice la cui ragion d'essere si perde nel tempo. Restano
        attivi solo i due livelli sotto, entrambi validati contro il
        protocollo/firmware reale invece che contro un'ipotesi non
        verificata.

        La protezione reale aggiunta ora è su DUE livelli nuovi,
        entrambi validati contro il protocollo/firmware reale invece
        che contro un'ipotesi non verificata (lezione delle due
        iterazioni precedenti):

        1. Svuotamento esplicito della coda messaggi LOCALE
           (_drain_pending_messages(), chiamato da
           _query_cli_config() prima del login e da questo metodo
           prima di ogni singolo send_cmd()) — riduce concretamente la
           finestra in cui un residuo già arrivato può essere confuso
           con la risposta al comando che sta per partire, incluso il
           caso di un residuo dalla CODA della sessione CLI
           PRECEDENTE (ipotesi coerente con l'anomalia osservata sul
           campo di 'board' che riceveva un valore assomigliante alla
           risposta di 'region default', un comando molto più avanti
           nello stesso giro — spiegabile solo con un residuo di un
           giro precedente non ancora consumato).
        2. Controllo di plausibilità sul FORMATO del contenuto,
           integrato in _is_own_response() stesso (non più solo dopo,
           nel parsing in questo metodo): un messaggio dal mittente
           giusto il cui testo non è nemmeno nella forma attesa per
           value_type del comando corrente (es. testo non numerico per
           un comando che attende un intero) viene trattato come "non
           corrispondente" invece che accettato — l'attesa CONTINUA
           entro la stessa finestra di timeout per una risposta che
           abbia almeno la forma giusta, invece di accettare
           immediatamente un residuo palesemente sbagliato e bruciare
           un intero tentativo (o peggio, lasciare che la risposta
           vera arrivi poi a contaminare il comando SUCCESSIVO).

        Limitazione residua, dichiarata onestamente: il protocollo dei
        comandi CLI via login (send_cmd(), meshcore_py
        commands/messaging.py) non porta alcun ID di correlazione nel
        pacchetto — a differenza di TraceModule.send_trace() ('tag'
        numerico incorporato esplicitamente nel pacchetto) o di
        send_msg_with_retry() (correlazione via ACK,
        expected_ack/EventType.ACK). Senza un ID nel protocollo
        stesso, nessun controllo lato client può raggiungere la
        certezza matematica. In particolare, per i TRE comandi a testo
        libero (firmware_version/'ver', hardware/'board',
        region_default/'region default' — value_type=str) il
        controllo di plausibilità sul formato è un NO-OP: qualunque
        stringa è "valida" per str(), quindi un residuo testuale dello
        stesso mittente resta indistinguibile dalla risposta genuina
        per questi tre soltanto sulla base del contenuto — mitigato
        solo dallo svuotamento della coda (punto 1) e dal filtro sul
        mittente. Per gli altri 8 comandi (tutti numerici) il
        controllo di formato è una protezione reale e verificata contro
        il codice reale della libreria, non un'ipotesi.

        Infine, l'analisi storica dei log (18 giorni, v. §14 del
        finding doc) mostra un pattern a finestra oraria giornaliera
        ricorrente (pulito per 12-14 ore consecutive, poi un blocco di
        ore con fallimenti, poi di nuovo pulito) coerente con una causa
        ESTERNA (carico/congestione radio in certe fasce orarie), non
        con un difetto di codice costante — questo fix riduce quindi
        concretamente il rischio residuo di contaminazione, ma non
        elimina una causa che non è mai stata, per sua natura,
        interamente sotto il controllo del software lato client.
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

            #
            # Criterio forte, esplicito (correzione 2026-08-22 notte,
            # segnalazione dell'utente — v. docstring di
            # _drain_pending_messages() per il dettaglio completo e la
            # verifica sul sorgente reale della libreria): un repeater
            # genera SOLO risposte dirette (CONTACT_MSG_RECV) verso il
            # richiedente della sessione CLI — mai un messaggio di
            # canale (CHANNEL_MSG_RECV). Il controllo sotto su
            # pubkey_prefix era già sufficiente in pratica (quel campo
            # è semplicemente assente sul payload CHANNEL_MSG_RECV),
            # ma solo per un effetto collaterale implicito — reso qui
            # esplicito, sullo stesso principio "criterio forte" già
            # in uso in modo speculare da
            # BotModule._on_contact_message() (mai trattare come DM
            # per il bot un messaggio il cui mittente è un repeater
            # con sessione CLI attiva).
            #
            if msg_event.type != EventType.CONTACT_MSG_RECV:
                return False

            sender_prefix = msg_event.payload.get("pubkey_prefix")

            if not (
                sender_prefix and
                public_key.startswith(sender_prefix)
            ):
                return False

            #
            # Controllo di plausibilità sul FORMATO del contenuto
            # (rimedio definitivo, 2026-08-22 — v. docstring del
            # metodo per il ragionamento completo).
            #
            # Tenta la stessa conversione che _send_cli_command()
            # rifarebbe comunque dopo l'accettazione: se il testo dal
            # mittente giusto non è nemmeno nella FORMA attesa per
            # QUESTO comando (value_type, dalla entry di CLI_QUERIES
            # corrispondente — chiusura sulla variabile del chiamante),
            # è quasi certamente il residuo di un comando precedente
            # (di questa sessione, o della sessione precedente contro
            # lo stesso repeater — v. _drain_pending_messages()): non
            # va accettato, si continua ad attendere entro la stessa
            # finestra di timeout una risposta che abbia almeno la
            # forma giusta.
            #
            # NESSUNA protezione per i 3 comandi a testo libero (ver,
            # board, region default — value_type=str): qualunque
            # stringa è valida per str(), quindi per questi tre il
            # rischio resta quello originale, onestamente documentato
            # come non tecnicamente eliminabile lato client (nessun ID
            # di correlazione nel protocollo CLI — v. docstring).
            #
            candidate_cleaned = msg_event.payload.get(
                "text", ""
            ).lstrip(">").strip()

            try:
                value_type(candidate_cleaned)

            except Exception:
                return False

            #
            # DIAGNOSTICA (2026-08-22, mantenuta a livello DEBUG dal
            # 2026-08-22 notte su richiesta esplicita dell'utente —
            # v. finding doc §17): nessun filtro duro basato su
            # sender_timestamp o su txt_type è più implementato qui —
            # il primo ("Option A") è stato rimosso per intero (v.
            # docstring del metodo), il secondo non è mai stato
            # attivato perché il valore numerico reale di
            # TXT_TYPE_CLI_DATA per QUESTO firmware non è ancora stato
            # confermato empiricamente su questo percorso (get_msg(),
            # non la subscription usata da BotModule) — solo
            # documentato per nome in docs/FIRMWARE_ANALYSIS.md §11.2.
            # Questa riga resta solo diagnostica, nessun comportamento
            # cambiato: utile per continuare a osservare il fenomeno
            # (l'utente non considera la questione chiusa e prevede
            # esecuzioni più frequenti per raccogliere altra evidenza)
            # senza produrre rumore nei log a livello INFO.
            #
            sender_timestamp = msg_event.payload.get("sender_timestamp")

            log.debug(
                "NEIGHBOR_MONITOR: %s '%s' [diag contaminazione] "
                "sender_timestamp=%r (tipo %s) txt_type=%r testo=%r.",
                tag,
                cmd_text,
                sender_timestamp,
                type(sender_timestamp).__name__,
                msg_event.payload.get("txt_type"),
                msg_event.payload.get("text", "")[:80]
            )

            return True

        def _on_discard(msg_event):

            #
            # Criterio forte, esplicito (correzione 2026-08-22 notte —
            # v. docstring di _drain_pending_messages()): una risposta
            # CLI genuina è SEMPRE un CONTACT_MSG_RECV — un repeater
            # non genera mai un messaggio di canale (CHANNEL_MSG_RECV),
            # e get_msg() può occasionalmente restituire anche
            # NO_MORE_MSGS/ERROR in questo punto (v. libreria). Nessuno
            # di questi tre casi può mai essere la risposta cercata;
            # distinti qui esplicitamente da un CONTACT_MSG_RECV con
            # mittente sbagliato solo per chiarezza del log — il
            # trattamento (scarto, si continua ad attendere entro la
            # stessa finestra) è identico.
            #
            if msg_event.type != EventType.CONTACT_MSG_RECV:

                if msg_event.type == EventType.CHANNEL_MSG_RECV:

                    log.info(
                        "NEIGHBOR_MONITOR: %s '%s' messaggio di canale "
                        "(un repeater non ne genera mai) attraversato "
                        "e ignorato durante l'attesa della risposta; "
                        "recapitato comunque, indipendentemente, a "
                        "BotModule tramite il dispatcher condiviso "
                        "della libreria.",
                        tag,
                        cmd_text
                    )

                else:

                    log.debug(
                        "NEIGHBOR_MONITOR: %s '%s' evento non "
                        "pertinente (tipo=%s) durante l'attesa della "
                        "risposta, ignorato.",
                        tag,
                        cmd_text,
                        msg_event.type
                    )

                return

            sender_prefix = msg_event.payload.get("pubkey_prefix")

            if not (
                sender_prefix and
                public_key.startswith(sender_prefix)
            ):

                log.info(
                    "NEIGHBOR_MONITOR: %s '%s' messaggio spurio "
                    "scartato (da %s, non dal repeater interrogato) "
                    "durante l'attesa della risposta.",
                    tag,
                    cmd_text,
                    sender_prefix or "mittente sconosciuto"
                )

                return

            #
            # Mittente giusto ma scartato: da quando esiste il
            # controllo di plausibilità sul formato (rimedio
            # definitivo, 2026-08-22 — v. docstring di
            # _send_cli_command()) questo è l'UNICO motivo possibile
            # per uno scarto a mittente corretto — il filtro
            # cronologico ("Option A") che in precedenza poteva essere
            # l'altro motivo è stato rimosso interamente il
            # 2026-08-22 notte (v. docstring del metodo, finding doc
            # §17). Rifare qui la stessa conversione (a costo
            # trascurabile) solo per includere il testo scartato nel
            # log.
            #
            candidate_cleaned = msg_event.payload.get(
                "text", ""
            ).lstrip(">").strip()

            try:
                value_type(candidate_cleaned)

            except Exception:

                log.info(
                    "NEIGHBOR_MONITOR: %s '%s' messaggio dal repeater "
                    "giusto scartato per FORMATO non plausibile "
                    "(testo=%r non convertibile con %s) — "
                    "verosimilmente il residuo di un comando "
                    "precedente (di questa sessione, o della sessione "
                    "precedente contro lo stesso repeater), non la "
                    "risposta a '%s'. Si continua ad attendere entro "
                    "la stessa finestra di timeout.",
                    tag,
                    cmd_text,
                    msg_event.payload.get("text", "")[:80],
                    getattr(value_type, "__name__", value_type),
                    cmd_text
                )

        for attempt in range(1, self.max_retries + 1):

            try:
                #
                # Rimedio definitivo, 2026-08-22 — v. docstring del
                # metodo e di _drain_pending_messages(): svuota un
                # eventuale residuo già seduto nella coda locale
                # PRIMA di inviare questo comando, così non può più
                # essere confuso con la sua risposta.
                #
                await self._drain_pending_messages(
                    public_key,
                    tag,
                    "prima di '%s' (tentativo %d/%d)" % (
                        cmd_text, attempt, self.max_retries
                    )
                )

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
