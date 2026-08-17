const express = require("express");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const { DatabaseSync } = require("node:sqlite");

const {
    parseTraceFile,
    parseTraceContent
} = require("./parser");

const app = express();

//
// Solo per etichettare gli snapshot storici dei neighbours
// (/api/neighbors/:publicKey/archive/snapshots) — formato leggibile,
// non serve altrove lato server (il resto della formattazione data
// vive lato client in app.js).
//
function formatUnixTimeServer(
    unixSeconds
) {

    const d = new Date(unixSeconds * 1000);

    const pad = n => String(n).padStart(2, "0");

    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
}

/* =========================
   FILE PATH
========================= */

const FILE =
    path.join(
        __dirname,
        "..",
        "data",
        "trace.json"
    );

const BACKUP_DIR =
    path.join(
        __dirname,
        "..",
        "backup"
    );

const CONTACTS_DB_FILE =
    path.join(
        __dirname,
        "..",
        "data",
        "contacts.db"
    );

/* =========================
   LIVE DATA API
========================= */

app.get(
    "/api/data",
    (
        req,
        res
    ) => {

        try {

            const data =
                parseTraceFile(
                    FILE
                );

            res.json(
                data
            );

        }

        catch (
            err
        ) {

            console.error(
                "API ERROR:",
                err
            );

            res
                .status(
                    500
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/* =========================
   MESHNODES API (contacts.db)

   Mappa public_key completa -> nome, per i tooltip del frontend
   (tab Trace e tab Nodes) — prima letta da frontend/mesh-nodes.json
   (curato a mano, poi automatizzato da config.sh), ora una query
   diretta su contacts.db: l'informazione è già lì, un file separato
   era solo un sottoinsieme ridondante da tenere sincronizzato.

   SOLO node_type=2 (repeater): un path è composto esclusivamente da
   repeater, mai da nodi chat o room server — filtrare elimina ogni
   ambiguità nel caso i prefissi di una chat e di un repeater
   dovessero coincidere.
========================= */

app.get(
    "/api/meshnodes",
    (
        req,
        res
    ) => {

        try {

            if (
                !fs.existsSync(
                    CONTACTS_DB_FILE
                )
            ) {

                return res.json(
                    {}
                );
            }

            const db =
                new DatabaseSync(
                    CONTACTS_DB_FILE,
                    { readOnly: true }
                );

            const rows =
                db.prepare(
                    `SELECT public_key, adv_name
                     FROM nodes
                     WHERE node_type = 2
                       AND adv_name IS NOT NULL
                       AND adv_name != ''`
                ).all();

            db.close();

            const meshNodes = {};

            for (
                const row of rows
            ) {

                meshNodes[row.public_key] =
                    row.adv_name;
            }

            res.json(
                meshNodes
            );
        }

        catch (
            err
        ) {

            console.error(
                err
            );

            res
                .status(
                    500
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/* =========================
   ARCHIVE LIST API
========================= */

app.get(
    "/api/archive/list",
    (
        req,
        res
    ) => {

        try {

            const months = [
                "January",
                "February",
                "March",
                "April",
                "May",
                "June",
                "July",
                "August",
                "September",
                "October",
                "November",
                "December"
            ];

            const result = [];

            result.push({
                id:
                    "live",
                label:
                    "Live"
            });

            if (
                fs.existsSync(
                    BACKUP_DIR
                )
            ) {

                const files =
                    fs
                        .readdirSync(
                            BACKUP_DIR
                        )
                        .filter(
                            f =>
                                /^trace-\d{4}-\d{2}\.json\.gz$/.test(
                                    f
                                )
                        )
                        .sort();

                files.forEach(
                    file => {

                        const match =
                            file.match(
                                /^trace-(\d{4})-(\d{2})\.json\.gz$/
                            );

                        if (
                            match
                        ) {

                            const year =
                                match[1];

                            const month =
                                parseInt(
                                    match[2]
                                );

                            result.push({
                                id:
                                    file,

                                label:
                                    `${months[month - 1]} ${year}`
                            });
                        }
                    }
                );
            }

            res.json(
                result
            );
        }

        catch (
            err
        ) {

            console.error(
                err
            );

            res
                .status(
                    500
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/* =========================
   ARCHIVE LOAD API
========================= */

app.get(
    "/api/archive/load",
    (
        req,
        res
    ) => {

        try {

            const file =
                req.query.file;

            if (
                !file
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Missing file parameter"
                    });
            }

            const fullPath =
                path.join(
                    BACKUP_DIR,
                    file
                );

            if (
                !fs.existsSync(
                    fullPath
                )
            ) {

                return res
                    .status(404)
                    .json({
                        error:
                            "Archive not found"
                    });
            }

            const compressed =
                fs.readFileSync(
                    fullPath
                );

            const content =
                zlib
                    .gunzipSync(
                        compressed
                    )
                    .toString(
                        "utf8"
                    );

            const data =
                parseTraceContent(
                    content
                );

            res.json(
                data
            );
        }

        catch (
            err
        ) {

            console.error(
                err
            );

            res
                .status(
                    500
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/* =========================
   NODES API (contacts.db)
========================= */

app.get(
    "/api/nodes",
    (
        req,
        res
    ) => {

        try {

            if (
                !fs.existsSync(
                    CONTACTS_DB_FILE
                )
            ) {

                return res.json(
                    []
                );
            }

            const db =
                new DatabaseSync(
                    CONTACTS_DB_FILE,
                    { readOnly: true }
                );

            //
            // Path dell'ULTIMO advert osservato (da RX_LOG_DATA,
            // path_observations) — non out_path (quello è lo stato
            // di instradamento per rispondere, dato diverso, vedi
            // docs/CONTACT_MANAGEMENT.md §4/§15).
            //
            const rows =
                db.prepare(
                    `SELECT
                        n.public_key,
                        n.adv_name,
                        n.node_type,
                        n.adv_lat,
                        n.adv_lon,
                        n.last_advert,
                        n.last_seen,
                        po.hop_count,
                        po.path_hex
                    FROM nodes n
                    LEFT JOIN path_observations po
                        ON po.public_key = n.public_key
                        AND po.observed_at = (
                            SELECT MAX(observed_at)
                            FROM path_observations
                            WHERE public_key = n.public_key
                        )
                    ORDER BY n.last_seen DESC`
                ).all();

            db.close();

            res.json(
                rows
            );
        }

        catch (
            err
        ) {

            console.error(
                "API ERROR (/api/nodes):",
                err
            );

            res
                .status(
                    500
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/* =========================
   DEVICE STATUS API (contacts.db)

   Stato corrente del companion connesso a trace-mon stesso (non un
   repeater remoto interrogato via radio) — riga singola (id=1),
   scritta da ContactSyncModule ad ogni sync periodico interno (vedi
   contact_sync.py). Nessuna interrogazione live al device da qui:
   stesso pattern di lettura-da-SQLite già in uso per /api/nodes.
========================= */

app.get(
    "/api/device_status",
    (
        req,
        res
    ) => {

        try {

            if (
                !fs.existsSync(
                    CONTACTS_DB_FILE
                )
            ) {

                return res.json(
                    null
                );
            }

            const db =
                new DatabaseSync(
                    CONTACTS_DB_FILE,
                    { readOnly: true }
                );

            const row =
                db.prepare(
                    `SELECT * FROM device_status WHERE id = 1`
                ).get();

            db.close();

            res.json(
                row || null
            );
        }

        catch (
            err
        ) {

            console.error(
                "API ERROR (/api/device_status):",
                err
            );

            res
                .status(
                    500
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/* =========================
   NODE DETAIL API (contacts.db)
========================= */

app.get(
    "/api/nodes/:publicKey",
    (
        req,
        res
    ) => {

        try {

            if (
                !fs.existsSync(
                    CONTACTS_DB_FILE
                )
            ) {

                return res
                    .status(404)
                    .json({
                        error:
                            "Database non trovato"
                    });
            }

            const publicKey =
                req.params.publicKey;

            const db =
                new DatabaseSync(
                    CONTACTS_DB_FILE,
                    { readOnly: true }
                );

            const nodeRows =
                db.prepare(
                    `SELECT
                        public_key,
                        adv_name,
                        node_type,
                        adv_lat,
                        adv_lon,
                        last_advert,
                        last_seen
                    FROM nodes
                    WHERE public_key = ?`
                ).all(
                    publicKey
                );

            if (
                nodeRows.length === 0
            ) {

                db.close();

                return res
                    .status(404)
                    .json({
                        error:
                            "Nodo non trovato"
                    });
            }

            //
            // Ordine cronologico crescente: comodo sia per il
            // grafico (asse temporale) sia per costruire, lato
            // client, l'ordine inverso per la tabella.
            //
            const observations =
                db.prepare(
                    `SELECT
                        observed_at,
                        hop_count,
                        path_hex,
                        rssi,
                        snr,
                        route_type
                    FROM path_observations
                    WHERE public_key = ?
                    ORDER BY observed_at ASC`
                ).all(
                    publicKey
                );

            db.close();

            res.json(
                {
                    node: nodeRows[0],
                    observations: observations
                }
            );
        }

        catch (
            err
        ) {

            console.error(
                "API ERROR (/api/nodes/:publicKey):",
                err
            );

            res
                .status(
                    500
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/* =========================
   NODES ARCHIVE LIST API

   Elenco mesi disponibili per lo storico delle osservazioni — non
   dipende dal nodo scelto, i file path_observations-YYYY-MM.json.gz
   contengono le osservazioni di TUTTI i nodi per quel mese (prodotti
   da tools/rotate_path_observations.py sul Nodo).
========================= */

app.get(
    "/api/nodes/archive/list",
    (
        req,
        res
    ) => {

        try {

            const months = [
                "January",
                "February",
                "March",
                "April",
                "May",
                "June",
                "July",
                "August",
                "September",
                "October",
                "November",
                "December"
            ];

            const result = [];

            result.push({
                id:
                    "live",
                label:
                    "Live"
            });

            if (
                fs.existsSync(
                    BACKUP_DIR
                )
            ) {

                const files =
                    fs
                        .readdirSync(
                            BACKUP_DIR
                        )
                        .filter(
                            f =>
                                /^path_observations-\d{4}-\d{2}\.json\.gz$/.test(
                                    f
                                )
                        )
                        .sort();

                files.forEach(
                    file => {

                        const match =
                            file.match(
                                /^path_observations-(\d{4})-(\d{2})\.json\.gz$/
                            );

                        if (
                            match
                        ) {

                            const year =
                                match[1];

                            const month =
                                parseInt(
                                    match[2]
                                );

                            result.push({
                                id:
                                    file,

                                label:
                                    `${months[month - 1]} ${year}`
                            });
                        }
                    }
                );
            }

            res.json(
                result
            );
        }

        catch (
            err
        ) {

            console.error(
                err
            );

            res
                .status(
                    500
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/* =========================
   NODE DETAIL ARCHIVE LOAD API

   A differenza di /api/nodes/:publicKey (che legge contacts.db live),
   qui si legge un mese già archiviato e se ne filtrano solo le
   osservazioni del nodo richiesto — il file gz contiene tutti i
   nodi insieme, il filtro va fatto qui.
========================= */

app.get(
    "/api/nodes/:publicKey/archive/load",
    (
        req,
        res
    ) => {

        try {

            const file =
                req.query.file;

            if (
                !file
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Missing file parameter"
                    });
            }

            const fullPath =
                path.join(
                    BACKUP_DIR,
                    file
                );

            if (
                !fs.existsSync(
                    fullPath
                )
            ) {

                return res
                    .status(404)
                    .json({
                        error:
                            "Archive not found"
                    });
            }

            const compressed =
                fs.readFileSync(
                    fullPath
                );

            const content =
                zlib
                    .gunzipSync(
                        compressed
                    )
                    .toString(
                        "utf8"
                    );

            const allRows =
                JSON.parse(
                    content
                );

            const publicKey =
                req.params.publicKey;

            //
            // Stesso ordine cronologico crescente della query live
            // (vedi /api/nodes/:publicKey), stessa forma di riga —
            // il frontend riusa le stesse funzioni di rendering per
            // entrambe le sorgenti.
            //
            const observations =
                allRows
                    .filter(
                        r =>
                            r.public_key ===
                            publicKey
                    )
                    .sort(
                        (a, b) =>
                            a.observed_at -
                            b.observed_at
                    )
                    .map(
                        r => (
                            {
                                observed_at: r.observed_at,
                                hop_count: r.hop_count,
                                path_hex: r.path_hex,
                                rssi: r.rssi,
                                snr: r.snr,
                                route_type: r.route_type
                            }
                        )
                    );

            res.json(
                {
                    observations: observations
                }
            );
        }

        catch (
            err
        ) {

            console.error(
                "API ERROR (/api/nodes/:publicKey/archive/load):",
                err
            );

            res
                .status(
                    500
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/* =========================
   NEIGHBORS: REPEATER LIST API

   Elenco dei repeater di cui abbiamo almeno una query salvata —
   deliberatamente NON letto da config.yaml (il frontend Node.js non
   ha un parser YAML tra le dipendenze, ed è comunque più corretto
   mostrare solo repeater con dati reali disponibili piuttosto che
   l'intera lista configurata, che potrebbe includerne uno mai
   interrogato con successo).
========================= */

app.get(
    "/api/neighbors/repeaters",
    (
        req,
        res
    ) => {

        try {

            if (
                !fs.existsSync(
                    CONTACTS_DB_FILE
                )
            ) {

                return res.json(
                    []
                );
            }

            const db =
                new DatabaseSync(
                    CONTACTS_DB_FILE,
                    { readOnly: true }
                );

            const repeaters =
                db.prepare(
                    `SELECT DISTINCT
                        n.public_key,
                        n.adv_name
                    FROM repeater_status rs
                    JOIN nodes n ON n.public_key = rs.public_key
                    ORDER BY n.adv_name ASC`
                ).all();

            db.close();

            res.json(
                repeaters
            );
        }

        catch (
            err
        ) {

            console.error(
                "API ERROR (/api/neighbors/repeaters):",
                err
            );

            res
                .status(
                    500
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/* =========================
   NEIGHBORS: REPEATER DATA API

   Ultima query salvata per il repeater (status + neighbours) —
   status e neighbours condividono lo stesso queried_at, scritti
   nello stesso giro da NeighborMonitorWriter.write(). I neighbour
   sono risolti per PREFISSO contro nodes (non FK diretta, vedi
   docs/NEIGHBOR_MONITORING.md §5) — match_count permette al
   frontend di distinguere un nodo noto senza ambiguità (1) da un
   prefisso sconosciuto (0) o da una possibile collisione (>1).
========================= */

app.get(
    "/api/neighbors/:publicKey",
    (
        req,
        res
    ) => {

        try {

            if (
                !fs.existsSync(
                    CONTACTS_DB_FILE
                )
            ) {

                return res
                    .status(404)
                    .json({
                        error:
                            "Database non trovato"
                    });
            }

            const publicKey =
                req.params.publicKey;

            const db =
                new DatabaseSync(
                    CONTACTS_DB_FILE,
                    { readOnly: true }
                );

            const nodeRows =
                db.prepare(
                    `SELECT public_key, adv_name
                    FROM nodes
                    WHERE public_key = ?`
                ).all(
                    publicKey
                );

            if (
                nodeRows.length === 0
            ) {

                db.close();

                return res
                    .status(404)
                    .json({
                        error:
                            "Repeater non trovato"
                    });
            }

            const statusRows =
                db.prepare(
                    `SELECT *
                    FROM repeater_status
                    WHERE public_key = ?
                    ORDER BY queried_at DESC
                    LIMIT 1`
                ).all(
                    publicKey
                );

            const status =
                statusRows.length > 0
                    ? statusRows[0]
                    : null;

            let neighbours = [];
            let telemetry = [];

            if (
                status
            ) {

                neighbours =
                    db.prepare(
                        `SELECT
                            rn.neighbour_prefix,
                            rn.secs_ago,
                            rn.snr,
                            GROUP_CONCAT(n.adv_name) AS matched_names,
                            COUNT(n.public_key) AS match_count
                        FROM repeater_neighbours rn
                        LEFT JOIN nodes n
                            ON n.public_key LIKE rn.neighbour_prefix || '%'
                        WHERE rn.public_key = ? AND rn.queried_at = ?
                        GROUP BY rn.id
                        ORDER BY rn.secs_ago ASC`
                    ).all(
                        publicKey,
                        status.queried_at
                    );

                //
                // Stesso pattern di neighbours: correlata a
                // status.queried_at, non a un proprio MAX() —
                // coerente con la logica già in produzione, non
                // introduce un comportamento diverso in questo
                // aggiornamento. Limite noto: se status fallisse ma
                // telemetry riuscisse nello stesso giro, questa riga
                // non verrebbe trovata (caso raro, stesso gate ACL
                // condivide di norma lo stesso esito).
                //
                telemetry =
                    db.prepare(
                        `SELECT channel, type, value
                        FROM repeater_telemetry
                        WHERE public_key = ? AND queried_at = ?
                        ORDER BY channel ASC, type ASC`
                    ).all(
                        publicKey,
                        status.queried_at
                    );
            }

            //
            // A differenza di neighbours/telemetry, region non è
            // gated da ACL (AnonReqType) — può riuscire anche
            // quando status fallisce. Query indipendente, MAX()
            // proprio invece di riusare status.queried_at.
            //
            const regionRows =
                db.prepare(
                    `SELECT region_dump
                    FROM repeater_region
                    WHERE public_key = ?
                    ORDER BY queried_at DESC
                    LIMIT 1`
                ).all(
                    publicKey
                );

            const region =
                regionRows.length > 0
                    ? regionRows[0].region_dump
                    : null;

            //
            // Stesso principio di region: requisito di permesso
            // diverso (login+admin) — query indipendente, propria
            // MAX(queried_at).
            //
            const configRows =
                db.prepare(
                    `SELECT *
                    FROM repeater_config
                    WHERE public_key = ?
                    ORDER BY queried_at DESC
                    LIMIT 1`
                ).all(
                    publicKey
                );

            const config =
                configRows.length > 0
                    ? configRows[0]
                    : null;

            //
            // Stesso gate ACL di region (AnonReqType, nessun
            // permesso richiesto) — query indipendente, propria
            // MAX(queried_at).
            //
            const clockRows =
                db.prepare(
                    `SELECT remote_clock, skew_seconds, queried_at
                    FROM repeater_clock
                    WHERE public_key = ?
                    ORDER BY queried_at DESC
                    LIMIT 1`
                ).all(
                    publicKey
                );

            const clock =
                clockRows.length > 0
                    ? clockRows[0]
                    : null;

            db.close();

            res.json(
                {
                    public_key: nodeRows[0].public_key,
                    adv_name: nodeRows[0].adv_name,
                    status: status,
                    neighbours: neighbours,
                    telemetry: telemetry,
                    region: region,
                    clock: clock,
                    config: config
                }
            );
        }

        catch (
            err
        ) {

            console.error(
                "API ERROR (/api/neighbors/:publicKey):",
                err
            );

            res
                .status(
                    500
                )
                .json({
                    error:
                        err.message
                });
        }
    }
);

/* =========================
   NEIGHBOURS ARCHIVE LIST API

   Elenco mesi disponibili per lo storico dei neighbours — stesso
   pattern di /api/nodes/archive/list, file diversi
   (repeater_neighbours-YYYY-MM.json.gz, da
   tools/rotate_repeater_neighbours.py). Vedi
   docs/NEIGHBOR_MONITORING.md §13 sul perché solo questa tabella tra
   le cinque di neighbor_monitor ha uno storico.
========================= */

app.get(
    "/api/neighbors/archive/list",
    (
        req,
        res
    ) => {

        try {

            const months = [
                "January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"
            ];

            const result = [
                { id: "live", label: "Live" }
            ];

            if (
                fs.existsSync(
                    BACKUP_DIR
                )
            ) {

                const files =
                    fs
                        .readdirSync(
                            BACKUP_DIR
                        )
                        .filter(
                            f =>
                                /^repeater_neighbours-\d{4}-\d{2}\.json\.gz$/.test(
                                    f
                                )
                        )
                        .sort();

                files.forEach(
                    file => {

                        const match =
                            file.match(
                                /^repeater_neighbours-(\d{4})-(\d{2})\.json\.gz$/
                            );

                        if (
                            match
                        ) {

                            const year = match[1];
                            const month = parseInt(match[2]);

                            result.push({
                                id: file,
                                label: `${months[month - 1]} ${year}`
                            });
                        }
                    }
                );
            }

            res.json(
                result
            );
        }

        catch (
            err
        ) {

            console.error(
                "API ERROR (/api/neighbors/archive/list):",
                err
            );

            res
                .status(500)
                .json({ error: err.message });
        }
    }
);

/* =========================
   NEIGHBOURS ARCHIVE SNAPSHOTS API

   A differenza di path_observations (flusso continuo), un archivio
   mensile di repeater_neighbours contiene più "scatti" distinti (uno
   per ogni giro di cron) — questo endpoint elenca i queried_at
   disponibili per un repeater specifico in un dato file, così il
   frontend può farne scegliere uno preciso invece di mostrarli
   mescolati insieme.
========================= */

app.get(
    "/api/neighbors/:publicKey/archive/snapshots",
    (
        req,
        res
    ) => {

        try {

            const file = req.query.file;

            if (
                !file
            ) {

                return res
                    .status(400)
                    .json({ error: "Missing file parameter" });
            }

            const fullPath =
                path.join(
                    BACKUP_DIR,
                    file
                );

            if (
                !fs.existsSync(
                    fullPath
                )
            ) {

                return res
                    .status(404)
                    .json({ error: "Archive not found" });
            }

            const compressed = fs.readFileSync(fullPath);

            const content =
                zlib
                    .gunzipSync(compressed)
                    .toString("utf8");

            const allRows = JSON.parse(content);

            const publicKey = req.params.publicKey;

            //
            // Un Map preserva l'ordine di inserimento e ci risparmia
            // un secondo giro per contare le righe per queried_at.
            //
            const counts = new Map();

            allRows
                .filter(r => r.public_key === publicKey)
                .forEach(
                    r => {

                        counts.set(
                            r.queried_at,
                            (counts.get(r.queried_at) || 0) + 1
                        );
                    }
                );

            const snapshots =
                Array.from(counts.entries())
                    .map(
                        ([queried_at, count]) => (
                            {
                                queried_at: queried_at,
                                label: `${formatUnixTimeServer(queried_at)} (${count})`
                            }
                        )
                    )
                    .sort(
                        (a, b) => b.queried_at - a.queried_at
                    );

            res.json(
                snapshots
            );
        }

        catch (
            err
        ) {

            console.error(
                "API ERROR (/api/neighbors/:publicKey/archive/snapshots):",
                err
            );

            res
                .status(500)
                .json({ error: err.message });
        }
    }
);

/* =========================
   NEIGHBOURS ARCHIVE LOAD API

   Carica un singolo snapshot storico, risolvendo i nomi per
   prefisso contro la tabella nodes LIVE (i nomi noti oggi, non
   quelli disponibili al momento dell'archiviazione — coerente con
   la stessa scelta implicita già fatta per path_observations, che
   non congela alcuna risoluzione al momento dell'archiviazione).
========================= */

app.get(
    "/api/neighbors/:publicKey/archive/load",
    (
        req,
        res
    ) => {

        try {

            const file = req.query.file;
            const queriedAt = parseInt(req.query.queried_at);

            if (
                !file || !queriedAt
            ) {

                return res
                    .status(400)
                    .json({ error: "Missing file or queried_at parameter" });
            }

            const fullPath =
                path.join(
                    BACKUP_DIR,
                    file
                );

            if (
                !fs.existsSync(
                    fullPath
                )
            ) {

                return res
                    .status(404)
                    .json({ error: "Archive not found" });
            }

            const compressed = fs.readFileSync(fullPath);

            const content =
                zlib
                    .gunzipSync(compressed)
                    .toString("utf8");

            const allRows = JSON.parse(content);

            const publicKey = req.params.publicKey;

            const snapshotRows =
                allRows.filter(
                    r =>
                        r.public_key === publicKey &&
                        r.queried_at === queriedAt
                );

            if (
                !fs.existsSync(
                    CONTACTS_DB_FILE
                )
            ) {

                return res.json(
                    snapshotRows.map(
                        r => (
                            {
                                neighbour_prefix: r.neighbour_prefix,
                                secs_ago: r.secs_ago,
                                snr: r.snr,
                                matched_names: null,
                                match_count: 0
                            }
                        )
                    )
                );
            }

            const db =
                new DatabaseSync(
                    CONTACTS_DB_FILE,
                    { readOnly: true }
                );

            const nodeRows =
                db.prepare(
                    "SELECT public_key, adv_name FROM nodes"
                ).all();

            db.close();

            const neighbours =
                snapshotRows.map(
                    r => {

                        const matches =
                            nodeRows.filter(
                                n =>
                                    n.public_key.startsWith(
                                        r.neighbour_prefix
                                    )
                            );

                        return {
                            neighbour_prefix: r.neighbour_prefix,
                            secs_ago: r.secs_ago,
                            snr: r.snr,
                            matched_names:
                                matches.length > 0
                                    ? matches.map(m => m.adv_name).join(",")
                                    : null,
                            match_count: matches.length
                        };
                    }
                );

            res.json(
                neighbours
            );
        }

        catch (
            err
        ) {

            console.error(
                "API ERROR (/api/neighbors/:publicKey/archive/load):",
                err
            );

            res
                .status(500)
                .json({ error: err.message });
        }
    }
);

/* =========================
   STATIC FRONTEND
========================= */

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);

/* =========================
   ROOT
========================= */

app.get(
    "/",
    (
        req,
        res
    ) => {

        res.sendFile(
            path.join(
                __dirname,
                "public",
                "index.html"
            )
        );
    }
);

/* =========================
   START
========================= */

app.listen(
    3000,
    () => {

        console.log(
            "Server running on http://localhost:3000"
        );

        console.log(
            "Using file:",
            FILE
        );
    }
);
