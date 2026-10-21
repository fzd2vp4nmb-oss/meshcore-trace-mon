#!/usr/bin/env node
"use strict";

/* ==========================================
   analysis_job.js

   Calcolo periodico della scheda «Analysis» (docs/ARCHITECTURE.md §88):
   legge i database e gli archivi mensili, chiama analysis_engine.js e
   scrive i JSON che gli endpoint /api/analysis/* di server.js servono in
   sola lettura. Processo di cron, mai un timer dentro server.js e mai un
   calcolo per richiesta (§41, §61: il Collettore è esposto e serve tutti
   i nodi) — stesso schema di telegram_notify.js (§56).

   Uso: `node analysis_job.js`, lanciato da cron. Nessun argomento.
   Riga di crontab suggerita in docs/ARCHITECTURE.md §88 (ogni due ore).

   Cosa fa, nell'ordine:
     1. determina gli osservatori (Nodo: un contacts.db; Collettore: uno
        per nodo di config/nodes.json) — l'UNICA parte diversa tra i due
        repository, delimitata sotto da DIFFERENZA STRUTTURALE;
     2. legge, per ogni osservatore, nodes, device_status e le quattro
        tabelle di propagazione (path_observations, sonar_rx, sonar_tx,
        advert_tx) dal database e da tutti gli archivi
        backup/<tabella>-AAAA-MM.json.gz, più repeater_config (tetti flood
        dei repeater gestiti, §89: solo database, nessun archivio); una
        tabella o un archivio assente non è un errore (nodo non
        aggiornato: «nessun dato»);
     3. unisce database e archivi senza doppioni (mergeRows) e le righe di
        repeater_config con la STORIA dei tetti conservata da questo stesso
        job (caps_history.json, §90 D62: purge_removed_repeaters.py toglie
        dal database la storia dei repeater tolti dalla configurazione);
     4. produce un JSON per finestra (all, live, un mese per archivio) e
        index.json (elenco finestre + esito di questo giro).

   Scrittura: SOLO nella directory dell'analisi (Nodo data/analysis/,
   Collettore state/analysis/ — data/ del Collettore può essere un link in
   sola lettura, §56.9). File scritti in modo atomico (.tmp + rename);
   index.json per ultimo, così il server non vede mai un elenco che
   rimanda a file mancanti. L'unico file di STATO è caps_history.json
   (storia dei tetti flood, §90): se manca o è illeggibile si riparte dal
   database (un file illeggibile è messo da parte, mai cancellato). I database si aprono SOLO in lettura. Nessun
   nuovo file di log (nessuna modifica a logrotate.conf): l'esito
   dell'ultimo giro sta in index.json (job.ok, job.error) e nel codice di
   uscita; la scheda avverte se i dati sono vecchi.

   Un giro che fallisce NON cancella i dati buoni dell'ultimo giro
   riuscito: ne marca solo l'esito (job.ok=false) in index.json.
   Due giri sovrapposti non si calpestano (lock con controllo del pid).
========================================== */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { DatabaseSync } = require("node:sqlite");

const engine = require("./analysis_engine");

const ANALYSIS_ID = "propagation";

// ==== DIFFERENZA STRUTTURALE Nodo/Collettore: INIZIO ====
// Tutto il resto del file è identico nei due repository (verificato dal
// test sandbox_tests/test_analysis_job_2026_10_21.js).

const MODE = "node";

// "none": il Nodo non conosce gli altri nodi del progetto, non filtra le
// sorgenti Sonar (D39). Collettore: "derive".
const PARTICIPANTS = "none";

function defaultRoot() {

    // frontend/analysis_job.js -> radice del repository
    return path.resolve(__dirname, "..");
}

function outBase(root) {

    return path.join(root, "data", "analysis");
}

function discoverObservers(root) {

    return {
        observers: [
            {
                id: "local",
                label: null,
                dbFile: path.join(root, "data", "contacts.db"),
                backupDir: path.join(root, "backup")
            }
        ],
        warnings: []
    };
}

// ==== DIFFERENZA STRUTTURALE Nodo/Collettore: FINE ====

const LOCK_MAX_AGE_SECS = 30 * 60;

