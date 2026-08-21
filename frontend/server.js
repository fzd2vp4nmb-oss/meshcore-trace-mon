const express = require("express");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
//
// node:sqlite (code review 2026-08-20, §4) — API sperimentale del
// runtime Node.js nativo (stabile solo da una versione recente di
// Node 22+, comportamento/firma non garantiti tra minor version
// finché resta "Experimental" nella documentazione ufficiale). Va
// verificata contro le release notes di Node prima di ogni upgrade
// della versione di Node in produzione — un cambiamento qui non
// sarebbe segnalato da un semver minor/patch come per una dipendenza
// da npm ordinaria.
//
const { DatabaseSync } = require("node:sqlite");

const {
    parseTraceFile,
    parseTraceContent
} = require("./parser");

const app = express();

//
// Messaggio generico per ogni risposta 500 (code review 2026-08-20,
// §3.5) — prima err.message veniva restituito direttamente al
// client su tutti gli endpoint: rivelava path assoluti interni del
// server (es. errori ENOENT/EACCES con il path completo) e,
// combinato con §1.2 (path traversal, già corretto), diventava un
// piccolo oracolo per la presenza di file arbitrari sul filesystem
// (messaggi diversi per "file assente" vs "file presente ma non
// gzip"). Il dettaglio completo dell'errore resta comunque nei log
// server-side (console.error, invariato) per la diagnosi.
//
const GENERIC_ERROR_MESSAGE = "Errore interno del server";

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

//
// Validazione allowlist per il parametro `file` di ogni endpoint
// "archive load"/"archive snapshots": prima di questo fix, `file`
// veniva passato a path.join(BACKUP_DIR, file) senza alcun controllo
// — path.join normalizza "..", quindi un valore come
// "../../../../etc/passwd" usciva da BACKUP_DIR senza impedimenti
// (path traversal, v. code review 2026-08-20, §1.2). Gli endpoint
// "list" già filtravano i nomi con la stessa regex qui sotto passata
// come `pattern`, ma quella validazione non era mai stata riusata
// dagli endpoint "load" corrispondenti — la si applica ora ad
// entrambi, allowlist (solo nomi che rispettano esattamente il
// formato atteso), non blacklist.
//
// Ritorna il path assoluto risolto se `filename` è valido e resta
// dentro BACKUP_DIR, altrimenti null.
//
function safeArchivePath(
    filename,
    pattern
) {

    if (
        !filename ||
        typeof filename !== "string" ||
        !pattern.test(filename)
    ) {

        return null;
    }

    const resolvedBase =
        path.resolve(BACKUP_DIR) + path.sep;

    const resolvedPath =
        path.resolve(
            BACKUP_DIR,
            filename
        );

    if (
        !resolvedPath.startsWith(resolvedBase)
    ) {

        return null;
    }

    return resolvedPath;
}

//
// Estratto da /api/archive/list, /api/nodes/archive/list e
// /api/neighbors/archive/list (code review 2026-08-20, §4) — le tre
// route avevano la stessa logica duplicata tre volte (elenco mesi,
// entry "live", scan di BACKUP_DIR con lo stesso filtro/parse
// cambiando solo il prefisso del nome file): unica implementazione,
// il prefisso resta l'unico parametro che le distingue davvero.
//
const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
];

function listArchiveMonths(
    filePrefix
) {

    const result = [
        { id: "live", label: "Live" }
    ];

    if (
        !fs.existsSync(
            BACKUP_DIR
        )
    ) {

        return result;
    }

    const pattern =
        new RegExp(
            `^${filePrefix}-(\\d{4})-(\\d{2})\\.json\\.gz$`
        );

    const files =
        fs
            .readdirSync(
                BACKUP_DIR
            )
            .filter(
                f => pattern.test(f)
            )
            .sort();

    files.forEach(
        file => {

            const match = file.match(pattern);

            if (
                match
            ) {

                const year = match[1];
                const month = parseInt(match[2], 10);

                result.push({
                    id: file,
                    label: `${MONTH_NAMES[month - 1]} ${year}`
                });
            }
        }
    );

    return result;
}

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
                        GENERIC_ERROR_MESSAGE
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

            //
            // try/finally invece del solo db.close() sul percorso di
            // successo: prima di questo fix, un'eccezione sollevata
            // da db.prepare()/all() (es. tabella mancante dopo una
            // migrazione parziale, file corrotto) saltava db.close()
            // e la connessione restava aperta, abbandonata al
            // garbage collector — ripetuto nel tempo su un processo
            // Node long-running può accumulare file descriptor fino
            // a EMFILE (v. code review 2026-08-20, §2.3). finally
            // garantisce la chiusura su ogni percorso di uscita,
            // incluso un return anticipato.
            //
            try {

                const rows =
                    db.prepare(
                        `SELECT public_key, adv_name
                         FROM nodes
                         WHERE node_type = 2
                           AND adv_name IS NOT NULL
                           AND adv_name != ''`
                    ).all();

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

            } finally {

                db.close();
            }
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
                        GENERIC_ERROR_MESSAGE
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

            res.json(
                listArchiveMonths("trace")
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
                        GENERIC_ERROR_MESSAGE
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

            const fullPath =
                safeArchivePath(
                    file,
                    /^trace-\d{4}-\d{2}\.json\.gz$/
                );

            if (
                !fullPath
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Missing or invalid file parameter"
                    });
            }

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
                        GENERIC_ERROR_MESSAGE
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
            // try/finally: v. commento analogo in /api/meshnodes
            // (fix leak connessione SQLite, code review 2026-08-20,
            // §2.3).
            //
            try {

                //
                // Path dell'ULTIMO advert osservato (da RX_LOG_DATA,
                // path_observations) — non out_path (quello è lo
                // stato di instradamento per rispondere, dato
                // diverso, vedi docs/CONTACT_MANAGEMENT.md §4/§15).
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

                res.json(
                    rows
                );

            } finally {

                db.close();
            }
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
                        GENERIC_ERROR_MESSAGE
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

            //
            // try/finally: fix leak connessione SQLite, v.
            // /api/meshnodes (code review 2026-08-20, §2.3).
            //
            try {

                const row =
                    db.prepare(
                        `SELECT * FROM device_status WHERE id = 1`
                    ).get();

                res.json(
                    row || null
                );

            } finally {

                db.close();
            }
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
                        GENERIC_ERROR_MESSAGE
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

            //
            // try/finally: fix leak connessione SQLite, v.
            // /api/meshnodes (code review 2026-08-20, §2.3) — copre
            // anche il return anticipato "Nodo non trovato" qui
            // sotto, che prima chiudeva la connessione manualmente
            // solo su quel percorso specifico.
            //
            try {

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

                res.json(
                    {
                        node: nodeRows[0],
                        observations: observations
                    }
                );

            } finally {

                db.close();
            }
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
                        GENERIC_ERROR_MESSAGE
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

            res.json(
                listArchiveMonths("path_observations")
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
                        GENERIC_ERROR_MESSAGE
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

            const fullPath =
                safeArchivePath(
                    file,
                    /^path_observations-\d{4}-\d{2}\.json\.gz$/
                );

            if (
                !fullPath
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Missing or invalid file parameter"
                    });
            }

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
                        GENERIC_ERROR_MESSAGE
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

