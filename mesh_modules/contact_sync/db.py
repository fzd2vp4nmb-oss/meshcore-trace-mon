import sqlite3
import time

from contextlib import contextmanager
from pathlib import Path

from core.logger import log

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    public_key          TEXT PRIMARY KEY,
    adv_name            TEXT,
    node_type           INTEGER,
    adv_lat              REAL,
    adv_lon              REAL,
    out_path_len        INTEGER,
    out_path            TEXT,
    flags               INTEGER,
    out_path_hash_mode  INTEGER,
    last_advert         INTEGER,
    lastmod             INTEGER,
    first_seen          INTEGER NOT NULL,
    last_seen           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS path_observations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key     TEXT NOT NULL REFERENCES nodes(public_key),
    observed_at    INTEGER NOT NULL,
    adv_timestamp  INTEGER,
    pkt_hash       INTEGER,
    path_hex       TEXT,
    hop_count      INTEGER NOT NULL,
    route_type     TEXT,
    transport_code TEXT,
    rssi           REAL,
    snr            REAL
);

CREATE INDEX IF NOT EXISTS idx_path_obs_node_time
    ON path_observations(public_key, observed_at);

CREATE INDEX IF NOT EXISTS idx_path_obs_pkt_hash
    ON path_observations(pkt_hash);