// Colonne lette per tabella. Si usa l'intersezione con quelle presenti
// (PRAGMA table_info): un database di una versione precedente senza una
// colonna non fa fallire il giro, la colonna manca e basta.
const TABLES = {
    path_observations: {
        columns: ["public_key", "observed_at", "adv_timestamp", "pkt_hash", "path_hex", "hop_count", "route_type"],
        archivePrefix: "path_observations"
    },
    sonar_rx: {
        columns: ["id", "observed_at", "src_prefix", "seq", "scope_tag", "pkt_hash", "route_type", "path_hex", "hop_count", "hash_size", "is_local"],
        archivePrefix: "sonar_rx"
    },
    sonar_tx: {
        columns: ["seq", "created_at", "src_prefix", "status", "scope_tag"],
        archivePrefix: "sonar_tx"
    },
    advert_tx: {
        columns: ["id", "created_at", "src_prefix", "kind", "status"],
        archivePrefix: "advert_tx"
    }
};

const NODE_COLUMNS = ["public_key", "adv_name", "node_type", "adv_lat", "adv_lon", "first_seen", "last_seen", "lastmod"];

// repeater_config (§89, D54): storico dei tre tetti flood dei repeater gestiti.
// Non ha archivi (non viene mai ruotata: solo purge_removed_repeaters.py ne
// toglie le righe dei repeater rimossi), quindi si legge solo dal database e
// non passa da mergeRows. Tabella assente = null = «nessun dato».
const CAP_COLUMNS = ["public_key", "queried_at", "flood_max", "flood_max_unscoped", "flood_max_advert"];

// Storia dei tetti (§90, D62): file di stato accanto ai JSON della scheda.
// { schema, updated_at, observers: { <id osservatore>: { <chiave>: [[t, max, unscoped, advert], ...] } } }
// Righe ordinate per istante, senza doppioni, solo in aggiunta: il database
// vince a parità di (chiave, istante). Non è mai servito dall'API (che
// conosce solo le finestre dell'indice).
const CAPS_HISTORY_FILE = "caps_history.json";
const CAPS_HISTORY_SCHEMA = 1;

function tableColumns(db, table) {

    return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
}

function pickColumns(wanted, present) {

    return wanted.filter(c => present.includes(c));
}

function readDbTable(db, table, wanted) {

    const present = tableColumns(db, table);

    if (present.length === 0) {
        return null;                         // tabella assente
    }

    const cols = pickColumns(wanted, present);

    if (cols.length === 0) {
        return [];
    }

    const rows = db.prepare(`SELECT ${cols.join(", ")} FROM ${table}`).all();

    return rows.map(r => Object.assign({}, r));
}

function projectRow(row, wanted) {

    const out = {};

    for (const c of wanted) {
        if (Object.prototype.hasOwnProperty.call(row, c)) {
            out[c] = row[c];
        }
    }

    return out;
}

function listArchives(backupDir, prefix) {

    if (!fs.existsSync(backupDir)) {
        return [];
    }

    const re = new RegExp(`^${prefix}-(\\d{4}-\\d{2})\\.json\\.gz$`);

    return fs.readdirSync(backupDir)
        .map(f => ({ file: f, m: re.exec(f) }))
        .filter(x => x.m)
        .map(x => ({ path: path.join(backupDir, x.file), month: x.m[1], name: x.file }))
        .sort((a, b) => (a.month < b.month ? -1 : 1));
}

function readArchive(file, wanted) {

    const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));

    if (!Array.isArray(data)) {
        throw new Error("l'archivio non è una lista");
    }

    return data
        .filter(r => r && typeof r === "object")
        .map(r => projectRow(r, wanted));
}

function readObserver(spec, warnings) {

    const result = {
        id: spec.id,
        label: spec.label,
        lat: null,
        lon: null,
        error: null,
        rows: {},
        nodes: []
    };

    const dbRows = {};
    let nodes = [];
    let caps = null;

    if (!fs.existsSync(spec.dbFile)) {

        result.error = "contacts.db non trovato";

    } else {

        let db = null;

        try {

            db = new DatabaseSync(spec.dbFile, { readOnly: true });

            for (const [table, def] of Object.entries(TABLES)) {
                dbRows[table] = readDbTable(db, table, def.columns);
            }

            nodes = readDbTable(db, "nodes", NODE_COLUMNS) || [];

            caps = readDbTable(db, "repeater_config", CAP_COLUMNS);

            // device_status è a riga singola (CHECK id = 1) e, nei database
            // più vecchi, può mancare o non avere ancora adv_lat/adv_lon/
            // device_name: stessa tolleranza delle altre tabelle (nessun
            // errore, semplicemente niente etichetta né posizione).
            const ds = (readDbTable(db, "device_status", ["id", "adv_lat", "adv_lon", "device_name"]) || [])[0];

            if (ds) {
                result.lat = Number.isFinite(ds.adv_lat) ? ds.adv_lat : null;
                result.lon = Number.isFinite(ds.adv_lon) ? ds.adv_lon : null;

                if (!result.label && typeof ds.device_name === "string" && ds.device_name) {
                    result.label = ds.device_name;
                }
            }

        } catch (err) {

            result.error = `lettura di contacts.db fallita: ${err.message}`;

        } finally {

            if (db) {
                try { db.close(); } catch (e) { /* già chiuso */ }
            }
        }
    }

    result.nodes = nodes;
    result.rows.repeater_config = caps;

    for (const [table, def] of Object.entries(TABLES)) {

        const archives = [];

        for (const a of listArchives(spec.backupDir, def.archivePrefix)) {

            try {

                archives.push({ month: a.month, rows: readArchive(a.path, def.columns) });

            } catch (err) {

                warnings.push(`${spec.id}: archivio ${a.name} non leggibile (${err.message})`);
            }
        }

        const merged = engine.mergeRows(table, dbRows[table] === undefined ? null : dbRows[table], archives);

        result.rows[table] = merged.present ? merged.rows : null;
    }

    return result;
}

