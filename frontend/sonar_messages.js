"use strict";

/* ==========================================
   sonar_messages.js

   Messaggi Sonar ricevuti da un nodo (tabella sonar_rx di contacts.db e
   archivi mensili backup/sonar_rx-AAAA-MM.json.gz), come li mostrano l'elenco
   «Sonar Messages» della pagina Nodes e la pagina di dettaglio del mittente
   (docs/ARCHITECTURE.md §96 e §97).

   Per ogni richiesta restituisce:

     messages   le ricezioni, dalla più vecchia alla più recente, con le
                sole colonne che l'elenco, il dettaglio e la mappa usano. Una
                riga = una ricezione fisica (nessuna deduplicazione, come in
                sonar_rx): le copie dello stesso messaggio arrivate per path
                diversi hanno lo stesso pkt_hash (e lo stesso seq) e le
                raggruppa il client (§97). L'eco di un messaggio del nodo stesso NON è un
                messaggio ricevuto (D18, come nell'Analisi) e viene tolta:
                riga con is_local = 1 oppure mittente = uno dei prefissi
                PROPRI del nodo.
     senders    per ogni prefisso di 8 esadecimali di `messages`, chi è,
                letto dalla tabella `nodes` (tutti i tipi di nodo: un
                mittente è quasi sempre un Companion, che /api/meshnodes —
                solo repeater — non contiene):
                  ok          una sola chiave pubblica con quel prefisso
                              (public_key la riporta intera)
                  ambiguous   più chiavi pubbliche con quel prefisso
                  unknown     nessun nodo con quel prefisso
                Nome e posizione sono quelli CORRENTI di `nodes`, anche per
                un mese archiviato (contacts.db non ha storico
                dell'anagrafica: stesso limite della mappa del path advert,
                §84). Il Nodo cerca nel proprio database; il Collettore
                (`senderDbFiles`) in quello di TUTTI i nodi configurati,
                come /api/meshnodes unisce i repeater: la stessa chiave
                vista da più nodi è un solo nodo, con i dati dell'advert
                più recente.
     trace_mon  solo se il chiamante passa `traceMonNodes` (Collettore):
                true se il mittente è un nodo trace-mon, cioè se il suo
                prefisso compare in sonar_tx/advert_tx di UNO dei nodi
                configurati (database e archivi) — la stessa definizione di
                «partecipante» dell'Analisi (D39).

   `available` è false quando il database non ha (ancora) la tabella: nodo
   non aggiornato. Un mese archiviato senza il file sonar_rx del mese non è
   un errore: available true, reason "no_archive", elenco vuoto.

   Il modulo è IDENTICO nel Nodo e nel Collettore e sta in un file a parte,
   e non dentro server.js, perché il server.js del Nodo si mette in ascolto
   appena caricato e non si può provare via HTTP (stesso motivo di
   device_connection.js, §94, e di analysis_api.js, §88).

   Solo lettura: i database sono aperti readOnly, nessuna scrittura.
========================================== */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const { DatabaseSync } = require("node:sqlite");

const gunzipAsync = promisify(zlib.gunzip);

const PREFIX_RE = /^[0-9a-f]{8}$/;

// id delle opzioni del selettore Period della pagina Nodes: "live" oppure il
// nome dell'archivio path_observations del mese (v. listArchiveMonths() in
// server.js). Il mese si ricava da lì: il selettore è uno solo (§75).
const PERIOD_FILE_RE = /^path_observations-(\d{4})-(\d{2})\.json\.gz$/;

const TX_ARCHIVE_RE = /^(?:sonar_tx|advert_tx)-\d{4}-\d{2}\.json\.gz$/;

// Colonne lette da sonar_rx. Si usa l'intersezione con quelle presenti
// (PRAGMA table_info), come fa l'Analisi: un database di una versione
// precedente senza una colonna non fa fallire la richiesta, la colonna manca
// e basta. Senza le REQUIRED la riga non si può mostrare.
const WANTED_COLUMNS = [
    "id", "observed_at", "src_prefix", "seq", "scope_tag", "pkt_hash", "path_hex",
    "hop_count", "hash_size", "rssi", "snr", "is_local"
];
const REQUIRED_COLUMNS = ["observed_at", "src_prefix", "hop_count"];

