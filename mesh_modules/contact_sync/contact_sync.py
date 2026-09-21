import asyncio
import functools
import time

from meshcore.events import EventType

from core.config import config
from core.logger import log
from mesh_modules.contact_sync.db import ContactDB

#
# Rate-limit minimo per (public_key, path_hex) su path_observations
# (code review 2026-08-20, §3.4; corretto in chiave nella stessa
# giornata — v. commento in _on_log_data() per il dettaglio completo
# dell'errore e della correzione). Per design ogni ADVERT genera una
# riga (percorsi multipli per lo stesso nodo sono dati voluti, non
# deduplicati — docs/CONTACT_MANAGEMENT.md), ma senza alcun limite un
# nodo/percorso che trasmette ad alta frequenza (guasto o doloso) può
# far crescere la tabella più rapidamente della rotazione mensile,
# fino a esaurire lo storage SD del Raspberry Pi. 2 secondi è
# ampiamente sotto la cadenza di qualunque ripetizione legittima dello
# STESSO percorso osservata sul campo — scarta solo un flusso
# anormalmente rapido sullo stesso nodo E sullo stesso percorso, non
# riduce mai la diversità di percorso (locale vs. via RPT remoto) che
# è invece il dato che questo meccanismo deve preservare.
#
MIN_PATH_OBSERVATION_INTERVAL = 2