/* =========================
   STORIA DEI TETTI (§90, D62)
========================= */

const KEY_RE = /^[0-9a-f]{64}$/;

// cella della storia: numero finito, null (nessuna risposta del repeater) o
// "x" (valore non valido: non è un numero finito); così il modello dei tetti
// conta le stesse cose letto dal database o dalla storia
function capCell(v) {

    if (v === null || v === undefined) {
        return null;
    }

    return typeof v === "number" && Number.isFinite(v) ? v : "x";
}

// legge caps_history.json; file assente = storia vuota; file illeggibile o di
// uno schema sconosciuto = messo da parte (mai cancellato) e storia vuota
function loadCapsHistory(outDir, nowSecs, warnings) {

    const file = path.join(outDir, CAPS_HISTORY_FILE);
    const empty = { observers: {} };

    if (!fs.existsSync(file)) {
        return empty;
    }

    let parsed = null;

    try {

        parsed = JSON.parse(fs.readFileSync(file, "utf8"));

        if (!parsed || typeof parsed !== "object" || parsed.schema !== CAPS_HISTORY_SCHEMA ||
            !parsed.observers || typeof parsed.observers !== "object" || Array.isArray(parsed.observers)) {
            throw new Error("formato non riconosciuto");
        }

    } catch (err) {

        const aside = path.join(outDir, `caps_history.corrupt-${nowSecs}.json`);

        try {
            fs.renameSync(file, aside);
            warnings.push(`${CAPS_HISTORY_FILE} non leggibile (${err.message}): messo da parte come ${path.basename(aside)}, la storia riparte dal database`);
        } catch (e) {
            warnings.push(`${CAPS_HISTORY_FILE} non leggibile (${err.message}) e non spostabile (${e.message}): la storia non viene aggiornata in questo giro`);
        }

        return empty;
    }

    const observers = {};

    for (const [id, byKey] of Object.entries(parsed.observers)) {

        if (!byKey || typeof byKey !== "object" || Array.isArray(byKey)) {
            continue;
        }

        const clean = {};

        for (const [key, rows] of Object.entries(byKey)) {

            if (!KEY_RE.test(key) || !Array.isArray(rows)) {
                continue;
            }

            const good = rows.filter(r => Array.isArray(r) && r.length === 4 && Number.isFinite(r[0]))
                .map(r => [r[0], capCell(r[1]), capCell(r[2]), capCell(r[3])]);

            if (good.length > 0) {
                clean[key] = good;
            }
        }

        observers[id] = clean;
    }

    return { observers: observers };
}

// righe della storia di un osservatore nel formato di repeater_config
function capsHistoryRows(history, id) {

    const out = [];
    const byKey = Object.prototype.hasOwnProperty.call(history.observers, id) ? history.observers[id] : null;

    if (!byKey) {
        return out;
    }

    for (const [key, rows] of Object.entries(byKey)) {
        for (const r of rows) {
            out.push({ public_key: key, queried_at: r[0], flood_max: r[1], flood_max_unscoped: r[2], flood_max_advert: r[3] });
        }
    }

    return out;
}

// righe unite (ordinate per istante) -> { chiave: [[t, max, unscoped, advert], ...] }, chiavi in ordine
function groupCapsRows(rows) {

    const tmp = new Map();

    for (const r of rows) {

        if (!tmp.has(r.public_key)) {
            tmp.set(r.public_key, []);
        }

        tmp.get(r.public_key).push([r.queried_at, capCell(r.flood_max), capCell(r.flood_max_unscoped), capCell(r.flood_max_advert)]);
    }

    const out = {};

    for (const key of Array.from(tmp.keys()).sort()) {
        out[key] = tmp.get(key);
    }

    return out;
}

