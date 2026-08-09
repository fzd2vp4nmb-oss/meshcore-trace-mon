import sqlite3
import time

from pathlib import Path

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
    path_hash_mode       INTEGER,
    txdelay              REAL,
    direct_txdelay       REAL,
    rxdelay              REAL,
    flood_max            INTEGER,
    flood_max_unscoped   INTEGER,
    flood_max_advert     INTEGER
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
);

CREATE INDEX IF NOT EXISTS idx_repeater_config_node_time
    ON repeater_config(public_key, queried_at);
"""

#
# Colonne aggiunte dopo la prima versione dello schema. Originariamente
# pensate per ricostruire il payload di add_contact() (ripristino
# contatti CHAT espulsi, poi rivelatosi non percorribile — vedi
# docs/CONTACT_MANAGEMENT.md §12). Mantenute comunque: arrivano gratis
# da get_contacts() e hanno un valore analitico proprio (last_advert/
# lastmod utili a prescindere).
#
MIGRATIONS = {
    "flags": "INTEGER",
    "out_path_hash_mode": "INTEGER",
    "last_advert": "INTEGER",
    "lastmod": "INTEGER"
}


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
        self._conn.executescript(SCHEMA)
        self._conn.commit()

        self._migrate()

    def _migrate(self):

        existing = {
            row[1]
            for row in self._conn.execute("PRAGMA table_info(nodes)")
        }

        for column, column_type in MIGRATIONS.items():

            if column not in existing:

                self._conn.execute(
                    f"ALTER TABLE nodes ADD COLUMN {column} {column_type}"
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
        seen_at=None
    ):
        """
        Crea o aggiorna un nodo. I campi None non sovrascrivono un
        valore già presente (COALESCE) — importante perché questa
        funzione viene chiamata sia da RX_LOG_DATA (che non porta
        out_path/flags/ecc.) sia dal sync periodico via
        get_contacts() (che li porta tutti) — nessuna delle due
        sorgenti deve poter cancellare dati forniti dall'altra.
        """

        seen_at = seen_at or int(time.time())

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
        recv_errors=None
    ):
        """
        Inserisce una riga di status per il repeater interrogato —
        log temporale (una riga per query), non un "ultimo stato"
        sovrascritto — vedi docs/NEIGHBOR_MONITORING.md §5. Richiede
        che public_key sia già presente in nodes (FK) — il chiamante
        deve fare upsert_node() prima, se necessario.
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

        self._conn.commit()

    def insert_repeater_neighbours(
        self,
        public_key,
        queried_at,
        neighbours
    ):
        """
        Inserisce tutte le righe neighbour di una query in un colpo
        solo (executemany + singolo commit). 'neighbours' è la lista
        così come restituita da fetch_all_neighbours() — dict con
        chiavi 'pubkey' (prefisso, non chiave completa), 'secs_ago',
        'snr'.
        """

        if not neighbours:
            return

        rows = [
            (
                public_key,
                queried_at,
                n.get("pubkey"),
                n.get("secs_ago"),
                n.get("snr")
            )
            for n in neighbours
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

        self._conn.commit()

    def insert_repeater_telemetry(
        self,
        public_key,
        queried_at,
        telemetry
    ):
        """
        Inserisce tutti i canali telemetria di una query in un colpo
        solo (executemany + singolo commit). 'telemetry' è la lista
        così come restituita da req_telemetry_sync() — dict con
        chiavi 'channel', 'type', 'value' (già decodificati dalla
        libreria dal formato Cayenne LPP).
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

        self._conn.commit()

    def insert_repeater_region(
        self,
        public_key,
        queried_at,
        region_dump
    ):
        """
        Inserisce il dump regioni di una query — una sola riga per
        query (a differenza di neighbours/telemetry, non è una lista
        di elementi). 'region_dump' è la stringa così come
        restituita da req_regions_sync(), testo grezzo non parsato.
        """

        if not region_dump:
            return

        self._conn.execute(
            """
            INSERT INTO repeater_region (
                public_key, queried_at, region_dump
            )
            VALUES (?, ?, ?)
            """,
            (public_key, queried_at, region_dump)
        )

        self._conn.commit()

    def insert_repeater_config(
        self,
        public_key,
        queried_at,
        firmware_version=None,
        path_hash_mode=None,
        txdelay=None,
        direct_txdelay=None,
        rxdelay=None,
        flood_max=None,
        flood_max_unscoped=None,
        flood_max_advert=None
    ):
        """
        Inserisce una riga di configurazione CLI per il repeater —
        log temporale (una riga per query, tutte le colonne in una
        volta), come repeater_status. Ogni parametro può essere None
        indipendentemente dagli altri se quel singolo comando non ha
        ricevuto risposta.
        """

        self._conn.execute(
            """
            INSERT INTO repeater_config (
                public_key, queried_at, firmware_version,
                path_hash_mode, txdelay, direct_txdelay, rxdelay,
                flood_max, flood_max_unscoped, flood_max_advert
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                public_key, queried_at, firmware_version,
                path_hash_mode, txdelay, direct_txdelay, rxdelay,
                flood_max, flood_max_unscoped, flood_max_advert
            )
        )

        self._conn.commit()