//
// Ordine delle route rilevante (code review 2026-08-20, §4): questa
// route letterale DEVE restare definita PRIMA di
// "/api/neighbors/:publicKey" qui sotto — Express prova le route
// nell'ordine di registrazione, e un singolo segmento letterale come
// "repeaters" farebbe altrimenti match anche con ":publicKey" se
// quest'ultima fosse registrata per prima, intercettando la
// richiesta prima che arrivi qui. Stesso principio per
// "/api/nodes/archive/list" vs "/api/nodes/:publicKey" più sotto
// (lì non collidono per numero di segmenti, ma vale comunque la
// buona norma di non affidarsi a quello in caso di refactor futuri).
//
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

            //
            // try/finally: fix leak connessione SQLite, v.
            // /api/meshnodes (code review 2026-08-20, §2.3).
            //
            try {

                const repeaters =
                    db.prepare(
                        `SELECT DISTINCT
                            n.public_key,
                            n.adv_name
                        FROM repeater_status rs
                        JOIN nodes n ON n.public_key = rs.public_key
                        ORDER BY n.adv_name ASC`
                    ).all();

                res.json(
                    repeaters
                );

            } finally {

                db.close();
            }
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
                        GENERIC_ERROR_MESSAGE
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

            //
            // try/finally: fix leak connessione SQLite, v.
            // /api/meshnodes (code review 2026-08-20, §2.3) — copre
            // anche il return anticipato "Repeater non trovato" qui
            // sotto, che prima chiudeva la connessione manualmente
            // solo su quel percorso specifico.
            //
            try {

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
                    // aggiornamento. Limite noto: se status fallisse
                    // ma telemetry riuscisse nello stesso giro,
                    // questa riga non verrebbe trovata (caso raro,
                    // stesso gate ACL condivide di norma lo stesso
                    // esito).
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

            } finally {

                db.close();
            }
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
                        GENERIC_ERROR_MESSAGE
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

            res.json(
                listArchiveMonths("repeater_neighbours")
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
                .json({ error: GENERIC_ERROR_MESSAGE });
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

            const fullPath =
                safeArchivePath(
                    file,
                    /^repeater_neighbours-\d{4}-\d{2}\.json\.gz$/
                );

            if (
                !fullPath
            ) {

                return res
                    .status(400)
                    .json({ error: "Missing or invalid file parameter" });
            }

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
                .json({ error: GENERIC_ERROR_MESSAGE });
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
            const queriedAt = parseInt(req.query.queried_at, 10);

            const fullPath =
                safeArchivePath(
                    file,
                    /^repeater_neighbours-\d{4}-\d{2}\.json\.gz$/
                );

            //
            // Number.isNaN() invece di "!queriedAt" (code review
            // 2026-08-20, §4) — un queried_at legittimo pari a 0
            // (timestamp Unix epoch, valore limite ma tecnicamente
            // valido) è falsy in JS: il controllo precedente lo
            // avrebbe respinto come "mancante", indistinguibile da
            // un parametro davvero assente o da un NaN (query.
            // queried_at non numerico). Number.isNaN() reagisce solo
            // al caso realmente invalido.
            //
            if (
                !fullPath || Number.isNaN(queriedAt)
            ) {

                return res
                    .status(400)
                    .json({ error: "Missing or invalid file or queried_at parameter" });
            }

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

            //
            // try/finally: fix leak connessione SQLite, v.
            // /api/meshnodes (code review 2026-08-20, §2.3).
            //
            let nodeRows;

            try {

                nodeRows =
                    db.prepare(
                        "SELECT public_key, adv_name FROM nodes"
                    ).all();

            } finally {

                db.close();
            }

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
                .json({ error: GENERIC_ERROR_MESSAGE });
        }
    }
);

/* =========================
   STATIC FRONTEND

   express.static serve già index.html di default per GET / (e per
   qualunque altra directory richiesta che lo contenga) — un handler
   dedicato "app.get('/', ...)" più sotto era quindi codice morto,
   mai raggiunto perché questo middleware intercetta la richiesta
   per primo; rimosso (code review 2026-08-20, §4).
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