//
// Riunisce, per ogni osservatore, le righe di repeater_config del database
// con la storia. Cambia observers[i].rows.repeater_config e ritorna la
// storia aggiornata (gli osservatori che non sono più nell'elenco restano
// com'erano) più due contatori: righe totali e righe che il database non ha
// più (tolte da purge_removed_repeaters.py: esistono solo nella storia).
// Vale anche per un osservatore con database illeggibile: i tetti di un
// repeater che gestisce servono ai pacchetti visti dagli altri nodi.
//
function applyCapsHistory(observers, history) {

    const merged = [];

    for (const o of observers) {

        const dbRows = o.rows.repeater_config;
        const m = engine.mergeCaps(Array.isArray(dbRows) ? dbRows : null, capsHistoryRows(history, o.id));
        const dbKeys = new Set();

        if (Array.isArray(dbRows)) {
            for (const r of dbRows) {
                dbKeys.add(`${String(r.public_key).toLowerCase()}|${r.queried_at}`);
            }
        }

        merged.push({
            o: o,
            result: m,
            keptOnly: m.rows.filter(r => !dbKeys.has(`${r.public_key}|${r.queried_at}`)).length
        });
    }

    const next = { observers: Object.assign({}, history.observers) };
    let rows = 0;
    let keptOnly = 0;

    for (const x of merged) {

        x.o.rows.repeater_config = x.result.present ? x.result.rows : null;

        if (!x.result.present) {
            continue;
        }

        rows += x.result.rows.length;
        keptOnly += x.keptOnly;

        if (x.result.rows.length > 0 || Object.prototype.hasOwnProperty.call(history.observers, x.o.id)) {
            next.observers[x.o.id] = groupCapsRows(x.result.rows);
        }
    }

    return { history: next, rows: rows, keptOnly: keptOnly };
}

// scrive la storia solo se è cambiata (il file cresce solo con letture nuove)
function saveCapsHistory(outDir, before, after, nowSecs) {

    if (JSON.stringify(before.observers) === JSON.stringify(after.observers)) {
        return false;
    }

    writeJsonAtomic(path.join(outDir, CAPS_HISTORY_FILE), {
        schema: CAPS_HISTORY_SCHEMA,
        updated_at: nowSecs,
        observers: after.observers
    });

    return true;
}

/* =========================
   LOCK
========================= */

function pidAlive(pid) {

    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === "EPERM";
    }
}

function acquireLock(lockFile, nowSecs) {

    for (let attempt = 0; attempt < 2; attempt++) {

        try {

            const fd = fs.openSync(lockFile, "wx");

            fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: nowSecs }));
            fs.closeSync(fd);

            return true;

        } catch (err) {

            if (err.code !== "EEXIST") {
                throw err;
            }

            let info = null;

            try {
                info = JSON.parse(fs.readFileSync(lockFile, "utf8"));
            } catch (e) {
                info = null;
            }

            const fresh = info && Number.isFinite(info.at) && nowSecs - info.at < LOCK_MAX_AGE_SECS;

            if (fresh && pidAlive(info.pid)) {
                return false;
            }

            // lock abbandonato (processo morto o troppo vecchio): si riprende
            try { fs.unlinkSync(lockFile); } catch (e) { /* già tolto */ }
        }
    }

    return false;
}

function releaseLock(lockFile) {

    try { fs.unlinkSync(lockFile); } catch (e) { /* già tolto */ }
}

/* =========================
   SCRITTURA
========================= */

function writeJsonAtomic(file, value) {

    const tmp = `${file}.${process.pid}.tmp`;

    try {

        fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
        fs.renameSync(tmp, file);

    } catch (err) {

        try { fs.unlinkSync(tmp); } catch (e) { /* mai creato */ }
        throw err;
    }
}

const WINDOW_FILE_RE = /^(all|live|\d{4}-\d{2})\.json$/;

function markFailure(outDir, message, nowSecs) {

    const indexFile = path.join(outDir, "index.json");
    let index = null;

    try {
        index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    } catch (e) {
        index = null;
    }

    if (!index || typeof index !== "object") {

        index = {
            schema: engine.SCHEMA_VERSION,
            analysis: ANALYSIS_ID,
            mode: MODE,
            generated_at: null,
            windows: [],
            default: "all",
            job: {}
        };
    }

    index.job = Object.assign({}, index.job, { ok: false, error: message, failed_at: nowSecs });

    writeJsonAtomic(indexFile, index);
}