// I prefissi propri di un nodo (e, sul Collettore, l'insieme dei nodi
// trace-mon) cambiano solo se un nodo cambia companion: una cache breve
// toglie il lavoro ripetuto senza ritardare in modo percepibile un nodo
// nuovo. L'Analisi ricalcola da zero ad ogni giro.
const PREFIXES_TTL_MS = 60 * 1000;

const prefixesCache = new Map();   // dbFile -> { at, set }
const archivePrefixCache = new Map(); // percorso -> { mtimeMs, size, set }

function clearCaches() {

    prefixesCache.clear();
    archivePrefixCache.clear();
}

/* =========================
   UTILITÀ
========================= */

function finiteNumberOrNull(value) {

    if (typeof value === "bigint") {
        value = Number(value);
    }

    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integerOrNull(value) {

    const n = finiteNumberOrNull(value);

    return n !== null && Number.isInteger(n) ? n : null;
}

// Nome dell'archivio sonar_rx del mese a cui si riferisce l'id del selettore
// Period; null se l'id non è un archivio (compreso "live").
function sonarArchiveName(periodFile) {

    if (typeof periodFile !== "string") {
        return null;
    }

    const m = PERIOD_FILE_RE.exec(periodFile);

    return m ? `sonar_rx-${m[1]}-${m[2]}.json.gz` : null;
}

function tableExists(db, table) {

    return db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(table) !== undefined;
}

function openReadOnly(dbFile) {

    return new DatabaseSync(dbFile, { readOnly: true });
}

/* =========================
   PREFISSI PROPRI / NODI TRACE-MON
========================= */

function addPrefix(set, value) {

    if (typeof value !== "string") {
        return;
    }

    const p = value.trim().toLowerCase();

    if (PREFIX_RE.test(p)) {
        set.add(p);
    }
}

// Prefissi (8 hex) con cui un nodo ha TRASMESSO: src_prefix di sonar_tx e
// advert_tx, nel database (mese in corso) e negli archivi mensili. Un
// database senza le tabelle, o un archivio illeggibile, non sono errori: il
// prefisso manca e basta (in console l'archivio illeggibile, per la diagnosi).
async function readNodeTxPrefixes(dbFile, backupDir) {

    const cached = prefixesCache.get(dbFile);

    if (cached && (Date.now() - cached.at) < PREFIXES_TTL_MS) {
        return cached.set;
    }

    const set = new Set();

    if (fs.existsSync(dbFile)) {

        const db = openReadOnly(dbFile);

        try {

            for (const table of ["sonar_tx", "advert_tx"]) {

                if (!tableExists(db, table)) {
                    continue;
                }

                for (const row of db.prepare(
                    `SELECT DISTINCT src_prefix FROM ${table} WHERE src_prefix IS NOT NULL`
                ).all()) {
                    addPrefix(set, row.src_prefix);
                }
            }

        } finally {

            db.close();
        }
    }

    if (fs.existsSync(backupDir)) {

        for (const name of fs.readdirSync(backupDir)) {

            if (!TX_ARCHIVE_RE.test(name)) {
                continue;
            }

            const file = path.join(backupDir, name);

            try {

                const st = fs.statSync(file);
                let entry = archivePrefixCache.get(file);

                if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {

                    const rows = JSON.parse(
                        (await gunzipAsync(await fs.promises.readFile(file))).toString("utf8")
                    );

                    const fromFile = new Set();

                    if (Array.isArray(rows)) {
                        for (const r of rows) {
                            if (r && typeof r === "object") {
                                addPrefix(fromFile, r.src_prefix);
                            }
                        }
                    }

                    entry = { mtimeMs: st.mtimeMs, size: st.size, set: fromFile };
                    archivePrefixCache.set(file, entry);
                }

                entry.set.forEach(p => set.add(p));

            } catch (err) {

                console.error(`sonar_messages: archivio ${name} non leggibile:`, err.message);
            }
        }
    }

    prefixesCache.set(dbFile, { at: Date.now(), set: set });

    return set;
}

// Unione dei prefissi di trasmissione di tutti i nodi configurati =
// «mittenti trace-mon» (Collettore). nodes: [{ dbFile, backupDir }].
async function readTraceMonPrefixes(nodes) {

    const all = new Set();

    for (const n of nodes) {
        (await readNodeTxPrefixes(n.dbFile, n.backupDir)).forEach(p => all.add(p));
    }

    return all;
}

/* =========================
   RIGHE
========================= */

// Riga di sonar_rx (database o archivio) -> riga da mostrare, oppure null se
// non si può mostrare. Nessun valore passa senza controllo di tipo: un
// archivio è un file, non un dato fidato. path_hex che non sia esadecimale
// diventa '' (la mappa dichiarerà il path non noto invece di disegnarlo).
function normalizeRow(r, ownPrefixes) {

    if (!r || typeof r !== "object") {
        return null;
    }

    if (r.is_local) {
        return null;
    }

    const prefix = typeof r.src_prefix === "string" ? r.src_prefix.trim().toLowerCase() : "";

    if (!PREFIX_RE.test(prefix)) {
        return null;
    }

    if (ownPrefixes.has(prefix)) {
        return null;
    }

    const observedAt = finiteNumberOrNull(r.observed_at);
    const hopCount = integerOrNull(r.hop_count);

    if (observedAt === null || hopCount === null || hopCount < 0) {
        return null;
    }

    const pathHex =
        typeof r.path_hex === "string" && /^[0-9a-fA-F]*$/.test(r.path_hex) ?
            r.path_hex.toLowerCase() :
            "";

    return {
        id: integerOrNull(r.id),
        observed_at: observedAt,
        src_prefix: prefix,
        seq: integerOrNull(r.seq),
        scope_tag:
            typeof r.scope_tag === "string" ? r.scope_tag.slice(0, 64) : null,
        pkt_hash: integerOrNull(r.pkt_hash),
        path_hex: pathHex,
        hop_count: hopCount,
        hash_size: integerOrNull(r.hash_size),
        rssi: finiteNumberOrNull(r.rssi),
        snr: finiteNumberOrNull(r.snr)
    };
}

// Righe di sonar_rx del database, o null se la tabella (o una colonna
// indispensabile) manca: nodo non aggiornato. Apre e chiude da sé la
// connessione, così nessun handle resta aperto attraverso un await.
function readLiveRows(dbFile) {

    const db = openReadOnly(dbFile);

    try {

        if (!tableExists(db, "sonar_rx")) {
            return null;
        }

        const present = new Set(
            db.prepare("PRAGMA table_info(sonar_rx)").all().map(c => c.name)
        );

        if (!REQUIRED_COLUMNS.every(c => present.has(c))) {
            return null;
        }

        const columns = WANTED_COLUMNS.filter(c => present.has(c));

        return db.prepare(
            `SELECT ${columns.join(", ")} FROM sonar_rx ORDER BY observed_at ASC` +
            (present.has("id") ? ", id ASC" : "")
        ).all();

    } finally {

        db.close();
    }
}

async function readArchiveRows(file) {

    const rows = JSON.parse(
        (await gunzipAsync(await fs.promises.readFile(file))).toString("utf8")
    );

    if (!Array.isArray(rows)) {
        throw new Error("l'archivio sonar_rx non è una lista");
    }

    return rows;
}

/* =========================
   MITTENTI
========================= */

// prefixes: Set di prefissi presenti nei messaggi; dbFiles: i contacts.db in
// cui cercare (uno per il Nodo, tutti per il Collettore). Un database assente
// o senza la tabella `nodes` è saltato. Un prefisso senza nodo è "unknown".
function resolveSenders(dbFiles, prefixes) {

    // prefisso -> (chiave pubblica -> riga con l'advert più recente)
    const found = new Map();

    if (prefixes.size > 0) {

        for (const dbFile of dbFiles) {

            if (!fs.existsSync(dbFile)) {
                continue;
            }

            const db = openReadOnly(dbFile);

            try {

                if (!tableExists(db, "nodes")) {
                    continue;
                }

                for (const row of db.prepare(
                    "SELECT public_key, adv_name, node_type, adv_lat, adv_lon, last_advert FROM nodes"
                ).all()) {

                    if (typeof row.public_key !== "string") {
                        continue;
                    }

                    const key = row.public_key.toLowerCase();
                    const p = key.slice(0, 8);

                    if (!prefixes.has(p)) {
                        continue;
                    }

                    if (!found.has(p)) {
                        found.set(p, new Map());
                    }

                    const byKey = found.get(p);
                    const known = byKey.get(key);

                    if (
                        !known ||
                        (finiteNumberOrNull(row.last_advert) || 0) >
                        (finiteNumberOrNull(known.last_advert) || 0)
                    ) {
                        byKey.set(key, row);
                    }
                }

            } finally {

                db.close();
            }
        }
    }

    const senders = {};

    for (const p of prefixes) {

        const list = found.has(p) ? Array.from(found.get(p).values()) : [];

        if (list.length === 0) {

            senders[p] = { status: "unknown" };

        } else if (list.length > 1) {

            senders[p] = { status: "ambiguous", count: list.length };

        } else {

            const n = list[0];

            senders[p] = {
                status: "ok",
                public_key: String(n.public_key).toLowerCase(),
                adv_name: typeof n.adv_name === "string" && n.adv_name !== "" ? n.adv_name : null,
                node_type: integerOrNull(n.node_type),
                adv_lat: finiteNumberOrNull(n.adv_lat),
                adv_lon: finiteNumberOrNull(n.adv_lon)
            };
        }
    }

    return senders;
}

/* =========================
   INGRESSO
========================= */

// opts:
//   dbFile, backupDir   contacts.db e cartella degli archivi del nodo
//   file                "live" oppure l'id di un archivio del selettore
//                       Period (già validato dal chiamante con
//                       sonarArchiveName() != null)
//   senderDbFiles       opzionale: i contacts.db in cui cercare i mittenti
//                       (Collettore: tutti i nodi configurati); default
//                       [dbFile]
//   traceMonNodes       opzionale: [{ dbFile, backupDir }] di TUTTI i nodi
//                       configurati (Collettore); aggiunge `trace_mon`
//
// Ritorna { available, reason, messages, senders }; reason: null,
// "no_database" | "no_table" (available false), "no_archive" (available true).
async function loadSonarMessages(opts) {

    const live = opts.file === "live";
    const archiveName = live ? null : sonarArchiveName(opts.file);

    if (!live && !archiveName) {
        throw new Error("periodo non valido");
    }

    const empty = (available, reason) => ({
        available: available,
        reason: reason,
        messages: [],
        senders: {}
    });

    let rawRows;

    if (live) {

        if (!fs.existsSync(opts.dbFile)) {
            return empty(false, "no_database");
        }

        rawRows = readLiveRows(opts.dbFile);

        if (rawRows === null) {
            return empty(false, "no_table");
        }

    } else {

        const file = path.join(opts.backupDir, archiveName);

        if (!fs.existsSync(file)) {
            return empty(true, "no_archive");
        }

        rawRows = await readArchiveRows(file);
    }

    const ownPrefixes = await readNodeTxPrefixes(opts.dbFile, opts.backupDir);

    const messages = [];

    for (const r of rawRows) {

        const m = normalizeRow(r, ownPrefixes);

        if (m) {
            messages.push(m);
        }
    }

    // L'archivio è già in ordine per costruzione (rotate_sonar_advert.py), ma
    // un file non è un dato fidato: l'ordine si garantisce qui.
    messages.sort((a, b) =>
        a.observed_at - b.observed_at ||
        (a.id === null ? 0 : a.id) - (b.id === null ? 0 : b.id)
    );

    const senders = resolveSenders(
        Array.isArray(opts.senderDbFiles) ? opts.senderDbFiles : [opts.dbFile],
        new Set(messages.map(m => m.src_prefix))
    );

    if (Array.isArray(opts.traceMonNodes)) {

        const traceMon = await readTraceMonPrefixes(opts.traceMonNodes);

        for (const m of messages) {
            m.trace_mon = traceMon.has(m.src_prefix);
        }
    }

    return {
        available: true,
        reason: null,
        messages: messages,
        senders: senders
    };
}

module.exports = {
    loadSonarMessages: loadSonarMessages,
    sonarArchiveName: sonarArchiveName,
    readNodeTxPrefixes: readNodeTxPrefixes,
    readTraceMonPrefixes: readTraceMonPrefixes,
    resolveSenders: resolveSenders,
    normalizeRow: normalizeRow,
    clearCaches: clearCaches,
    PREFIXES_TTL_MS: PREFIXES_TTL_MS
};