class ContactSyncModule:
    """
    Sincronizza in modo persistente i nodi e i path osservati verso
    lo store SQLite (docs/CONTACT_MANAGEMENT.md).

    Due canali di acquisizione, non intercambiabili:
    - RX_LOG_DATA (filtrato ADVERT), in tempo reale: sorgente dei
      dati di path (una riga per ogni ricezione fisica — percorsi
      multipli sono dati voluti, non deduplicati, vedi
      CONTACT_MANAGEMENT.md §6). Porta già anche i campi di identità
      del nodo (nome, tipo, posizione), quindi aggiorna 'nodes' da
      solo — non serve sottoscrivere separatamente ADVERTISEMENT/
      NEW_CONTACT per questo (semplificazione rispetto al piano
      iniziale in CONTACT_MANAGEMENT.md, RX_LOG_DATA è già un
      superset di quei due eventi per i nostri scopi).
    - Sync periodico (get_contacts()): rete di sicurezza per eventi
      persi durante downtime del daemon, e unica sorgente per
      out_path/out_path_len (non presenti in RX_LOG_DATA).

    Legge l'istanza MeshCore corrente dinamicamente da Engine ad ogni
    chiamata — non ne tiene mai una copia locale.
    """

    def __init__(self, engine):

        self.engine = engine

        self.db_path = config.get(
            "contacts.db_file",
            "data/contacts.db"
        )

        self.sync_interval = config.get(
            "contacts.sync_interval",
            3600
        )

        #
        # Configurazione Telegram (sezione 'telegram', non 'bot' —
        # v. docs/ARCHITECTURE.md §55) letta qui insieme al resto della
        # config di questo modulo, scritta in contacts.db una sola
        # volta all'avvio (v. start()) — mai un hot-reload, coerente
        # con la convenzione già in uso in tutto il progetto per cui
        # una modifica a config.yaml richiede un riavvio del daemon.
        # chat_id vuoto ("" nel template) normalizzato a None.
        #
        self.telegram_chat_id = config.get("telegram.chat_id") or None
        self.telegram_enabled = bool(config.get("telegram.enabled", False))

        self.db = ContactDB(self.db_path)

        self._sync_task = None

        #
        # Riferimenti ai task di rebind creati da _on_rebind() (code
        # review 2026-08-20, §3.1) — a differenza di _sync_task (già
        # correttamente salvato come attributo), questi non erano mai
        # mantenuti: rischio di garbage collection imprevedibile
        # prima del completamento, sconsigliato esplicitamente dalla
        # documentazione asyncio. Il set si autopulisce a task finito.
        #
        self._rebind_tasks = set()

        #
        # Ultimo timestamp (locale, time.time()) di path_observation
        # accettata, per chiave (public_key, path_hex) — v.
        # MIN_PATH_OBSERVATION_INTERVAL sopra (corretta nella chiave
        # il 2026-08-20, stessa giornata dell'introduzione: la prima
        # versione usava solo public_key, scartando erroneamente
        # anche percorsi diversi per lo stesso nodo). Solo in memoria,
        # si azzera a ogni riavvio del daemon (accettabile: il caso da
        # prevenire è un flusso continuo durante l'esecuzione, non il
        # singolo evento subito dopo un riavvio).
        #
        self._last_path_obs_at = {}

        #
        # Serializza l'accesso a self.db/self._conn tra le chiamate
        # concorrenti a _run_db() (verifica logica post-deploy
        # 2026-08-20, in aggiunta al §3.4 sotto) — self.db.transaction()
        # (v. db.py) tiene aperta una transazione multi-statement con
        # commit posticipato per garantire atomicità tra le insert di
        # un singolo giro di polling repeater. La connessione sqlite3
        # è condivisa (check_same_thread=False) e ha UN'UNICA
        # transazione implicita: senza questo lock, l'executor di
        # default (multi-thread) può interlacciare _on_advert() con
        # _full_sync()/_sync_device_status() sullo stesso self._conn,
        # e un commit dell'uno può chiudere prematuramente la
        # transazione multi-step dell'altro, vanificando proprio la
        # garanzia di atomicità introdotta dal §3.4. Il lock avvolge
        # solo l'attesa dell'executor (non query CPU-bound), quindi
        # non reintroduce il blocco dell'event loop che il §3.4 voleva
        # eliminare — le altre coroutine del daemon restano libere di
        # girare mentre una chiamata DB è in coda o in corso.
        #
        self._db_lock = asyncio.Lock()

        self.engine.register_rebind(self._on_rebind)

    async def _run_db(self, func, *args, **kwargs):
        """
        Esegue una chiamata sincrona a ContactDB (sqlite3, driver
        bloccante) in un thread executor invece che direttamente
        nell'event loop del daemon (code review 2026-08-20, §3.4) —
        con busy_timeout=5000, un conflitto di lock (es. con
        tools/rotate_path_observations.py sullo stesso file da un
        processo separato) può far attendere la connessione fino a
        5 secondi interi: eseguita in linea nel loop, quell'attesa
        blocca l'intero daemon (non solo ContactSyncModule, anche
        RX mesh/bot/IPC, che condividono lo stesso loop). L'executor
        di default (ThreadPoolExecutor implicito di asyncio) è
        sufficiente: si tratta di query sqlite3, non CPU-bound.

        self._db_lock serializza le chiamate tra loro (v. commento
        su self._db_lock in __init__) — self._conn è condivisa e ha
        una sola transazione implicita, quindi due chiamate concorrenti
        su thread diversi dell'executor possono altrimenti interlacciare
        commit/insert di giri di polling differenti.
        """

        async with self._db_lock:

            loop = asyncio.get_event_loop()

            return await loop.run_in_executor(
                None,
                functools.partial(func, *args, **kwargs)
            )

    async def start(self):

        #
        # Scrittura una tantum della configurazione Telegram in
        # contacts.db (tabella telegram_settings — v. db.py), così che
        # il prossimo giro di contact_sync.sh la porti al Collettore
        # senza alcun canale di trasporto nuovo (v.
        # docs/ARCHITECTURE.md §55). Passa da _run_db() come ogni
        # altra scrittura di questo modulo (§3.4 — mai un sqlite3
        # bloccante diretto nell'event loop). Non fatale: un
        # fallimento qui (es. disco pieno) non deve impedire l'avvio
        # del resto del modulo (sottoscrizione RX_LOG_DATA, sync
        # contatti) — il Collettore vedrà comunque il valore del giro
        # precedente, o lo vedrà al prossimo riavvio.
        #
        try:
            await self._run_db(
                self.db.upsert_telegram_settings,
                updated_at=int(time.time()),
                chat_id=self.telegram_chat_id,
                enabled=self.telegram_enabled
            )

        except Exception:
            log.exception(
                "ContactSyncModule: scrittura telegram_settings fallita "
                "(non fatale, avvio del modulo prosegue)."
            )

        self._subscribe()

        #
        # Sync iniziale, non aspetta il primo giro di
        # sync_interval per popolare lo stato corrente.
        #
        await self._full_sync()

        self._sync_task = asyncio.create_task(
            self._periodic_sync_loop()
        )

        log.info(
            "ContactSyncModule: avviato (db=%s, sync ogni %ss).",
            self.db_path,
            self.sync_interval
        )

    def _subscribe(self):

        self.engine.mesh.subscribe(
            EventType.RX_LOG_DATA,
            self._on_log_data
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
            "ContactSyncModule: rebinding dopo reconnect."
        )

        try:
            self._subscribe()

        except Exception:
            log.exception(
                "ContactSyncModule: rebind fallito."
            )

    async def _on_log_data(self, event):

        payload = event.payload

        if payload.get("payload_typename") != "ADVERT":
            return

        public_key = payload.get("adv_key")

        if not public_key:
            return

        try:
            await self._run_db(
                self.db.upsert_node,
                public_key=public_key,
                adv_name=payload.get("adv_name"),
                node_type=payload.get("adv_type"),
                adv_lat=payload.get("adv_lat"),
                adv_lon=payload.get("adv_lon"),
                seen_at=payload.get("recv_time")
            )

            #
            # CORREZIONE (2026-08-20, stessa giornata) — la versione
            # originale di questo rate-limit (code review 2026-08-20,
            # §3.4) usava come chiave SOLO public_key, senza guardare
            # il percorso: scartava quindi anche una seconda
            # osservazione con un path_hex DIVERSO dalla precedente,
            # se arrivata entro MIN_PATH_OBSERVATION_INTERVAL. Questo
            # confliggeva direttamente con una decisione di design già
            # presa e documentata (v. docs/CONTACT_MANAGEMENT.md,
            # sezione sul meccanismo di acquisizione, la nota col
            # test "diretto + ripetuto da 0d28"): le ricezioni
            # multiple dello stesso advert per percorsi FISICI DIVERSI
            # sono dati voluti, non rumore da filtrare — rappresentano
            # la ridondanza reale della rete (es. un nodo che arriva
            # sia diretto sia ripetuto da un RPT, il caso d'uso
            # esplicito di trace-mon). Il rate-limit doveva colpire
            # solo il flusso anomalo di ripetizioni dello STESSO
            # percorso, non la diversità di percorso in sé — un errore
            # di analisi (bug introdotto contro una decisione già
            # approvata), non un cambiamento di requisiti.
            #
            # Fix: chiave del rate-limit estesa a (public_key,
            # path_hex) invece del solo public_key. Così due
            # osservazioni con path_hex diverso per lo stesso nodo non
            # si scartano mai a vicenda, indipendentemente dai tempi;
            # solo la ripetizione dello STESSO percorso entro
            # MIN_PATH_OBSERVATION_INTERVAL viene ancora scartata — il
            # caso originale che il rate-limit doveva prevenire (un
            # nodo/percorso che trasmette troppo rapidamente).
            # L'identità del nodo (upsert_node sopra) resta comunque
            # sempre aggiornata, indipendentemente dall'esito di
            # questo controllo, come da prima.
            #
            # In memoria, si azzera a ogni riavvio/rebind del daemon
            # (già frequente, v. commento su _last_path_obs_at
            # nell'__init__): la cardinalità aggiuntiva data da
            # (nodo, percorso) invece di solo nodo resta comunque
            # trascurabile in pratica.
            #
            path_hex = payload.get("path") or ""
            path_key = (public_key, path_hex)

            now_local = time.time()
            last_at = self._last_path_obs_at.get(path_key, 0)

            if now_local - last_at < MIN_PATH_OBSERVATION_INTERVAL:

                log.info(
                    "ContactSyncModule: path_observation scartata "
                    "per %s, percorso '%s' (rate-limit, %.1fs "
                    "dall'ultima accettata per questo stesso "
                    "percorso).",
                    public_key,
                    path_hex,
                    now_local - last_at
                )

                return

            self._last_path_obs_at[path_key] = now_local

            await self._run_db(
                self.db.insert_path_observation,
                public_key=public_key,
                observed_at=payload.get("recv_time"),
                adv_timestamp=payload.get("adv_timestamp"),
                pkt_hash=payload.get("pkt_hash"),
                path_hex=path_hex,
                #
                # payload.get("path_len", 0) usava il default solo
                # se la chiave era ASSENTE, non se il valore era
                # esplicitamente None (code review 2026-08-20, §3.4)
                # — un payload con "path_len": None violava il
                # vincolo NOT NULL su hop_count, con
                # insert_path_observation() che falliva DOPO che
                # upsert_node() era già stato committato (nodo
                # aggiornato, osservazione di path persa). "or 0"
                # normalizza sia il caso assente sia None allo stesso
                # default 0, senza alterare un path_len legittimo.
                #
                hop_count=payload.get("path_len") or 0,
                route_type=payload.get("route_typename"),
                transport_code=payload.get("transport_code"),
                rssi=payload.get("rssi"),
                snr=payload.get("snr")
            )

        except Exception:
            log.exception(
                "ContactSyncModule: scrittura path_observation fallita "
                "(public_key=%s).",
                public_key
            )

    async def _periodic_sync_loop(self):

        while True:

            await asyncio.sleep(self.sync_interval)

            #
            # Rete di sicurezza: _full_sync() protegge già ogni sua
            # singola operazione fallibile (get_contacts(), ogni
            # upsert_node(), upsert_device_status(), vedi sotto), ma
            # questo loop è un task standalone il cui esito non viene
            # mai atteso/controllato da nessun altro componente — se
            # una qualunque eccezione dovesse comunque sfuggire (bug
            # futuro, cambio di comportamento della libreria), non
            # deve poter interrompere per sempre l'intero sync
            # periodico in modo silenzioso (v. code review
            # 2026-08-20, §2.5: prima di questo fix, un'eccezione
            # sfuggita a metà di _full_sync() terminava il task senza
            # alcun log applicativo — solo l'handler di default di
            # asyncio, tipicamente invisibile in produzione — mentre
            # il resto del servizio (RX_LOG_DATA) restava attivo,
            # mascherando il guasto).
            #
            try:
                await self._full_sync()

            except Exception:
                log.exception(
                    "ContactSyncModule: giro di sync periodico "
                    "interrotto da un errore non previsto — il "
                    "prossimo giro (tra %ss) verrà comunque tentato.",
                    self.sync_interval
                )

    async def _full_sync(self):

        try:
            #
            # get_contacts() tocca la connessione condivisa — va
            # serializzato con command_lock come ogni altro comando,
            # questo sync gira su un proprio loop indipendente
            # (sync_interval) e può altrimenti sovrapporsi a un
            # comando IPC/bot in corso sulla stessa connessione.
            #
            # get_contacts() (a differenza degli altri comandi "_sync"
            # usati altrove in questo file, v. _get_stats_safe()) non
            # è pre-unwrappato dalla libreria: su timeout/fallimento
            # non solleva mai un'eccezione, ritorna un
            # Event(ERROR, ...) grezzo (verificato leggendo
            # meshcore_py/commands/contact.py — code review 2026-08-20,
            # audit successivo al Finding 2 di una review indipendente).
            # Il solo except Exception sotto non lo intercettava mai:
            # un timeout passava per "riuscito", mesh.contacts restava
            # silenziosamente non aggiornata (dati precedenti, non
            # quelli del giro corrente) e nessun log segnalava nulla.
            #
            # acquire_command_lock() invece dell'accesso diretto al
            # lock (Finding 1/5, review affidabilità 2026-08-21 — v.
            # ARCHITECTURE.md §49).
            async with self.engine.acquire_command_lock("contact_sync:full_sync_get_contacts"):
                result = await self.engine.mesh.commands.get_contacts()

            if result.type == EventType.ERROR:

                log.warning(
                    "ContactSyncModule: get_contacts() fallita durante "
                    "il sync periodico (%s) — mesh.contacts non "
                    "aggiornata, dati del giro precedente ancora "
                    "validi per questo ciclo.",
                    result.payload
                )

                return

        except Exception:
            log.exception(
                "ContactSyncModule: get_contacts() fallito durante "
                "il sync periodico."
            )
            return

        try:
            contacts = self.engine.mesh.contacts

        except AttributeError:
            log.warning(
                "ContactSyncModule: impossibile accedere a "
                "mesh.contacts."
            )
            return

        now = int(time.time())
        count = 0

        for c in contacts.values():

            try:
                await self._run_db(
                    self.db.upsert_node,
                    public_key=c.get("public_key"),
                    adv_name=c.get("adv_name"),
                    node_type=c.get("type"),
                    adv_lat=c.get("adv_lat"),
                    adv_lon=c.get("adv_lon"),
                    out_path=c.get("out_path"),
                    out_path_len=c.get("out_path_len"),
                    flags=c.get("flags"),
                    out_path_hash_mode=c.get("out_path_hash_mode"),
                    last_advert=c.get("last_advert"),
                    lastmod=c.get("lastmod"),
                    seen_at=now
                )

                count += 1

            except Exception:
                log.exception(
                    "ContactSyncModule: upsert nodo '%s' fallito.",
                    c.get("adv_name")
                )

        log.info(
            "ContactSyncModule: sync periodico completato (%d nodi).",
            count
        )

        try:
            await self._sync_device_status(now)

        except Exception:
            #
            # A differenza di ogni altra scrittura DB in questo file
            # (upsert_node in loop, sotto _get_stats_safe),
            # upsert_device_status() non era protetta: un errore qui
            # (es. 'database is locked' per contesa temporanea con
            # uno script di manutenzione, superiore al busy_timeout)
            # interrompeva silenziosamente l'intero sync periodico
            # (v. code review 2026-08-20, §2.5). Il device_status
            # resta semplicemente non aggiornato per questo giro —
            # stesso comportamento onesto già documentato sopra per
            # il caso "tutte e quattro le query fallite".
            #
            log.exception(
                "ContactSyncModule: sync di device_status fallito "
                "per questo giro."
            )

    async def _sync_device_status(self, now):
        """
        Stato corrente del companion connesso a trace-mon stesso —
        quattro query locali al device (get_stats_core/radio/packets
        + send_device_query per modello/firmware, nessun traffico
        radio, stesso principio di get_bat() già usato nell'heartbeat di Engine), eseguite in questo stesso
        giro invece che con un cron dedicato. Ogni gruppo è
        indipendente: se una fallisce le altre tre vengono comunque
        salvate (vedi COALESCE in upsert_device_status). Se falliscono
        TUTTE E QUATTRO, l'aggiornamento viene saltato del tutto —
        updated_at resta quello dell'ultimo giro riuscito, un segnale
        onesto di quanto il dato sia vecchio invece di un errore.

        A queste quattro si aggiunge una quinta query locale, la
        telemetria del companion (_get_self_telemetry(), v.
        ARCHITECTURE.md §76): gruppo indipendente come gli altri, ma
        FUORI dalla condizione "tutte fallite" sopra — eseguita solo
        dopo quel controllo e mai motivo, da sola, per saltare
        l'aggiornamento.
        """

        core = await self._get_stats_safe(
            "stats_core",
            self.engine.mesh.commands.get_stats_core
        )

        radio = await self._get_stats_safe(
            "stats_radio",
            self.engine.mesh.commands.get_stats_radio
        )

        packets = await self._get_stats_safe(
            "stats_packets",
            self.engine.mesh.commands.get_stats_packets
        )

        device_info = await self._get_stats_safe(
            "device_query",
            self.engine.mesh.commands.send_device_query
        )

        if (
            core is None and
            radio is None and
            packets is None and
            device_info is None
        ):

            log.warning(
                "ContactSyncModule: device_status non aggiornato "
                "(nessuna delle quattro query locali è riuscita)."
            )

            return

        core = core or {}
        radio = radio or {}
        packets = packets or {}
        device_info = device_info or {}

        self_info = self.engine.mesh.self_info or {}

        #
        # Telemetria del companion (get_self_telemetry(), evento
        # TELEMETRY_RESPONSE) — quinta query locale, per le righe
        # "Telemetry - ..." della tabella Device Status (frontend). Come
        # le altre quattro è un comando diretto al device, nessun
        # traffico radio (il firmware risponde con le proprie misure:
        # tensione di batteria e ogni sensore presente, senza passare
        # dalla mesh — a differenza di req_telemetry_sync() usata da
        # neighbor_monitor per i repeater remoti). Deliberatamente
        # eseguita DOPO il controllo "tutte e quattro fallite" qui
        # sopra, non insieme alle altre: (1) una connessione con il
        # device evidentemente non funzionante non deve costare un
        # ulteriore timeout (15s di default della libreria) inutile;
        # (2) NON entra in quella condizione di salto — updated_at
        # resta legato al successo delle quattro query originali,
        # come prima, e la telemetria è un gruppo indipendente
        # (COALESCE in upsert_device_status(): un fallimento qui
        # conserva le misure del giro precedente, mai le azzera).
        # None = non ottenuta/scartata in questo giro (v.
        # _get_self_telemetry()); lista vuota = il device ha risposto
        # senza misure, dato valido da scrivere come tale.
        #
        telemetry = await self._get_self_telemetry(self_info)

        #
        # Posizione geografica del companion connesso a trace-mon
        # stesso (adv_lat/adv_lon), per la pagina di dettaglio traccia
        # con mappa (frontend), più i parametri radio LoRa attualmente
        # configurati (radio_freq/radio_bw/radio_sf/radio_cr), per la
        # riga "Radio settings" della tabella Device Status (frontend).
        # A differenza di core/radio/packets/device_info sopra, NON
        # sono query locali al device: sono già disponibili in
        # mesh.self_info, popolato in modo asincrono dalla libreria ad
        # ogni connessione/riconnessione (evento SELF_INFO, v. stesso
        # pattern già documentato in SystemService._status_result()) —
        # nessun comando aggiuntivo da inviare, nessun rischio di
        # allungare questo giro di sync. I parametri radio sono già
        # usati altrove nel progetto (SystemService._status_result(),
        # core/trace_timeout_estimate.py) per stimare i timeout di
        # tracce/altri servizi, ma finora mai persistiti in
        # device_status — v. MIGRATIONS/upsert_device_status() in
        # db.py per l'unità di misura (radio_bw in kHz) e la
        # convenzione (radio_cr in formato RAW RadioLib, 5-8).
        # Lette qui (non condizionate al successo delle quattro query
        # sopra, il cui esito combinato è verificato solo per decidere
        # se saltare l'intero upsert) così una connessione riuscita ma
        # con, per dire, get_stats_radio() fallita non perde comunque
        # l'aggiornamento di posizione/radio/nome, se noti. self_info è letta
        # più sopra (prima della query di telemetria, che ne usa la
        # chiave pubblica per verificare l'identità della risposta) —
        # stessa istanza, un solo punto di lettura per l'intero giro.
        #
        await self._run_db(
            self.db.upsert_device_status,
            updated_at=now,
            battery_mv=core.get("battery_mv"),
            uptime_secs=core.get("uptime_secs"),
            errors=core.get("errors"),
            queue_len=core.get("queue_len"),
            noise_floor=radio.get("noise_floor"),
            last_rssi=radio.get("last_rssi"),
            last_snr=radio.get("last_snr"),
            tx_air_secs=radio.get("tx_air_secs"),
            rx_air_secs=radio.get("rx_air_secs"),
            recv=packets.get("recv"),
            sent=packets.get("sent"),
            flood_tx=packets.get("flood_tx"),
            direct_tx=packets.get("direct_tx"),
            flood_rx=packets.get("flood_rx"),
            direct_rx=packets.get("direct_rx"),
            recv_errors=packets.get("recv_errors"),
            model=device_info.get("model"),
            fw_build=device_info.get("fw_build"),
            fw_version=device_info.get("ver"),
            adv_lat=self_info.get("adv_lat"),
            adv_lon=self_info.get("adv_lon"),
            radio_freq=self_info.get("radio_freq"),
            radio_bw=self_info.get("radio_bw"),
            radio_sf=self_info.get("radio_sf"),
            radio_cr=self_info.get("radio_cr"),
            telemetry=telemetry,
            # Nome del companion (mesh.self_info["name"], stesso frame
            # SELF_INFO di adv_lat/adv_lon/radio_* sopra — nessun comando
            # aggiuntivo) per l'intestazione del tab Nodes. Normalizzato
            # (spazi/NUL, lunghezza) da upsert_device_status(); None o
            # vuoto = nome non aggiornato, mai azzerato.
            device_name=self_info.get("name")
        )

    async def _get_self_telemetry(self, self_info):
        """
        Telemetria del companion connesso a trace-mon stesso, via
        DeviceCommands.get_self_telemetry() (comando diretto al
        device, stesso percorso _get_stats_safe() delle altre query di
        stato locale — command_lock, nessun traffico radio).

        Ritorna la lista di misure [{"channel", "type", "value"}, ...]
        già decodificata dalla libreria (Cayenne LPP), nell'ordine
        riportato dal device — lista vuota se il device ha risposto
        senza misure — oppure None se la query è fallita o la risposta
        non è utilizzabile (nessun aggiornamento, v. COALESCE in
        upsert_device_status()).

        Verifica di identità della risposta (stessa classe di problema
        già incontrata più volte nel progetto, v. neighbor_monitor.py e
        trace.py: un evento arrivato per un'altra richiesta scambiato
        per la risposta corrente): send() della libreria si sottoscrive
        al SOLO tipo di evento TELEMETRY_RESPONSE, senza alcun filtro
        di correlazione, ma lo stesso tipo di evento viene emesso anche
        per le risposte di telemetria dei repeater remoti richieste da
        neighbor_monitor (req_telemetry_sync(), via BINARY_RESPONSE).
        Un ritardatario di una richiesta remota scaduta, arrivato
        mentre questa query è in attesa, verrebbe altrimenti salvato
        come telemetria del companion. Il frame di risposta a una
        richiesta "self" contiene invece sempre il prefisso di 6 byte
        della PROPRIA chiave pubblica (payload "pubkey_pre", esadecimale,
        12 caratteri — MyMesh.cpp del firmware companion, gestore di
        CMD_SEND_TELEMETRY_REQ a 4 byte), mentre l'evento delle
        richieste remote usa una chiave diversa ("pubkey_prefix") e
        riporta il prefisso del repeater interrogato. Se il prefisso
        atteso (da self_info["public_key"]) non è noto, o la risposta
        non lo riporta uguale, il risultato è scartato con un warning —
        meglio nessun aggiornamento che telemetria di un altro nodo
        presentata come propria.
        """

        payload = await self._get_stats_safe(
            "self_telemetry",
            self.engine.mesh.commands.get_self_telemetry
        )

        if payload is None:
            return None

        expected_prefix = str(
            self_info.get("public_key") or ""
        )[:12].lower()

        received_prefix = str(
            payload.get("pubkey_pre") or ""
        ).lower()

        if (
            not expected_prefix or
            received_prefix != expected_prefix
        ):

            log.warning(
                "ContactSyncModule: self_telemetry scartata — prefisso "
                "chiave pubblica nella risposta '%s' non corrisponde a "
                "quello atteso del companion '%s' (risposta non "
                "verificabile come propria, telemetria non aggiornata "
                "per questo giro).",
                received_prefix,
                expected_prefix
            )

            return None

        lpp = payload.get("lpp")

        if not isinstance(lpp, list):

            log.warning(
                "ContactSyncModule: self_telemetry scartata — payload "
                "'lpp' assente o non è una lista (%s), telemetria non "
                "aggiornata per questo giro.",
                type(lpp).__name__
            )

            return None

        #
        # Solo le voci ben formate (dict con 'type' stringa, il minimo
        # indispensabile per mostrarle); il resto è scartato in
        # silenzio, non c'è un campo utile da salvare in una misura
        # senza tipo. 'channel'/'value' passano invariati: value può
        # essere non scalare (es. gps -> dict, accelerometer -> dict),
        # serializzato in JSON da upsert_device_status().
        #
        return [
            {
                "channel": t.get("channel"),
                "type": t.get("type"),
                "value": t.get("value")
            }
            for t in lpp
            if isinstance(t, dict) and isinstance(t.get("type"), str)
        ]

    async def _get_stats_safe(self, label, factory):
        """
        Esegue una delle query di stato locale (stats core/radio/packets,
        device_query, self_telemetry) sotto command_lock
        (condivisa con IPC/bot come ogni altro comando sulla stessa
        connessione — locale sì, ma pur sempre unica connessione).
        Ritorna il payload (dict) o None se fallita — un fallimento
        qui non deve mai impedire alle altre di essere salvate.
        send() della libreria non solleva mai per timeout, ritorna un
        Event(ERROR) sintetico — controlliamo .type, non un except
        dedicato al timeout.
        """

        try:
            # acquire_command_lock() invece dell'accesso diretto al
            # lock (Finding 1/5, review affidabilità 2026-08-21 — v.
            # ARCHITECTURE.md §49) — riusa il label già passato dal
            # chiamante (v. _sync_device_status(): "stats_core",
            # "stats_radio", ecc.) come etichetta del chiamante.
            async with self.engine.acquire_command_lock(f"contact_sync:{label}"):
                result = await factory()

            if result.type == EventType.ERROR:

                log.warning(
                    "ContactSyncModule: %s fallita (%s).",
                    label,
                    result.payload
                )

                return None

            return result.payload

        except Exception:

            log.exception(
                "ContactSyncModule: %s fallita.",
                label
            )

            return None