/* =========================
   GIRO COMPLETO
========================= */

// options: { root, now } (per i test); ritorna un riassunto, lancia in caso di errore
function run(options) {

    const opts = options || {};
    const root = opts.root || defaultRoot();
    const now = Number.isFinite(opts.now) ? opts.now : Math.floor(Date.now() / 1000);
    const started = Date.now();
    const base = outBase(root);
    const outDir = path.join(base, ANALYSIS_ID);

    fs.mkdirSync(outDir, { recursive: true });

    const lockFile = path.join(base, `.lock-${ANALYSIS_ID}`);

    if (!acquireLock(lockFile, now)) {
        return { ok: true, skipped: true, reason: "già in esecuzione", outDir: outDir };
    }

    try {

        const found = discoverObservers(root);
        const warnings = found.warnings.slice();

        if (found.observers.length === 0) {
            throw new Error("nessun osservatore configurato");
        }

        const observers = found.observers.map(spec => readObserver(spec, warnings));

        if (observers.every(o => o.error)) {
            throw new Error(`nessun database leggibile: ${observers.map(o => `${o.id}: ${o.error}`).join("; ")}`);
        }

        observers.forEach(o => {
            if (o.error) {
                warnings.push(`${o.id}: ${o.error}`);
            }
        });

        // storia dei tetti (§90): mai un motivo per fallire il giro; se qualcosa
        // va storto restano i tetti del solo database, con un avviso
        let capsInfo = { rows: 0, kept_only: 0 };

        try {

            const before = loadCapsHistory(outDir, now, warnings);
            const applied = applyCapsHistory(observers, before);

            capsInfo = { rows: applied.rows, kept_only: applied.keptOnly };

            saveCapsHistory(outDir, before, applied.history, now);

        } catch (err) {

            warnings.push(`storia dei tetti (${CAPS_HISTORY_FILE}) non aggiornata: ${err.message}`);
        }

        const ctx = engine.createContext({ now: now, participants: PARTICIPANTS, observers: observers });
        const windows = engine.listWindows(ctx);
        const index = [];

        for (const win of windows) {

            const result = engine.analyzeWindow(ctx, win);
            const file = `${win.id}.json`;

            writeJsonAtomic(path.join(outDir, file), result);

            index.push({
                id: win.id,
                label: win.label,
                kind: win.kind,
                first_t: result.window.first_t,
                last_t: result.window.last_t,
                file: file
            });
        }

        writeJsonAtomic(path.join(outDir, "index.json"), {
            schema: engine.SCHEMA_VERSION,
            analysis: ANALYSIS_ID,
            mode: MODE,
            generated_at: now,
            windows: index,
            default: "all",
            job: {
                ok: true,
                engine: engine.ENGINE_VERSION,
                duration_ms: Date.now() - started,
                observers: observers.map(o => ({ id: o.id, error: o.error })),
                // storia dei tetti (§90): righe usate e righe che il database non ha più
                caps_history: capsInfo,
                warnings: warnings
            }
        });

        // pulizia: finestre non più presenti (es. archivio rimosso)
        const keep = new Set(index.map(w => w.file));

        for (const f of fs.readdirSync(outDir)) {

            if (WINDOW_FILE_RE.test(f) && !keep.has(f)) {
                try { fs.unlinkSync(path.join(outDir, f)); } catch (e) { /* già tolto */ }
            }
        }

        return { ok: true, skipped: false, windows: index.map(w => w.id), warnings: warnings, outDir: outDir };

    } catch (err) {

        try {
            markFailure(outDir, err.message, now);
        } catch (e) {
            // marcare l'esito è best-effort: non deve nascondere l'errore vero
        }

        throw err;

    } finally {

        releaseLock(lockFile);
    }
}

function main() {

    try {

        const summary = run();

        if (summary.skipped) {
            console.log(`analysis_job: ${summary.reason}, nessuna azione`);
            return 0;
        }

        console.log(`analysis_job: ${summary.windows.length} finestre scritte in ${summary.outDir}`);

        summary.warnings.forEach(w => console.error(`analysis_job: avviso: ${w}`));

        return 0;

    } catch (err) {

        console.error(`analysis_job: errore: ${err.message}`);

        return 1;
    }
}

if (require.main === module) {
    process.exitCode = main();
}

module.exports = {
    MODE,
    ANALYSIS_ID,
    run,
    readObserver,
    discoverObservers,
    defaultRoot,
    outBase,
    acquireLock,
    releaseLock,
    loadCapsHistory,
    applyCapsHistory,
    saveCapsHistory,
    CAPS_HISTORY_FILE
};