CREATE TABLE IF NOT EXISTS repeater_status (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key     TEXT NOT NULL REFERENCES nodes(public_key),
    queried_at     INTEGER NOT NULL,
    bat            INTEGER,
    tx_queue_len   INTEGER,
    noise_floor    INTEGER,
    last_rssi      INTEGER,
    nb_recv        INTEGER,
    nb_sent        INTEGER,
    airtime        INTEGER,
    uptime         INTEGER,
    sent_flood     INTEGER,
    sent_direct    INTEGER,
    recv_flood     INTEGER,
    recv_direct    INTEGER,
    full_evts      INTEGER,
    last_snr       REAL,
    direct_dups    INTEGER,
    flood_dups     INTEGER,
    rx_airtime     INTEGER,
    recv_errors    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_repeater_status_node_time
    ON repeater_status(public_key, queried_at);

CREATE TABLE IF NOT EXISTS repeater_neighbours (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key        TEXT NOT NULL REFERENCES nodes(public_key),
                      -- il repeater INTERROGATO, non il neighbour
    queried_at        INTEGER NOT NULL,
    neighbour_prefix  TEXT NOT NULL,
                      -- solo prefisso (4 byte di default), NON FK
                      -- diretta verso nodes — vedi
                      -- docs/NEIGHBOR_MONITORING.md §5
    secs_ago          INTEGER,
    snr               REAL
);

CREATE INDEX IF NOT EXISTS idx_repeater_neighbours_node_time
    ON repeater_neighbours(public_key, queried_at);

CREATE TABLE IF NOT EXISTS repeater_telemetry (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key    TEXT NOT NULL REFERENCES nodes(public_key),
    queried_at    INTEGER NOT NULL,
    channel       INTEGER NOT NULL,
                 -- numero canale LPP come riportato dal firmware
                 -- (es. 1) — nomenclatura del device, non nostra
    type          TEXT NOT NULL,
                 -- es. "voltage", "temperature" — nome tipo LPP già
                 -- risolto in stringa dalla libreria meshcore_py
    value         REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repeater_telemetry_node_time
    ON repeater_telemetry(public_key, queried_at);

CREATE TABLE IF NOT EXISTS repeater_region (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key    TEXT NOT NULL REFERENCES nodes(public_key),
    queried_at    INTEGER NOT NULL,
    region_dump   TEXT NOT NULL
                 -- testo grezzo restituito da req_regions_sync()
                 -- (AnonReqType, nessun ACL) — non parsato, la
                 -- struttura interna del dump non è nota a priori.
                 -- Tabella indipendente, NON una colonna di
                 -- repeater_status: a differenza di
                 -- status/neighbours/telemetria (stesso gate ACL,
                 -- esito tipicamente condiviso), regions non
                 -- richiede alcun ACL — può riuscire anche quando
                 -- status fallisce, quindi non va accoppiata al suo
                 -- queried_at.
);

CREATE INDEX IF NOT EXISTS idx_repeater_region_node_time
    ON repeater_region(public_key, queried_at);

CREATE TABLE IF NOT EXISTS repeater_config (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key           TEXT NOT NULL REFERENCES nodes(public_key),
    queried_at           INTEGER NOT NULL,
    firmware_version     TEXT,
    hardware             TEXT,
    path_hash_mode       INTEGER,
    txdelay              REAL,
    direct_txdelay       REAL,
    rxdelay              REAL,
    flood_max            INTEGER,
    flood_max_unscoped   INTEGER,
    flood_max_advert     INTEGER,
    region_default       TEXT,
    dutycycle            REAL
                        -- ottenuti via login (password vuota,
                        -- sufficiente quando il richiedente ha già
                        -- il bit admin nell'ACL) + comandi CLI
                        -- testuali (ver/get ...), non con richieste
                        -- binarie strutturate come le altre tabelle.
                        -- Requisito di permesso più stringente
                        -- (login+admin, non solo ACL di lettura) —
                        -- tabella indipendente come repeater_region,
                        -- stesso motivo: può fallire o riuscire
                        -- indipendentemente da status. Ogni colonna
                        -- singolarmente NULL se quel comando non ha
                        -- ricevuto risposta (radio silence LoRa, non
                        -- necessariamente comando inesistente — vedi
                        -- docs/NEIGHBOR_MONITORING.md §12).
                        -- region_default/dutycycle aggiunte in §14
                        -- ("region default" e "get dutycycle").
                        -- hardware aggiunta in §19 ("board").
);

CREATE INDEX IF NOT EXISTS idx_repeater_config_node_time
    ON repeater_config(public_key, queried_at);

CREATE TABLE IF NOT EXISTS repeater_clock (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key     TEXT NOT NULL REFERENCES nodes(public_key),
    queried_at     INTEGER NOT NULL,   -- clock del NOSTRO Companion/host
    remote_clock   INTEGER NOT NULL,   -- clock dichiarato dal repeater
    skew_seconds   INTEGER NOT NULL
                  -- remote_clock - queried_at, pre-calcolato per non
                  -- doverlo rifare ad ogni lettura frontend. Da
                  -- req_basic_sync() (AnonReqType.BASIC, nessun ACL,
                  -- stesso gate di repeater_region) — tabella
                  -- indipendente per lo stesso motivo: può riuscire
                  -- anche quando status fallisce per permessi.
);

CREATE INDEX IF NOT EXISTS idx_repeater_clock_node_time
    ON repeater_clock(public_key, queried_at);

CREATE TABLE IF NOT EXISTS device_status (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
                  -- riga singola forzata dal CHECK — non è uno
                  -- storico (a differenza di repeater_status), è
                  -- "lo stato ATTUALE del companion collegato a
                  -- trace-mon stesso", sovrascritta ad ogni sync.
    updated_at     INTEGER NOT NULL,
    battery_mv     INTEGER,
    uptime_secs    INTEGER,
    errors         INTEGER,
    queue_len      INTEGER,
    noise_floor    INTEGER,
    last_rssi      INTEGER,
    last_snr       REAL,
    tx_air_secs    INTEGER,
    rx_air_secs    INTEGER,
    recv           INTEGER,
    sent           INTEGER,
    flood_tx       INTEGER,
    direct_tx      INTEGER,
    flood_rx       INTEGER,
    direct_rx      INTEGER,
    recv_errors    INTEGER,
    model          TEXT,
    fw_build       TEXT,
    fw_version     TEXT
                  -- da send_device_query() (EventType.DEVICE_INFO) —
                  -- identità hardware/firmware statica del companion,
                  -- non una metrica runtime, ma sincronizzata nello
                  -- stesso giro per semplicità (query locale anch'essa,
                  -- costo trascurabile a ripeterla).
);

CREATE TABLE IF NOT EXISTS telegram_settings (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
                  -- riga singola forzata dal CHECK, stesso pattern di
                  -- device_status: non uno storico, è la
                  -- configurazione ATTUALE del gestore per le
                  -- notifiche Telegram (config.yaml, sezione
                  -- 'telegram'), sovrascritta a ogni avvio del daemon
                  -- — dato locale di configurazione, non acquisito
                  -- dalla mesh. Letta dal Collettore (che riceve una
                  -- copia di questo DB via contact_sync.sh) per sapere
                  -- a chi inviare le notifiche — v.
                  -- docs/ARCHITECTURE.md §55.
    chat_id     TEXT,
                  -- chat ID Telegram del gestore nodo, o NULL se non
                  -- ancora configurato (config.sh, menu "Telegram").
                  -- Può contenere più chat ID separati da virgola
                  -- (es. "111111,222222") per notificare più persone
                  -- — nessuna validazione qui: il valore viaggia
                  -- verbatim da config.yaml, è il Collettore a
                  -- interpretarlo (docs/ARCHITECTURE.md §56.12). Mai
                  -- il token dell'API: quello non vive in questo
                  -- database, solo lato Collettore.
    enabled     INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
);
"""

#
# Colonne aggiunte dopo la prima versione dello schema, per tabella.
# CREATE TABLE IF NOT EXISTS non aggiunge colonne a una tabella che
# esiste già — serve un ALTER TABLE esplicito per chi ha un
# contacts.db creato da una versione precedente del codice.
#
MIGRATIONS = {
    "nodes": {
        # Originariamente pensate per ricostruire il payload di
        # add_contact() (ripristino contatti CHAT espulsi, poi
        # rivelatosi non percorribile — vedi
        # docs/CONTACT_MANAGEMENT.md §12). Mantenute comunque:
        # arrivano gratis da get_contacts() e hanno un valore
        # analitico proprio (last_advert/lastmod utili a prescindere).
        "flags": "INTEGER",
        "out_path_hash_mode": "INTEGER",
        "last_advert": "INTEGER",
        "lastmod": "INTEGER"
    },
    "device_status": {
        # Identità hardware/firmware del companion
        # (send_device_query()), aggiunta dopo la prima versione
        # della tabella.
        "model": "TEXT",
        "fw_build": "TEXT",
        "fw_version": "TEXT",
        # Posizione geografica del companion connesso a trace-mon
        # stesso, aggiunta per la pagina di dettaglio traccia con
        # mappa (frontend). A differenza degli altri campi di questa
        # tabella, NON viene da una query locale al device (nessuna
        # delle quattro get_stats_*/send_device_query): arriva da
        # mesh.self_info (evento SELF_INFO, già popolato ad ogni
        # connessione da send_appstart() — v. commento in
        # SystemService._status_result()), impostata sul device
        # dall'operatore con DeviceCommands.set_coords(). Se
        # l'operatore non l'ha mai configurata, resta NULL: nessun
        # valore di default, il frontend deve trattare l'assenza come
        # "posizione non nota", non come 0.0/0.0 (che sarebbe una
        # coordinata reale, al largo del Golfo di Guinea).
        "adv_lat": "REAL",
        "adv_lon": "REAL"
    },
    "repeater_config": {
        # Aggiunti ai comandi CLI testuali di CLI_QUERIES dopo la
        # prima versione della tabella (vedi
        # docs/NEIGHBOR_MONITORING.md §14): "region default" e
        # "get dutycycle".
        "region_default": "TEXT",
        "dutycycle": "REAL",
        # Aggiunta in §19: "board" (nome hardware del repeater).
        "hardware": "TEXT"
    }
}

#
# Difesa in profondità (code review 2026-08-20, §3.4): i campi TEXT
# sotto arrivano da fonte radio non autenticata (adv_name annunciato
# da qualunque device in portata, path_hex/region_dump/firmware_
# version/hardware restituiti dal repeater interrogato) e SQLite TEXT
# non impone alcun limite di lunghezza. Il rischio si sposta a valle
# nel frontend, che legge questi stessi campi (v. code review §1.1,
# XSS — già corretto lato frontend con escapeHtml, ma un limite qui
# resta una seconda linea di difesa indipendente, oltre a impedire
# che un singolo campo anomalo gonfi eccessivamente il DB). I limiti
# sono generosi rispetto a qualunque valore legittimo osservato, per
# non rischiare di troncare dati reali.
#
MAX_ADV_NAME_LEN = 128
MAX_PATH_HEX_LEN = 256
MAX_REGION_DUMP_LEN = 4096
MAX_CLI_TEXT_LEN = 128


def _clamp_text(value, max_len):
    """Tronca value a max_len caratteri se è una stringa più lunga;
    None e non-stringhe passano invariati (validati/normalizzati
    altrove, non responsabilità di questo helper)."""

    if isinstance(value, str) and len(value) > max_len:
        return value[:max_len]

    return value


class ContactDB:
    """
    Accesso SQLite per la gestione contatti/path — schema e
    motivazioni delle scelte in docs/CONTACT_MANAGEMENT.md.

    Connessione sincrona: le scritture sono singole insert veloci,
    non giustificano una dipendenza async (aiosqlite) in un progetto
    che punta alla minima dipendenza esterna possibile.
    """

    def __init__(self, db_path):

        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(
            parents=True,
            exist_ok=True
        )

        self._conn = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False
        )

        #
        # WAL invece del rollback journal di default: i lettori
        # (frontend via node:sqlite readOnly) non bloccano più lo
        # scrittore, e viceversa, durante le scritture normali.
        # busy_timeout fa sì che un conflitto di lock residuo (es.
        # col futuro tools/rotate_path_observations.py, che opera
        # sullo stesso file da un processo separato) faccia
        # attendere la connessione invece di fallire subito con
        # "database is locked" — 5s è ampiamente sufficiente per un
        # DELETE+VACUUM su un DB tenuto bounded dalla rotazione
        # mensile.
        #
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA busy_timeout = 5000")
        self._conn.execute("PRAGMA foreign_keys = ON")

        #
        # synchronous=NORMAL invece del default FULL (valutazione
        # usura storage, 2026-08-20) — raccomandazione standard di
        # SQLite stessa per il modo WAL: in WAL, NORMAL resta sicuro
        # contro la corruzione del database (l'atomicità è garantita
        # dal WAL stesso) — l'unico rischio residuo è perdere le
        # transazioni committate più di recente in caso di perdita di
        # alimentazione improvvisa prima del prossimo checkpoint, non
        # un danno al database, che resta comunque in uno stato
        # consistente. Con FULL (mai cambiato finora), ogni singolo
        # commit di questa connessione — una riga di
        # path_observations per advert osservato (rate-limitata a
        # MIN_PATH_OBSERVATION_INTERVAL=2s per nodo, v.
        # contact_sync.py), più le scritture di
        # NeighborMonitorWriter — forza un fsync separato. Con NORMAL,
        # SQLite sincronizza solo ai checkpoint WAL, non ad ogni
        # commit: riduce sensibilmente la frequenza di scritture
        # forzate sul supporto fisico, rilevante per l'usura di una SD
        # card/SSD sotto un pattern di tante piccole scritture
        # frequenti. Applicato qui perché ContactDB è la connessione
        # condivisa da ENTRAMBI i chiamanti che generano questo
        # pattern (v. i due `ContactDB(...)` in
        # contact_sync/contact_sync.py e
        # neighbor_monitor/writer.py) — non tocca le connessioni
        # sqlite3 separate aperte da tools/rotate_path_observations.py
        # /tools/rotate_repeater_neighbours.py (operazioni mensili
        # bulk, un solo VACUUM per esecuzione: la frequenza di commit
        # non è il loro problema) né la connessione `sqlite3` a riga
        # di comando usata da contact_sync.sh per `VACUUM INTO` (v.
        # invece la fix in quello script per la sua parte).
        #
        self._conn.execute("PRAGMA synchronous = NORMAL")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

        self._migrate()

    def _migrate(self):

        for table, columns in MIGRATIONS.items():

            existing = {
                row[1]
                for row in self._conn.execute(
                    f"PRAGMA table_info({table})"
                )
            }

            for column, column_type in columns.items():

                if column not in existing:

                    self._conn.execute(
                        f"ALTER TABLE {table} ADD COLUMN {column} {column_type}"
                    )

        self._conn.commit()

    def upsert_node(
        self,
        public_key,
        adv_name=None,
        node_type=None,
        adv_lat=None,
        adv_lon=None,
        out_path=None,
        out_path_len=None,
        flags=None,
        out_path_hash_mode=None,
        last_advert=None,
        lastmod=None,
        seen_at=None,
        commit=True
    ):
        """
        Crea o aggiorna un nodo. I campi None non sovrascrivono un
        valore già presente (COALESCE) — importante perché questa
        funzione viene chiamata sia da RX_LOG_DATA (che non porta
        out_path/flags/ecc.) sia dal sync periodico via
        get_contacts() (che li porta tutti) — nessuna delle due
        sorgenti deve poter cancellare dati forniti dall'altra.

        commit=False per usare questa chiamata dentro un blocco
        transaction() più ampio (v. code review 2026-08-20, §3.4).
        """

        seen_at = seen_at or int(time.time())

        #
        # v. MAX_ADV_NAME_LEN — adv_name proviene dalla rete mesh,
        # controllato dal device remoto (code review 2026-08-20,
        # §3.4).
        #
        adv_name = _clamp_text(adv_name, MAX_ADV_NAME_LEN)

        self._conn.execute(
            """
            INSERT INTO nodes (
                public_key, adv_name, node_type, adv_lat, adv_lon,
                out_path, out_path_len, flags, out_path_hash_mode,
                last_advert, lastmod, first_seen, last_seen
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(public_key) DO UPDATE SET
                adv_name           = COALESCE(excluded.adv_name, nodes.adv_name),
                node_type          = COALESCE(excluded.node_type, nodes.node_type),
                adv_lat            = COALESCE(excluded.adv_lat, nodes.adv_lat),
                adv_lon            = COALESCE(excluded.adv_lon, nodes.adv_lon),
                out_path           = COALESCE(excluded.out_path, nodes.out_path),
                out_path_len       = COALESCE(excluded.out_path_len, nodes.out_path_len),
                flags              = COALESCE(excluded.flags, nodes.flags),
                out_path_hash_mode = COALESCE(excluded.out_path_hash_mode, nodes.out_path_hash_mode),
                last_advert        = COALESCE(excluded.last_advert, nodes.last_advert),
                lastmod            = COALESCE(excluded.lastmod, nodes.lastmod),
                last_seen          = excluded.last_seen
            """,
            (
                public_key, adv_name, node_type, adv_lat, adv_lon,
                out_path, out_path_len, flags, out_path_hash_mode,
                last_advert, lastmod, seen_at, seen_at
            )
        )

        if commit:
            self._conn.commit()

    def insert_path_observation(
        self,
        public_key,
        observed_at,
        adv_timestamp,
        pkt_hash,
        path_hex,
        hop_count,
        route_type,
        transport_code,
        rssi,
        snr
    ):

        #
        # v. MAX_PATH_HEX_LEN — path_hex proviene dalla rete mesh
        # (code review 2026-08-20, §3.4).
        #
        path_hex = _clamp_text(path_hex, MAX_PATH_HEX_LEN)

        self._conn.execute(
            """
            INSERT INTO path_observations (
                public_key, observed_at, adv_timestamp, pkt_hash,
                path_hex, hop_count, route_type, transport_code,
                rssi, snr
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                public_key, observed_at, adv_timestamp, pkt_hash,
                path_hex, hop_count, route_type, transport_code,
                rssi, snr
            )
        )

        self._conn.commit()

    def close(self):
        self._conn.close()

    @contextmanager
    def transaction(self):
        """
        Raggruppa più insert/upsert in un'unica transazione atomica
        (code review 2026-08-20, §3.4) — prima ogni insert_repeater_*
        committava indipendentemente: un crash o un'eccezione a metà
        di un giro di polling repeater (es. un elemento neighbours
        malformato) lasciava stato incoerente tra tabelle che il
        chiamante considera un'unità logica (status/neighbours/
        telemetry/... dello stesso queried_at). Le chiamate dentro il
        blocco `with` devono passare commit=False ai metodi
        insert_*/upsert_* che lo supportano (v. NeighborMonitorWriter
        per l'uso) — il commit avviene una sola volta qui, alla fine,
        o mai in caso di eccezione (rollback automatico).

        Non annidabile: non usare transaction() dentro un altro
        blocco transaction() sulla stessa connessione.
        """

        try:
            yield self

        except Exception:
            self._conn.rollback()
            raise

        else:
            self._conn.commit()

    def insert_repeater_status(
        self,
        public_key,
        queried_at,
        bat=None,
        tx_queue_len=None,
        noise_floor=None,
        last_rssi=None,
        nb_recv=None,
        nb_sent=None,
        airtime=None,
        uptime=None,
        sent_flood=None,
        sent_direct=None,
        recv_flood=None,
        recv_direct=None,
        full_evts=None,
        last_snr=None,
        direct_dups=None,
        flood_dups=None,
        rx_airtime=None,
        recv_errors=None,
        commit=True
    ):
        """
        Inserisce una riga di status per il repeater interrogato —
        log temporale (una riga per query), non un "ultimo stato"
        sovrascritto — vedi docs/NEIGHBOR_MONITORING.md §5. Richiede
        che public_key sia già presente in nodes (FK) — il chiamante
        deve fare upsert_node() prima, se necessario.

        commit=False per usare questa chiamata dentro un blocco
        transaction() più ampio (v. code review 2026-08-20, §3.4).
        """

        self._conn.execute(
            """
            INSERT INTO repeater_status (
                public_key, queried_at, bat, tx_queue_len, noise_floor,
                last_rssi, nb_recv, nb_sent, airtime, uptime,
                sent_flood, sent_direct, recv_flood, recv_direct,
                full_evts, last_snr, direct_dups, flood_dups,
                rx_airtime, recv_errors
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                public_key, queried_at, bat, tx_queue_len, noise_floor,
                last_rssi, nb_recv, nb_sent, airtime, uptime,
                sent_flood, sent_direct, recv_flood, recv_direct,
                full_evts, last_snr, direct_dups, flood_dups,
                rx_airtime, recv_errors
            )
        )

        if commit:
            self._conn.commit()

    def upsert_device_status(
        self,
        updated_at,
        battery_mv=None,
        uptime_secs=None,
        errors=None,
        queue_len=None,
        noise_floor=None,
        last_rssi=None,
        last_snr=None,
        tx_air_secs=None,
        rx_air_secs=None,
        recv=None,
        sent=None,
        flood_tx=None,
        direct_tx=None,
        flood_rx=None,
        direct_rx=None,
        recv_errors=None,
        model=None,
        fw_build=None,
        fw_version=None,
        adv_lat=None,
        adv_lon=None
    ):
        """
        Stato corrente del companion connesso a trace-mon stesso (non
        un repeater remoto) — riga singola (id=1 fisso), sovrascritta
        ad ogni giro invece che accumulata come repeater_status. Un
        gruppo di campi None (es. tutti quelli 'radio') significa che
        quella singola query locale è fallita in questo giro — resta
        il valore del giro precedente (COALESCE), non viene azzerato.
        Il chiamante è responsabile di non richiamare questa funzione
        affatto se TUTTE le query del giro sono fallite (in tal caso
        updated_at deve restare quello dell'ultimo giro riuscito).

        adv_lat/adv_lon seguono la stessa convenzione COALESCE degli
        altri campi, ma la loro fonte (mesh.self_info, v. chiamante in
        contact_sync.py) non fa parte delle quattro query locali di
        cui sopra: possono quindi essere presenti anche in un giro in
        cui, per esempio, i campi 'radio' sono None per una query
        fallita — indipendenza voluta, non un'incoerenza.
        """

        self._conn.execute(
            """
            INSERT INTO device_status (
                id, updated_at, battery_mv, uptime_secs, errors,
                queue_len, noise_floor, last_rssi, last_snr,
                tx_air_secs, rx_air_secs, recv, sent, flood_tx,
                direct_tx, flood_rx, direct_rx, recv_errors, model,
                fw_build, fw_version, adv_lat, adv_lon
            )
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                updated_at  = excluded.updated_at,
                battery_mv  = COALESCE(excluded.battery_mv, device_status.battery_mv),
                uptime_secs = COALESCE(excluded.uptime_secs, device_status.uptime_secs),
                errors      = COALESCE(excluded.errors, device_status.errors),
                queue_len   = COALESCE(excluded.queue_len, device_status.queue_len),
                noise_floor = COALESCE(excluded.noise_floor, device_status.noise_floor),
                last_rssi   = COALESCE(excluded.last_rssi, device_status.last_rssi),
                last_snr    = COALESCE(excluded.last_snr, device_status.last_snr),
                tx_air_secs = COALESCE(excluded.tx_air_secs, device_status.tx_air_secs),
                rx_air_secs = COALESCE(excluded.rx_air_secs, device_status.rx_air_secs),
                recv        = COALESCE(excluded.recv, device_status.recv),
                sent        = COALESCE(excluded.sent, device_status.sent),
                flood_tx    = COALESCE(excluded.flood_tx, device_status.flood_tx),
                direct_tx   = COALESCE(excluded.direct_tx, device_status.direct_tx),
                flood_rx    = COALESCE(excluded.flood_rx, device_status.flood_rx),
                direct_rx   = COALESCE(excluded.direct_rx, device_status.direct_rx),
                recv_errors = COALESCE(excluded.recv_errors, device_status.recv_errors),
                model       = COALESCE(excluded.model, device_status.model),
                fw_build    = COALESCE(excluded.fw_build, device_status.fw_build),
                fw_version  = COALESCE(excluded.fw_version, device_status.fw_version),
                adv_lat     = COALESCE(excluded.adv_lat, device_status.adv_lat),
                adv_lon     = COALESCE(excluded.adv_lon, device_status.adv_lon)
            """,
            (
                updated_at, battery_mv, uptime_secs, errors, queue_len,
                noise_floor, last_rssi, last_snr, tx_air_secs,
                rx_air_secs, recv, sent, flood_tx, direct_tx, flood_rx,
                direct_rx, recv_errors, model, fw_build, fw_version,
                adv_lat, adv_lon
            )
        )

        self._conn.commit()

    def upsert_telegram_settings(
        self,
        updated_at,
        chat_id,
        enabled
    ):
        """
        Configurazione Telegram corrente del gestore nodo, letta per
        intero da config.yaml (sezione 'telegram') — non un dato
        acquisito dalla mesh. Riga singola (id=1 fisso, stesso pattern
        di upsert_device_status()), sovrascritta interamente a ogni
        avvio del daemon (v. ContactSyncModule.start()).

        A differenza di upsert_device_status() (dati radio parziali/
        intermittenti, dove None deve preservare il valore del giro
        precedente via COALESCE), qui il chiamante fornisce sempre
        l'intera configurazione in un colpo solo: niente COALESCE, un
        valore esplicitamente vuoto/disabilitato in config.yaml deve
        sovrascrivere, non conservare uno stato residuo di una
        configurazione precedente (un gestore che disabilita la
        funzione se la aspetta spenta subito, non al prossimo riavvio
        in cui capitasse di passare di qui con un valore parziale).
        """

        self._conn.execute(
            """
            INSERT INTO telegram_settings (id, updated_at, chat_id, enabled)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                updated_at = excluded.updated_at,
                chat_id    = excluded.chat_id,
                enabled    = excluded.enabled
            """,
            (updated_at, chat_id or None, 1 if enabled else 0)
        )

        self._conn.commit()

    def insert_repeater_neighbours(
        self,
        public_key,
        queried_at,
        neighbours,
        commit=True
    ):
        """
        Inserisce tutte le righe neighbour di una query in un colpo
        solo (executemany + singolo commit, salvo commit=False per
        uso dentro transaction() — v. code review 2026-08-20, §3.4).
        'neighbours' è la lista così come restituita da
        fetch_all_neighbours() — dict con chiavi 'pubkey' (prefisso,
        non chiave completa), 'secs_ago', 'snr'.

        Prima di questo fix (code review 2026-08-20, §3.4), un solo
        elemento con 'pubkey' None faceva fallire l'intero
        executemany (violazione NOT NULL su neighbour_prefix) — con
        perdita silenziosa di TUTTI i neighbours del giro, non solo
        dell'elemento malformato. Gli elementi senza 'pubkey' vengono
        ora scartati esplicitamente prima dell'insert, con un log
        che elenca quanti sono stati scartati — i neighbours validi
        dello stesso giro vengono comunque salvati.
        """

        if not neighbours:
            return

        valid_neighbours = [
            n for n in neighbours
            if n.get("pubkey")
        ]

        dropped = len(neighbours) - len(valid_neighbours)

        if dropped:
            log.warning(
                "ContactDB: %d/%d elementi neighbour scartati "
                "(pubkey mancante) per public_key=%s, queried_at=%s.",
                dropped,
                len(neighbours),
                public_key,
                queried_at
            )

        if not valid_neighbours:
            return

        rows = [
            (
                public_key,
                queried_at,
                n.get("pubkey"),
                n.get("secs_ago"),
                n.get("snr")
            )
            for n in valid_neighbours
        ]

        self._conn.executemany(
            """
            INSERT INTO repeater_neighbours (
                public_key, queried_at, neighbour_prefix, secs_ago, snr
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            rows
        )

        if commit:
            self._conn.commit()

    def insert_repeater_telemetry(
        self,
        public_key,
        queried_at,
        telemetry,
        commit=True
    ):
        """
        Inserisce tutti i canali telemetria di una query in un colpo
        solo (executemany + singolo commit, salvo commit=False per
        uso dentro transaction() — v. code review 2026-08-20, §3.4).
        'telemetry' è la lista così come restituita da
        req_telemetry_sync() — dict con chiavi 'channel', 'type',
        'value' (già decodificati dalla libreria dal formato Cayenne
        LPP).
        """

        if not telemetry:
            return

        rows = [
            (
                public_key,
                queried_at,
                t.get("channel"),
                t.get("type"),
                t.get("value")
            )
            for t in telemetry
        ]

        self._conn.executemany(
            """
            INSERT INTO repeater_telemetry (
                public_key, queried_at, channel, type, value
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            rows
        )

        if commit:
            self._conn.commit()

    def insert_repeater_region(
        self,
        public_key,
        queried_at,
        region_dump,
        commit=True
    ):
        """
        Inserisce il dump regioni di una query — una sola riga per
        query (a differenza di neighbours/telemetry, non è una lista
        di elementi). 'region_dump' è la stringa così come
        restituita da req_regions_sync(), testo grezzo non parsato.

        commit=False per usare questa chiamata dentro un blocco
        transaction() più ampio (v. code review 2026-08-20, §3.4).
        """

        if not region_dump:
            return

        #
        # v. MAX_REGION_DUMP_LEN — region_dump proviene dal repeater
        # interrogato via radio (code review 2026-08-20, §3.4).
        #
        region_dump = _clamp_text(region_dump, MAX_REGION_DUMP_LEN)

        self._conn.execute(
            """
            INSERT INTO repeater_region (
                public_key, queried_at, region_dump
            )
            VALUES (?, ?, ?)
            """,
            (public_key, queried_at, region_dump)
        )

        if commit:
            self._conn.commit()

    def insert_repeater_config(
        self,
        public_key,
        queried_at,
        firmware_version=None,
        hardware=None,
        path_hash_mode=None,
        txdelay=None,
        direct_txdelay=None,
        rxdelay=None,
        flood_max=None,
        flood_max_unscoped=None,
        flood_max_advert=None,
        region_default=None,
        dutycycle=None,
        commit=True
    ):
        """
        Inserisce una riga di configurazione CLI per il repeater —
        log temporale (una riga per query, tutte le colonne in una
        volta), come repeater_status. Ogni parametro può essere None
        indipendentemente dagli altri se quel singolo comando non ha
        ricevuto risposta.

        commit=False per usare questa chiamata dentro un blocco
        transaction() più ampio (v. code review 2026-08-20, §3.4).
        """

        #
        # v. MAX_CLI_TEXT_LEN — firmware_version/hardware provengono
        # dal repeater interrogato via CLI radio (code review
        # 2026-08-20, §3.4).
        #
        firmware_version = _clamp_text(firmware_version, MAX_CLI_TEXT_LEN)
        hardware = _clamp_text(hardware, MAX_CLI_TEXT_LEN)

        self._conn.execute(
            """
            INSERT INTO repeater_config (
                public_key, queried_at, firmware_version, hardware,
                path_hash_mode, txdelay, direct_txdelay, rxdelay,
                flood_max, flood_max_unscoped, flood_max_advert,
                region_default, dutycycle
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                public_key, queried_at, firmware_version, hardware,
                path_hash_mode, txdelay, direct_txdelay, rxdelay,
                flood_max, flood_max_unscoped, flood_max_advert,
                region_default, dutycycle
            )
        )

        if commit:
            self._conn.commit()

    def insert_repeater_clock(
        self,
        public_key,
        queried_at,
        remote_clock,
        skew_seconds,
        commit=True
    ):
        """
        Inserisce una riga di scarto orologio — una sola riga per
        query, come repeater_region (stesso gate ACL: AnonReqType,
        nessun permesso richiesto). skew_seconds arriva già calcolato
        dal chiamante (remote_clock - queried_at), non ricalcolato
        qui, per usare esattamente lo stesso queried_at con cui viene
        salvata la riga.

        commit=False per usare questa chiamata dentro un blocco
        transaction() più ampio (v. code review 2026-08-20, §3.4).
        """

        self._conn.execute(
            """
            INSERT INTO repeater_clock (
                public_key, queried_at, remote_clock, skew_seconds
            )
            VALUES (?, ?, ?, ?)
            """,
            (public_key, queried_at, remote_clock, skew_seconds)
        )

        if commit:
            self._conn.commit()
