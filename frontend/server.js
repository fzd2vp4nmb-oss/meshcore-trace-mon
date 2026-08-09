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

const MESH_NODES_FILE =
    path.join(
        __dirname,
        "mesh-nodes.json"
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
   MESHNODES API
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
                    MESH_NODES_FILE
                )
            ) {

                return res.json(
                    {}
                );
            }

            const data =
                JSON.parse(
                    fs.readFileSync(
                        MESH_NODES_FILE,
                        "utf8"
                    )
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

            db.close();

            res.json(
                {
                    public_key: nodeRows[0].public_key,
                    adv_name: nodeRows[0].adv_name,
                    status: status,
                    neighbours: neighbours,
                    telemetry: telemetry,
                    region: region,
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
