"use strict";

/* ==========================================
   analysis_engine.js

   Motore di calcolo della scheda «Analysis» (docs/ARCHITECTURE.md §88).
   Prima analisi: «propagation» — confronto tra i path degli advert
   (tabella path_observations) e quelli dei messaggi del Sonar
   (tabella sonar_rx) di uno o più osservatori (un contacts.db per
   osservatore).

   MODULO PURO: nessuna lettura di file, nessun database, nessun orologio
   implicito (l'ora arriva da input.now), nessuna dipendenza. Riceve righe
   già lette e restituisce oggetti JSON-serializzabili. Le letture le fa
   analysis_job.js (lanciato da cron); server.js non importa mai questo
   file (nessun calcolo per richiesta, §41/§61).

   IDENTICO su Nodo e Collettore (regola di COLLETTORE_DIFFERENZE.md §3:
   algoritmi e costanti non cambiano nel porting). La differenza tra i
   due è solo nei DATI che il job gli passa: il Nodo un osservatore e
   nessun filtro sui partecipanti, il Collettore tutti i nodi di
   nodes.json e i partecipanti ricavati da sonar_tx/advert_tx (D39).

   PERIMETRO (D24, D43): solo descrittivo. Nessuna classificazione del
   limite dei repeater: la «prova positiva» è un conteggio con soglie
   dichiarate, non una stima del limite.

   LIMITI OPERATIVI (§89, D53-D60): il motore riceve anche le righe di
   repeater_config (Flood Max Hops, Unscoped, Advert) dei repeater gestiti
   e ne ricava, per ogni path, se un pacchetto dell'altro tipo (advert
   contro messaggio) avrebbe passato i tetti NOTI, il soffitto che il
   gateway dell'osservatore fissa ai path osservabili e un limite minimo
   osservato per i repeater fuori progetto. Resta descrittivo: nessuna
   classe di limite, nessun colpevole. La regola del tetto effettivo è una
   IPOTESI DI LAVORO dedotta (SPEC §2.3, verifica sul firmware V1 aperta).

   ELENCO VARIABILE DEI REPEATER (§90, D62-D66): ogni gestore può aggiungere
   o togliere un repeater, e un nodo può partire senza e inserirlo dopo.
   L'elenco dei repeater con tetti noti non è quindi fisso: per ogni finestra
   il motore dice se un repeater è stato AGGIUNTO nel periodo (prima lettura
   dopo l'inizio), NON È PIÙ LETTO (nessuna lettura da oltre capCarrySecs
   prima della fine), oppure è FUORI dal periodo; dà le impostazioni valide
   alla FINE del periodo (non quelle di oggi) e un riepilogo per osservatore.
   mergeCaps() unisce le righe di repeater_config del database con la storia
   che il job conserva, perché purge_removed_repeaters.py cancella dal
   database la storia dei repeater tolti dalla configurazione.

   Convenzioni (spec SPEC_analisi_limiti_advert_trace-mon.md, §2.2):
   - il path è sorgente -> hop 1 ... hop N; l'ultimo hop è il gateway;
   - posizione k = k-esimo repeater dopo la sorgente (1 = primo);
   - n = hop_count; posizione «profonda» = k >= 9 (DEEP); i repeater
     profondi DIVERSI dal gateway esistono solo se n >= 10;
   - hash a 1, 2 o 3 byte (hash_size = len(path_hex) / hop_count / 2).
========================================== */

const SCHEMA_VERSION = 1;
const ENGINE_VERSION = "1.2.0";

const PARAMS = Object.freeze({
    // posizione da cui un repeater è «profondo»
    deep: 9,
    // n minimo di un path con almeno un repeater profondo oltre il gateway
    deepMinHops: 10,
    // prova positiva: trasmissioni profonde distinte e sorgenti distinte
    minDeepTransmissions: 3,
    minDeepSources: 2,
    // tolleranza di attività dei candidati prima dell'inizio della finestra
    marginDays: 30,
    // istogrammi: bin 0..23 e «24 e oltre»
    histBins: 25,
    // path distinti conservati per (sorgente, osservatore, tipo)
    maxPathsPerPair: 60,
    // righe della tabella dei repeater
    maxRepeaters: 500,
    // soglie di sufficienza dichiarate (spec §2.7 e studio del 2026-10-21 §3.3):
    // la classificazione dei repeater non è disponibile in questo rilascio
    neededForClassification: Object.freeze({ transmissions: 20, sources: 3 }),
    // --- limiti operativi (D54-D60) ---
    // dopo l'ultima lettura di un tetto lo si considera ancora valido per 3
    // sondaggi (il job di neighbor_monitor gira ogni ~2 h); oltre, «non noto»
    capCarrySecs: 6 * 3600,
    // valore massimo accettato per un tetto (MeshCore: 64); altro = non valido
    capValueMax: 64,
    // segmenti e cambi di regime conservati per repeater e parametro
    maxCapSegments: 12,
    maxCapChanges: 12,
    // soffitti distinti e gateway più frequenti per cella (osservatore, tipo, ambito)
    maxCeilings: 4,
    maxGatewayTop: 5
});

// Parametri letti da repeater_config e colonne corrispondenti.
const CAP_PARAMS = ["max", "unscoped", "advert"];
const CAP_COLUMNS = Object.freeze({ max: "flood_max", unscoped: "flood_max_unscoped", advert: "flood_max_advert" });

// Quali parametri fissano il tetto effettivo di (tipo, ambito): SPEC §2.3,
// DEDOTTA da un solo repeater in due regimi (V1 aperta). Il Sonar è il
// «messaggio» del confronto; FLOOD = senza regione, TC = con regione.
const CAP_RULE = Object.freeze({
    advert: Object.freeze({ FLOOD: ["unscoped", "advert"], TC: ["advert"] }),
    sonar: Object.freeze({ FLOOD: ["unscoped", "max"], TC: ["max"] })
});

// Posizione nel vettore dei limiti minimi osservati (nodes_ref[k].lb)
const LB_INDEX = Object.freeze({
    advert: Object.freeze({ FLOOD: 0, TC: 1 }),
    sonar: Object.freeze({ FLOOD: 2, TC: 3 })
});

const ZERO4 = Object.freeze([0, 0, 0, 0]);

const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
];

const KEY_RE = /^[0-9a-f]{64}$/;
const PREFIX_RE = /^[0-9a-f]{8}$/;
const HEX_RE = /^[0-9a-f]+$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/* =========================
   UTILITÀ
========================= */

//
// Stessa regola di isUsableMapCoordinate() in app.js (§85-§86): numeri
// finiti, nei range, e NON la coppia esatta (0,0) — in MeshCore è il
// valore con cui un nodo senza GPS annuncia la propria posizione.
//
function isUsableCoordinate(lat, lon) {

    return (
        typeof lat === "number" &&
        typeof lon === "number" &&
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        !(lat === 0 && lon === 0)
    );
}

function lower(value) {

    return typeof value === "string" ? value.toLowerCase() : "";
}

function toInt(value) {

    return Number.isInteger(value) ? value : null;
}

function median(sortedValues) {

    const n = sortedValues.length;

    if (n === 0) {
        return null;
    }

    const mid = Math.floor(n / 2);

    return n % 2 === 1
        ? sortedValues[mid]
        : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function hopStats(values) {

    if (values.length === 0) {
        return null;
    }

    const sorted = values.slice().sort((a, b) => a - b);

    return {
        min: sorted[0],
        median: median(sorted),
        max: sorted[sorted.length - 1]
    };
}

function zeros(n) {

    return new Array(n).fill(0);
}

function binIndex(n) {

    return Math.min(Math.max(n, 0), PARAMS.histBins - 1);
}

function addToMapSet(map, key, value) {

    let set = map.get(key);

    if (!set) {
        set = new Set();
        map.set(key, set);
    }

    set.add(value);
}

function monthLabel(month) {

    const m = /^(\d{4})-(\d{2})$/.exec(month);

    if (!m) {
        return month;
    }

    const idx = parseInt(m[2], 10) - 1;

    return `${MONTH_NAMES[idx] || m[2]} ${m[1]}`;
}

//
// Spezza un path in hop. Restituisce { usable, hops, hs }:
//   - n === 0 (DIRECT/vicino diretto): usable, nessun hop;
//   - altrimenti path_hex deve essere esadecimale, di lunghezza
//     n * 2 * hs con hs in 1..3 (hash size 4 non è valido, spec A.1);
//     se hashSizeHint è noto (sonar_rx.hash_size) deve coincidere.
// Un path non coerente è «non usabile»: resta contato per raggiungimento
// e distribuzione (n viene dall'intestazione del pacchetto) ma non entra
// nelle analisi per hop — nessun nome indovinato.
//
function parsePath(hopCount, pathHex, hashSizeHint) {

    const n = toInt(hopCount);

    if (n === null || n < 0) {
        return { usable: false, hops: [], hs: 0 };
    }

    if (n === 0) {
        return { usable: true, hops: [], hs: 0 };
    }

    const hex = lower(pathHex);

    if (hex.length === 0 || !HEX_RE.test(hex) || hex.length % (2 * n) !== 0) {
        return { usable: false, hops: [], hs: 0 };
    }

    const hs = hex.length / (2 * n);

    if (hs < 1 || hs > 3) {
        return { usable: false, hops: [], hs: 0 };
    }

    if (toInt(hashSizeHint) !== null && hashSizeHint !== hs) {
        return { usable: false, hops: [], hs: 0 };
    }

    const hops = [];

    for (let i = 0; i < hex.length; i += 2 * hs) {
        hops.push(hex.slice(i, i + 2 * hs));
    }

    return { usable: true, hops: hops, hs: hs };
}

/* =========================
   UNIONE DEI DATI (usata dal job)
========================= */

//
// Chiave naturale di una riga, per eliminare i doppioni tra database e
// archivio: dopo una rotazione interrotta (§87.17) le stesse righe
// esistono nel file e nel database. Se la riga ha una chiave primaria
// (sonar_rx.id, sonar_tx.seq, advert_tx.id) vale quella; le righe di
// path_observations negli archivi NON hanno id: vale la tupla delle
// colonne (le due copie di una stessa ricezione sono identiche in tutte).
//
function naturalKey(table, row) {

    if (table === "sonar_tx") {
        return `seq:${row.seq}`;
    }

    if ((table === "sonar_rx" || table === "advert_tx") && row.id !== undefined && row.id !== null) {
        return `id:${row.id}`;
    }

    if (table === "path_observations") {
        return [
            row.public_key, row.observed_at, row.pkt_hash, row.path_hex,
            row.hop_count, row.route_type
        ].join("|");
    }

    return JSON.stringify(row);
}

//
// dbRows: righe di contacts.db (o null se la tabella manca);
// archives: [{ month: "AAAA-MM", rows: [...] }, ...].
// Ritorna { rows, present }: le righe del database con _a = null e quelle
// degli archivi con _a = "AAAA-MM", senza le righe d'archivio già presenti
// nel database (a parità di chiave vale il database). `present` è true se
// la tabella esiste nel database o in almeno un archivio.
//
function mergeRows(table, dbRows, archives) {

    const out = [];
    const seen = new Set();
    let present = false;

    if (Array.isArray(dbRows)) {

        present = true;

        for (const r of dbRows) {
            seen.add(naturalKey(table, r));
            out.push(Object.assign({}, r, { _a: null }));
        }
    }

    for (const a of (archives || [])) {

        if (!a || !MONTH_RE.test(a.month) || !Array.isArray(a.rows)) {
            continue;
        }

        present = true;

        for (const r of a.rows) {

            const k = naturalKey(table, r);

            if (seen.has(k)) {
                continue;
            }

            seen.add(k);
            out.push(Object.assign({}, r, { _a: a.month }));
        }
    }

    return { rows: out, present: present };
}

// valore di un tetto in una riga di repeater_config: com'è (anche un valore
// non valido, che buildCapModel conta come «invalid», diverso da NULL), tranne
// «assente» che vale NULL
function capRaw(v) {

    return v === undefined ? null : v;
}

//
// Unisce le righe di repeater_config del DATABASE con la STORIA conservata
// dal job (D62). La tabella non ruota, ma purge_removed_repeaters.py ne
// cancella le righe dei repeater tolti dalla configurazione: senza storia i
// tetti di un repeater tolto sparirebbero anche dai periodi in cui c'era.
// Chiave naturale (public_key, queried_at); a parità vince il database.
// Le righe senza chiave valida o senza istante finito non servono al modello
// dei tetti e non entrano. Ritorna { present, rows }: present = false solo se
// non c'è né la tabella né una storia (tabella assente = «nessun dato»).
//
function mergeCaps(dbRows, histRows) {

    const hasDb = Array.isArray(dbRows);
    const hist = Array.isArray(histRows) ? histRows : [];

    if (!hasDb && hist.length === 0) {
        return { rows: [], present: false };
    }

    const byKey = new Map();

    const add = r => {

        if (!r || typeof r !== "object") {
            return;
        }

        const key = lower(r.public_key);

        if (!KEY_RE.test(key) || !Number.isFinite(r.queried_at)) {
            return;
        }

        byKey.set(`${key}|${r.queried_at}`, {
            public_key: key,
            queried_at: r.queried_at,
            flood_max: capRaw(r.flood_max),
            flood_max_unscoped: capRaw(r.flood_max_unscoped),
            flood_max_advert: capRaw(r.flood_max_advert)
        });
    };

    hist.forEach(add);

    if (hasDb) {
        dbRows.forEach(add);
    }

    const rows = Array.from(byKey.values())
        .sort((a, b) => (a.queried_at - b.queried_at) || (a.public_key < b.public_key ? -1 : (a.public_key > b.public_key ? 1 : 0)));

    return { rows: rows, present: true };
}

/* =========================
   TETTI FLOOD DEI REPEATER GESTITI (D54-D56)
========================= */

//
// Toglie i valori ISOLATI di una serie ordinata nel tempo: un valore diverso
// da entrambi i vicini, che tra loro sono uguali. Sono i residui della
// contaminazione tra comandi CLI (ARCHITECTURE §10-11: una risposta presa per
// un'altra) e i singoli sondaggi sbagliati; giudicati sulla serie ORIGINALE.
// Il primo e l'ultimo valore non hanno due vicini e restano.
//
function dropIsolated(points) {

    const kept = [];
    let outliers = 0;

    for (let i = 0; i < points.length; i++) {

        const p = points[i];
        const isolated =
            i > 0 &&
            i < points.length - 1 &&
            points[i - 1].v === points[i + 1].v &&
            p.v !== points[i - 1].v;

        if (isolated) {
            outliers++;
        } else {
            kept.push(p);
        }
    }

    return { kept: kept, outliers: outliers };
}

// Valori uguali consecutivi -> segmenti { v, from, to, reads }
function toSegments(points) {

    const segs = [];

    for (const p of points) {

        const last = segs[segs.length - 1];

        if (last && last.v === p.v) {
            last.to = p.t;
            last.reads++;
        } else {
            segs.push({ v: p.v, from: p.t, to: p.t, reads: 1 });
        }
    }

    return segs;
}

//
// Modello dei tetti: per ogni repeater con righe in repeater_config (di
// qualunque osservatore) e per ciascuno dei tre parametri, i segmenti di
// valore costante. NULL (timeout LoRa), valori non interi o fuori 0..64 e
// valori isolati non entrano nei segmenti (e sono contati). repeater_config
// non ruota e non ha archivi: le righe sono quelle del database più la storia
// che il job conserva (mergeCaps, D62), perché il database perde le righe dei
// repeater tolti dalla configurazione.
//
function buildCapModel(observers) {

    const byKey = new Map();

    for (const o of observers) {
        for (const r of o.caps) {

            const key = lower(r.public_key);

            if (!KEY_RE.test(key) || !Number.isFinite(r.queried_at)) {
                continue;
            }

            let rec = byKey.get(key);

            if (!rec) {
                rec = {
                    key: key,
                    observers: new Set(),
                    rows: 0,
                    first_t: Infinity,
                    last_t: -Infinity,
                    dropped: { null: 0, invalid: 0, outliers: 0 },
                    pts: { max: [], unscoped: [], advert: [] },
                    segs: {}
                };
                byKey.set(key, rec);
            }

            rec.observers.add(o.id);
            rec.rows++;
            rec.first_t = Math.min(rec.first_t, r.queried_at);
            rec.last_t = Math.max(rec.last_t, r.queried_at);

            for (const p of CAP_PARAMS) {

                const v = r[CAP_COLUMNS[p]];

                if (v === null || v === undefined) {
                    rec.dropped.null++;
                } else if (!Number.isInteger(v) || v < 0 || v > PARAMS.capValueMax) {
                    rec.dropped.invalid++;
                } else {
                    rec.pts[p].push({ t: r.queried_at, v: v });
                }
            }
        }
    }

    for (const rec of byKey.values()) {
        for (const p of CAP_PARAMS) {

            const sorted = rec.pts[p].sort((a, b) => (a.t - b.t) || (a.v - b.v));
            const d = dropIsolated(sorted);

            rec.dropped.outliers += d.outliers;
            rec.segs[p] = toSegments(d.kept);
        }

        rec.pts = null;
    }

    return { byKey: byKey };
}

//
// Valore di UN parametro di UN repeater all'istante t: { lo, hi } (uguali
// se certo) oppure null (nessun segmento o istante prima della prima
// lettura, o dopo l'ultima di oltre capCarrySecs).
//   - dentro un segmento [from, to]: il suo valore;
//   - tra due segmenti il cambio è avvenuto in un punto sconosciuto tra le
//     due letture: { lo = min, hi = max } (zona incerta, risoluzione ~2 h);
//   - dopo l'ultimo segmento: valido ancora per capCarrySecs.
//
function capAt(model, key, param, t) {

    const rec = model.byKey.get(key);

    if (!rec || !Number.isFinite(t)) {
        return null;
    }

    const segs = rec.segs[param];

    if (!segs || segs.length === 0 || t < segs[0].from) {
        return null;
    }

    let i = 0;

    while (i + 1 < segs.length && t >= segs[i + 1].from) {
        i++;
    }

    const s = segs[i];
    const nx = segs[i + 1];

    if (t <= s.to) {
        return { lo: s.v, hi: s.v };
    }

    if (nx) {
        return { lo: Math.min(s.v, nx.v), hi: Math.max(s.v, nx.v) };
    }

    return t <= s.to + PARAMS.capCarrySecs ? { lo: s.v, hi: s.v } : null;
}

//
// Tetto effettivo di (tipo, ambito) all'istante t: minimo dei parametri
// che lo fissano (CAP_RULE), con gli estremi dell'incertezza. null se
// manca anche uno solo dei parametri necessari.
//
function effectiveCap(model, key, type, scope, t) {

    const params = CAP_RULE[type] && CAP_RULE[type][scope];

    if (!params) {
        return null;
    }

    let lo = Infinity;
    let hi = Infinity;

    for (const p of params) {

        const c = capAt(model, key, p, t);

        if (!c) {
            return null;
        }

        lo = Math.min(lo, c.lo);
        hi = Math.min(hi, c.hi);
    }

    return { lo: lo, hi: hi };
}

// formato di uscita: numero se certo, [lo, hi] se incerto, null se non noto
function capOut(c) {

    if (!c) {
        return null;
    }

    return c.lo === c.hi ? c.lo : [c.lo, c.hi];
}

// tetto effettivo CORRENTE (ultimo valore di ogni parametro) o null
function currentEffective(params, type, scope) {

    let m = Infinity;

    for (const p of CAP_RULE[type][scope]) {

        if (params[p].cur === null) {
            return null;
        }

        m = Math.min(m, params[p].cur);
    }

    return m;
}

//
// Tabella dei limiti per la finestra: un elemento per repeater con righe,
// segmenti recenti, cambi di regime (con la zona incerta tra le due
// letture e se cadono nel periodo mostrato), tetti effettivi CORRENTI
// (ultima lettura) e, se la finestra ha un periodo (win.has), anche:
//   - params[p].end e eff_end: le impostazioni e i tetti effettivi validi
//     alla FINE del periodo (win.t1), non quelli di oggi (D63);
//   - period { state, added, ended } (D64): state «in» se il repeater ha
//     impostazioni valide in qualche punto del periodo, «before» se tutte le
//     sue letture (più capCarrySecs) finiscono prima dell'inizio, «after» se
//     la prima lettura è dopo la fine; added = prima lettura dopo l'inizio
//     (prima di allora le impostazioni non sono note); ended = nessuna
//     lettura da oltre capCarrySecs prima della fine (poi non si applicano).
// Senza periodo (nessuna riga di propagazione) period, end e eff_end sono null.
//
function limitsRepeaters(model, win) {

    const list = [];
    const outside = { before: 0, after: 0 };
    const hasPeriod = !!win.has && Number.isFinite(win.t0) && Number.isFinite(win.t1);
    let changed = 0;
    let inPeriod = 0;

    for (const rec of model.byKey.values()) {

        const params = {};
        const changes = [];

        for (const p of CAP_PARAMS) {

            const segs = rec.segs[p];
            const last = segs.length > 0 ? segs[segs.length - 1] : null;

            params[p] = {
                cur: last ? last.v : null,
                since: last ? last.from : null,
                reads: last ? last.reads : 0,
                end: hasPeriod ? capOut(capAt(model, rec.key, p, win.t1)) : null,
                segs: segs.slice(-PARAMS.maxCapSegments).map(s => [s.v, s.from, s.to, s.reads])
            };

            for (let i = 1; i < segs.length; i++) {

                const after = segs[i - 1].to;
                const before = segs[i].from;

                changes.push({
                    p: p,
                    from: segs[i - 1].v,
                    to: segs[i].v,
                    after: after,
                    before: before,
                    in_window: win.has && before >= win.t0 && after <= win.t1
                });
            }
        }

        changes.sort((a, b) => (b.before - a.before) || (a.p < b.p ? -1 : 1));

        if (changes.some(c => c.in_window)) {
            changed++;
        }

        const eff = {};
        const effEnd = hasPeriod ? {} : null;

        for (const type of ["advert", "sonar"]) {

            eff[type] = {
                FLOOD: currentEffective(params, type, "FLOOD"),
                TC: currentEffective(params, type, "TC")
            };

            if (hasPeriod) {
                effEnd[type] = {
                    FLOOD: capOut(effectiveCap(model, rec.key, type, "FLOOD", win.t1)),
                    TC: capOut(effectiveCap(model, rec.key, type, "TC", win.t1))
                };
            }
        }

        let period = null;

        if (hasPeriod) {

            let state = "in";

            if (rec.first_t > win.t1) {
                state = "after";
            } else if (rec.last_t + PARAMS.capCarrySecs < win.t0) {
                state = "before";
            }

            period = {
                state: state,
                added: state === "in" && rec.first_t > win.t0,
                ended: state === "in" && rec.last_t + PARAMS.capCarrySecs < win.t1
            };

            if (state === "in") {
                inPeriod++;
            } else {
                outside[state]++;
            }

        } else {

            inPeriod++;
        }

        list.push({
            key: rec.key,
            observers: Array.from(rec.observers).sort(),
            rows: rec.rows,
            dropped: rec.dropped,
            first_t: rec.first_t,
            last_t: rec.last_t,
            params: params,
            eff_now: eff,
            eff_end: effEnd,
            period: period,
            changes: changes.slice(0, PARAMS.maxCapChanges)
        });
    }

    list.sort((a, b) => (a.key < b.key ? -1 : 1));

    return { list: list, changed: changed, outside: outside, inPeriod: inPeriod };
}

//
// Fonti dei tetti per osservatore (D65): quante righe di repeater_config,
// quanti repeater distinti, quanti di questi hanno impostazioni nel periodo e
// primo/ultimo istante letto. rows = null: tabella assente (nodo non
// aggiornato); rows = 0 o repeaters = 0: il nodo non ha (ancora) repeater
// gestiti, non è un errore.
//
function limitsObservers(observers, list) {

    const stateOf = new Map(list.map(r => [r.key, r.period ? r.period.state : "in"]));

    return observers.map(o => {

        if (!o.hasCaps) {
            return { id: o.id, rows: null, repeaters: 0, in_period: 0, first_t: null, last_t: null };
        }

        const keys = new Set();
        let first = Infinity;
        let last = -Infinity;

        for (const r of o.caps) {

            const key = lower(r.public_key);

            if (!KEY_RE.test(key) || !Number.isFinite(r.queried_at)) {
                continue;
            }

            keys.add(key);
            first = Math.min(first, r.queried_at);
            last = Math.max(last, r.queried_at);
        }

        let inPeriod = 0;

        for (const key of keys) {
            if (stateOf.get(key) === "in") {
                inPeriod++;
            }
        }

        return {
            id: o.id,
            rows: o.caps.length,
            repeaters: keys.size,
            in_period: inPeriod,
            first_t: keys.size > 0 ? first : null,
            last_t: keys.size > 0 ? last : null
        };
    });
}

/* =========================
   CONTESTO (calcolato una volta per tutte le finestre)
========================= */

function normalizeObserver(o) {

    const rows = o.rows || {};
    const arr = x => (Array.isArray(x) ? x : []);

    const ownPrefixes = new Set();

    for (const table of ["sonar_tx", "advert_tx"]) {
        for (const r of arr(rows[table])) {

            const p = lower(r.src_prefix);

            if (PREFIX_RE.test(p)) {
                ownPrefixes.add(p);
            }
        }
    }

    return {
        id: String(o.id),
        label: typeof o.label === "string" && o.label ? o.label : String(o.id),
        lat: isUsableCoordinate(o.lat, o.lon) ? o.lat : null,
        lon: isUsableCoordinate(o.lat, o.lon) ? o.lon : null,
        error: typeof o.error === "string" && o.error ? o.error : null,
        tables: {
            path_observations: Array.isArray(rows.path_observations),
            sonar_rx: Array.isArray(rows.sonar_rx),
            sonar_tx: Array.isArray(rows.sonar_tx),
            advert_tx: Array.isArray(rows.advert_tx)
        },
        rows: {
            path_observations: arr(rows.path_observations),
            sonar_rx: arr(rows.sonar_rx),
            sonar_tx: arr(rows.sonar_tx),
            advert_tx: arr(rows.advert_tx)
        },
        nodes: arr(o.nodes),
        // repeater_config (D54): tabella e dati a parte, non fanno parte di
        // `tables` (la nota observer_missing_tables resta quella di prima)
        caps: arr(rows.repeater_config),
        hasCaps: Array.isArray(rows.repeater_config),
        ownPrefixes: ownPrefixes
    };
}

//
// Anagrafica unita (O7 della specifica): i `nodes` di tutti gli
// osservatori per public_key. Nome e tipo dalla riga con lastmod (poi
// last_seen) più recente; posizione = la più recente tra le utilizzabili.
//
function mergeNodes(observers) {

    const byKey = new Map();

    for (const o of observers) {
        for (const r of o.nodes) {

            const key = lower(r.public_key);

            if (!KEY_RE.test(key)) {
                continue;
            }

            const recency = Number.isFinite(r.lastmod)
                ? r.lastmod
                : (Number.isFinite(r.last_seen) ? r.last_seen : 0);

            let rec = byKey.get(key);

            if (!rec) {
                rec = {
                    key: key,
                    name: null, nameRec: -Infinity,
                    type: null, typeRec: -Infinity, anyType: 0,
                    lat: null, lon: null, posRec: -Infinity,
                    firstSeen: Infinity
                };
                byKey.set(key, rec);
            }

            if (typeof r.adv_name === "string" && r.adv_name !== "" && recency >= rec.nameRec) {
                rec.name = r.adv_name;
                rec.nameRec = recency;
            }

            const type = toInt(r.node_type);

            if (type !== null) {

                rec.anyType = Math.max(rec.anyType, type);

                if (type >= 1 && recency >= rec.typeRec) {
                    rec.type = type;
                    rec.typeRec = recency;
                }
            }

            if (isUsableCoordinate(r.adv_lat, r.adv_lon) && recency >= rec.posRec) {
                rec.lat = r.adv_lat;
                rec.lon = r.adv_lon;
                rec.posRec = recency;
            }

            if (Number.isFinite(r.first_seen)) {
                rec.firstSeen = Math.min(rec.firstSeen, r.first_seen);
            }
        }
    }

    for (const rec of byKey.values()) {

        if (rec.type === null) {
            rec.type = rec.anyType;
        }
    }

    return byKey;
}

//
// input: {
//   now,                       // secondi epoch, per generated_at
//   participants,              // "derive" (Collettore) | "none" (Nodo)
//   observers: [{ id, label, lat, lon, error?, nodes: [...],
//                 rows: { path_observations, sonar_rx, sonar_tx, advert_tx,
//                         repeater_config } }]
// }
// Ogni tabella è un array di righe con _a (null = database, "AAAA-MM" =
// archivio) oppure null/assente (tabella mancante: nodo non aggiornato).
// repeater_config (righe {public_key, queried_at, flood_max,
// flood_max_unscoped, flood_max_advert}) non ha archivi e non ha _a.
//
function createContext(input) {

    const observers = (input.observers || []).map(normalizeObserver);
    const notes = [];

    const nodes = mergeNodes(observers);

    const keysByPrefix = new Map();

    for (const rec of nodes.values()) {

        if (rec.type >= 1) {

            const p = rec.key.slice(0, 8);
            const list = keysByPrefix.get(p);

            if (list) {
                list.push(rec.key);
            } else {
                keysByPrefix.set(p, [rec.key]);
            }
        }
    }

    // attività = ultima ricezione di un advert di quel nodo, su TUTTE le
    // righe caricate (non solo la finestra): la tolleranza di 30 giorni
    // ha senso rispetto a questo, non al contenuto del singolo mese
    const activity = new Map();

    for (const o of observers) {
        for (const r of o.rows.path_observations) {

            const key = lower(r.public_key);
            const t = r.observed_at;

            if (Number.isFinite(t) && t > (activity.get(key) || -Infinity)) {
                activity.set(key, t);
            }
        }
    }

    // partecipanti (D39): prefisso -> osservatore proprietario
    let participants = null;

    if (input.participants === "derive") {

        participants = new Map();

        for (const o of observers) {
            for (const p of o.ownPrefixes) {

                if (participants.has(p) && participants.get(p) !== o.id) {
                    notes.push({ code: "prefix_conflict", prefix: p, observers: [participants.get(p), o.id] });
                    continue;
                }

                participants.set(p, o.id);
            }
        }
    }

    return {
        now: Number.isFinite(input.now) ? input.now : 0,
        mode: participants ? "collector" : "node",
        observers: observers,
        nodes: nodes,
        keysByPrefix: keysByPrefix,
        activity: activity,
        participants: participants,
        caps: buildCapModel(observers),
        notes: notes
    };
}

//
// Finestre disponibili: tutto lo storico, solo il database attuale, e un
// mese per ogni archivio presente (in qualunque tabella, di qualunque
// osservatore). Il mese è quello dell'archivio (mese LOCALE del nodo,
// §87.17), non una data di calendario UTC.
//
function listWindows(ctx) {

    const months = new Set();

    for (const o of ctx.observers) {
        for (const table of Object.keys(o.rows)) {
            for (const r of o.rows[table]) {

                if (r._a && MONTH_RE.test(r._a)) {
                    months.add(r._a);
                }
            }
        }
    }

    const list = [
        { id: "all", label: "All history", kind: "all" },
        { id: "live", label: "Live (current database)", kind: "live" }
    ];

    Array.from(months).sort().reverse().forEach(m => {
        list.push({ id: m, label: monthLabel(m), kind: "month", month: m });
    });

    return list;
}

function inWindow(row, win) {

    if (win.kind === "all") {
        return true;
    }

    if (win.kind === "live") {
        return !row._a;
    }

    return row._a === win.month;
}

/* =========================
   RISOLUZIONE DEGLI HOP (solo prefisso univoco, D42)
========================= */

function buildResolver(ctx, t0, t1) {

    const maps = [null, new Map(), new Map(), new Map()];
    const marginSecs = PARAMS.marginDays * 86400;
    let candidates = 0;

    if (Number.isFinite(t0) && Number.isFinite(t1)) {

        for (const rec of ctx.nodes.values()) {

            if (rec.type !== 2 && rec.type !== 3) {
                continue;
            }

            if (Number.isFinite(rec.firstSeen) && rec.firstSeen > t1) {
                continue;
            }

            const act = ctx.activity.get(rec.key);

            if (act === undefined || act < t0 - marginSecs) {
                continue;
            }

            candidates++;

            for (let hs = 1; hs <= 3; hs++) {

                const p = rec.key.slice(0, 2 * hs);
                const list = maps[hs].get(p);

                if (list) {
                    list.push(rec.key);
                } else {
                    maps[hs].set(p, [rec.key]);
                }
            }
        }
    }

    const cache = new Map();

    function resolve(hash) {

        let r = cache.get(hash);

        if (r) {
            return r;
        }

        const hs = hash.length / 2;
        const list = (hs >= 1 && hs <= 3 && maps[hs].get(hash)) || [];

        r = { k: list.length === 1 ? list[0] : null, c: list.length };
        cache.set(hash, r);

        return r;
    }

    return { resolve: resolve, candidates: candidates };
}

function newCoverage() {

    return { hops: 0, resolved: 0, ambiguous: 0, unknown: 0 };
}

function countHop(cov, r) {

    cov.hops++;

    if (r.k) {
        cov.resolved++;
    } else if (r.c > 1) {
        cov.ambiguous++;
    } else {
        cov.unknown++;
    }
}

/* =========================
   ANALISI DI UNA FINESTRA
========================= */

function newHistCell() {

    return {
        copies: zeros(PARAMS.histBins),
        best: zeros(PARAMS.histBins),
        total_copies: 0,
        total_transmissions: 0
    };
}

function newHist() {

    return {
        advert: { FLOOD: newHistCell(), TC: newHistCell() },
        sonar: { FLOOD: newHistCell(), TC: newHistCell() }
    };
}

// Cella del soffitto del gateway (D59): tutte le copie della finestra, di qualunque sorgente
function newGwCell() {

    return {
        copies: 0,          // copie con path usabile e almeno un hop
        direct: 0,          // 0 hop: ricevuta direttamente, nessun gateway
        unusable: 0,        // path incoerente: nessun gateway
        resolved: 0,        // gateway con prefisso univoco
        known: 0,           // gateway con tetto effettivo noto e certo
        uncertain: 0,       // gateway con tetto in zona incerta (cambio tra due letture)
        below_deep: 0,      // copie da gateway con tetto noto < deepMinHops
        ceil: new Map(),    // tetto -> copie
        gws: new Map()      // chiave gateway -> { copies, t, cap }
    };
}

function newGw() {

    return {
        advert: { FLOOD: newGwCell(), TC: newGwCell() },
        sonar: { FLOOD: newGwCell(), TC: newGwCell() }
    };
}

function scopeOf(routeType) {

    if (routeType === "FLOOD") {
        return "FLOOD";
    }

    if (routeType === "TC_FLOOD") {
        return "TC";
    }

    return null;
}

function analyzeWindow(ctx, win) {

    const observers = ctx.observers;
    const obsById = new Map(observers.map(o => [o.id, o]));
    const notes = ctx.notes.slice();

    /* ---------- selezione delle righe della finestra ---------- */

    const sel = new Map();

    for (const o of observers) {

        const pick = table => o.rows[table].filter(r => inWindow(r, win));

        sel.set(o.id, {
            adv: pick("path_observations"),
            rx: pick("sonar_rx"),
            tx: pick("sonar_tx"),
            atx: pick("advert_tx")
        });
    }

    /* ---------- estremi temporali e candidati ---------- */

    let tFirst = Infinity;
    let tLast = -Infinity;

    for (const o of observers) {

        const s = sel.get(o.id);

        for (const r of s.adv) {
            if (Number.isFinite(r.observed_at)) {
                tFirst = Math.min(tFirst, r.observed_at);
                tLast = Math.max(tLast, r.observed_at);
            }
        }

        for (const r of s.rx) {
            if (Number.isFinite(r.observed_at)) {
                tFirst = Math.min(tFirst, r.observed_at);
                tLast = Math.max(tLast, r.observed_at);
            }
        }
    }

    const hasTime = Number.isFinite(tFirst);
    const resolver = buildResolver(ctx, hasTime ? tFirst : NaN, hasTime ? tLast : NaN);

    /* ---------- sorgenti ---------- */

    // Collettore: i partecipanti (prefissi di sonar_tx/advert_tx dei nodi
    // configurati). Nodo: i prefissi sentiti sul canale Sonar nella
    // finestra più i propri — il Nodo non conosce gli altri nodi (D39).
    const sourcePrefixes = new Map(); // prefisso -> observerId | null

    if (ctx.participants) {

        for (const [p, oid] of ctx.participants) {
            sourcePrefixes.set(p, oid);
        }

    } else {

        for (const o of observers) {

            for (const p of o.ownPrefixes) {
                sourcePrefixes.set(p, o.id);
            }
        }

        for (const o of observers) {
            for (const r of sel.get(o.id).rx) {

                const p = lower(r.src_prefix);

                if (PREFIX_RE.test(p) && !sourcePrefixes.has(p) && !o.ownPrefixes.has(p)) {
                    sourcePrefixes.set(p, null);
                }
            }
        }
    }

    const sources = new Map();

    for (const [p, oid] of sourcePrefixes) {

        const keys = ctx.keysByPrefix.get(p) || [];
        const key = keys.length === 1 ? keys[0] : null;
        const rec = key ? ctx.nodes.get(key) : null;
        const owner = oid ? obsById.get(oid) : null;

        sources.set(p, {
            prefix: p,
            observer_id: oid,
            label: owner ? owner.label : (rec && rec.name ? rec.name : p),
            key: key,
            key_status: keys.length === 1 ? "ok" : (keys.length > 1 ? "ambiguous" : "unknown"),
            tx: { sent: 0, unknown: 0, failed: 0, pending: 0 },
            advert_tx_logged: null,
            advert_seen_any: 0,
            last_advert_t: null
        });
    }

    const sourceByKey = new Map();

    for (const s of sources.values()) {
        if (s.key) {
            sourceByKey.set(s.key, s);
        }
    }

    /* ---------- trasmissioni registrate (sonar_tx, advert_tx) ---------- */

    let firstSonarT = Infinity;

    for (const o of observers) {

        const s = sel.get(o.id);

        for (const r of s.tx) {

            const p = lower(r.src_prefix);
            const src = sources.get(p);

            if (Number.isFinite(r.created_at)) {
                firstSonarT = Math.min(firstSonarT, r.created_at);
            }

            if (!src) {
                continue;
            }

            const st = r.status;

            if (st === "sent" || st === "unknown" || st === "failed" || st === "pending") {
                src.tx[st]++;
            }
        }

        for (const r of s.atx) {

            const src = sources.get(lower(r.src_prefix));

            if (!src || r.kind !== "flood") {
                continue;
            }

            if (src.advert_tx_logged === null) {
                src.advert_tx_logged = 0;
            }

            if (r.status === "sent" || r.status === "unknown") {
                src.advert_tx_logged++;
            }
        }
    }

    /* ---------- ricezioni Sonar accettate ---------- */

    const excluded = new Map(); // prefisso -> {copies, messages:Set, observers:Set}
    const sonarRx = [];          // copie accettate {o, row, prefix, tx, n, parsed, scope}

    for (const o of observers) {
        for (const r of sel.get(o.id).rx) {

            const p = lower(r.src_prefix);

            if (!PREFIX_RE.test(p)) {
                continue;
            }

            // l'eco dei propri messaggi non è un'osservazione (D18)
            if (r.is_local || o.ownPrefixes.has(p)) {
                continue;
            }

            if (ctx.participants && !ctx.participants.has(p)) {

                let ex = excluded.get(p);

                if (!ex) {
                    ex = { copies: 0, messages: new Set(), observers: new Set() };
                    excluded.set(p, ex);
                }

                ex.copies++;
                ex.messages.add(r.seq);
                ex.observers.add(o.id);
                continue;
            }

            const n = toInt(r.hop_count);

            if (n === null || n < 0) {
                continue;
            }

            if (Number.isFinite(r.observed_at)) {
                firstSonarT = Math.min(firstSonarT, r.observed_at);
            }

            sonarRx.push({
                o: o,
                row: r,
                prefix: p,
                tx: `${p}#${r.seq}`,
                n: n,
                scope: scopeOf(r.route_type),
                parsed: null
            });
        }
    }

    // Confronto a parità di periodo (D51): gli advert dei pannelli 2-4 si
    // limitano al periodo in cui esistono dati Sonar; il pannello 5 usa
    // tutti gli advert della finestra.
    const commonFrom = Number.isFinite(firstSonarT) ? firstSonarT : null;

    /* ---------- advert ---------- */

    const coverage = {
        adverts: newCoverage(),
        sonar: newCoverage(),
        // hop in posizione profonda (9 .. n-1): quanti hanno un nome — è la
        // copertura che conta per la prova positiva
        deep_adverts: newCoverage(),
        deep_sonar: newCoverage(),
        unusable_paths: { adverts: 0, sonar: 0 },
        skipped_routes: 0
    };

    const advertRows = [];

    for (const o of observers) {
        for (const r of sel.get(o.id).adv) {

            const scope = scopeOf(r.route_type);

            if (!scope) {
                coverage.skipped_routes++;
                continue;
            }

            const n = toInt(r.hop_count);
            const key = lower(r.public_key);

            if (n === null || n < 0 || !KEY_RE.test(key)) {
                continue;
            }

            const t = r.observed_at;
            const src = sourceByKey.get(key) || null;

            advertRows.push({
                o: o,
                row: r,
                key: key,
                src: src,
                t: t,
                n: n,
                scope: scope,
                tx: `${key}#${r.pkt_hash !== null && r.pkt_hash !== undefined ? r.pkt_hash : "t" + r.adv_timestamp}`,
                common: commonFrom === null || (Number.isFinite(t) && t >= commonFrom),
                parsed: null
            });
        }
    }

    function parsed(item, hint) {

        if (!item.parsed) {
            item.parsed = parsePath(item.n, item.row.path_hex, hint);
        }

        return item.parsed;
    }

    /* ---------- limiti minimi osservati (D58) e soffitto del gateway (D59) ---------- */

    // Un repeater visto in posizione k ha, per quel tipo e ambito, un tetto
    // effettivo >= k (regola di CAP_RULE, ipotesi di lavoro). Vale per ogni
    // hop, GATEWAY INCLUSO (a differenza della prova D43: qui conta solo che
    // abbia inoltrato).
    // Il gateway è l'ultimo hop del path, il vicino dell'osservatore: il suo
    // tetto effettivo per (tipo, ambito) all'istante della ricezione limita
    // gli hop di ogni copia che passa da lui.
    // POPOLAZIONE di entrambi: TUTTE le copie della finestra, di qualunque
    // sorgente e senza il periodo comune (come il pannello 5), non solo
    // quelle dell'istogramma: sono proprietà del repeater e del gateway, non
    // del confronto. Un solo passaggio e nessuna cache di parsed(): non
    // trattiene in memoria i path di tutti gli advert della finestra.
    const lbMap = new Map();   // chiave repeater -> [advFLOOD, advTC, sonarFLOOD, sonarTC]
    const gw = { all: newGw(), by_observer: {} };

    for (const o of observers) {
        gw.by_observer[o.id] = newGw();
    }

    function notePath(item, type, hint) {

        if (!item.scope) {
            return;
        }

        const p = item.parsed || parsePath(item.n, item.row.path_hex, hint);
        const cells = [gw.all[type][item.scope], gw.by_observer[item.o.id][type][item.scope]];

        if (!p.usable) {

            for (const c of cells) {
                c.unusable++;
            }

            return;
        }

        if (p.hops.length === 0) {

            for (const c of cells) {
                c.direct++;
            }

            return;
        }

        const idx = LB_INDEX[type][item.scope];
        const t = item.row.observed_at;
        const tt = Number.isFinite(t) ? t : -Infinity;
        let gateway = null;

        for (let i = 0; i < p.hops.length; i++) {

            const r = resolver.resolve(p.hops[i]);

            if (i === p.hops.length - 1) {
                gateway = r;
            }

            if (!r.k) {
                continue;
            }

            let e = lbMap.get(r.k);

            if (!e) {
                e = [0, 0, 0, 0];
                lbMap.set(r.k, e);
            }

            if (i + 1 > e[idx]) {
                e[idx] = i + 1;
            }
        }

        const cap = gateway.k ? effectiveCap(ctx.caps, gateway.k, type, item.scope, t) : null;

        for (const c of cells) {

            c.copies++;

            if (!gateway.k) {
                continue;
            }

            c.resolved++;

            let g = c.gws.get(gateway.k);

            if (!g) {
                g = { copies: 0, t: -Infinity, cap: null };
                c.gws.set(gateway.k, g);
            }

            g.copies++;

            if (tt >= g.t) {
                g.t = tt;
                g.cap = cap;
            }

            if (!cap) {
                continue;
            }

            if (cap.lo !== cap.hi) {

                c.uncertain++;

            } else {

                c.known++;
                c.ceil.set(cap.lo, (c.ceil.get(cap.lo) || 0) + 1);

                if (cap.lo < PARAMS.deepMinHops) {
                    c.below_deep++;
                }
            }
        }
    }

    for (const it of advertRows) {
        notePath(it, "advert", null);
    }

    for (const it of sonarRx) {
        notePath(it, "sonar", toInt(it.row.hash_size));
    }

    function lowerBound(key, type, scope) {

        return (lbMap.get(key) || ZERO4)[LB_INDEX[type][scope]];
    }

    /* ---------- «il pacchetto dell'altro tipo poteva seguire?» (D57) ---------- */

    // Per un path osservato di tipo `type` (advert/sonar) con ambito S, valuta
    // un pacchetto dell'ALTRO tipo con lo stesso ambito sullo stesso percorso.
    // Per ogni hop (posizione j, 1-based):
    //   b = tetto noto, anche il più permissivo < j: non passerebbe;
    //   u = tetto in zona incerta (lo < j <= hi);
    //   p = tetto noto >= j: passerebbe;
    //   c = tetto non noto ma il repeater è stato visto inoltrare l'altro
    //       tipo a posizione >= j (limite minimo osservato): «scagionato»;
    //   n = nessuna evidenza (hop non risolto o repeater sconosciuto).
    // Verdetto del path: s (stopped: almeno un b), u (uncertain), o (open:
    // nessun blocco noto e almeno un tetto noto), x (nocaps: nessun tetto
    // noto sul path). Descrittivo: non dice che il repeater «blocchi».
    function evaluate(it, type, hint) {

        if (!it.scope) {
            return null;
        }

        const p = parsed(it, hint);

        if (!p.usable || p.hops.length === 0) {
            return null;
        }

        const other = type === "advert" ? "sonar" : "advert";
        const t = it.row.observed_at;
        const codes = [];
        const own = [];
        const oth = [];
        let blocked = false;
        let uncertain = false;
        let known = 0;
        let free = 0;
        let stop = null;

        for (let i = 0; i < p.hops.length; i++) {

            const pos = i + 1;
            const r = resolver.resolve(p.hops[i]);
            const co = r.k ? effectiveCap(ctx.caps, r.k, type, it.scope, t) : null;
            const cx = r.k ? effectiveCap(ctx.caps, r.k, other, it.scope, t) : null;
            let code;

            own.push(capOut(co));
            oth.push(capOut(cx));

            if (cx) {

                known++;

                if (cx.hi < pos) {

                    code = "b";
                    blocked = true;

                    if (stop === null) {
                        stop = { pos: pos, key: r.k, cap: capOut(cx) };
                    }

                } else if (cx.lo < pos) {

                    code = "u";
                    uncertain = true;

                } else {

                    code = "p";
                }

            } else if (r.k && lowerBound(r.k, other, it.scope) >= pos) {

                code = "c";

            } else {

                code = "n";
                free++;
            }

            codes.push(code);
        }

        return {
            v: blocked ? "s" : (uncertain ? "u" : (known > 0 ? "o" : "x")),
            hs: codes.join(""),
            own: own,
            oth: oth,
            free: free,
            stop: stop
        };
    }

    /* ---------- matrice, istogrammi, coppie ---------- */

    const hist = { all: newHist(), by_observer: {} };

    for (const o of observers) {
        hist.by_observer[o.id] = newHist();
    }

    const bestMap = { advert: new Map(), sonar: new Map() };
    const cells = new Map(); // `${prefix}|${oid}` -> accumulatori
    const pairs = new Map(); // idem -> {advert: Map, sonar: Map}
    const seenAny = new Map(); // prefisso -> Set(tx)
    const nodesRef = new Map();

    function cellFor(prefix, oid) {

        const k = `${prefix}|${oid}`;
        let c = cells.get(k);

        if (!c) {
            c = {
                sonar: { tx: new Set(), copies: 0, hops: [], deep_copies: 0, last_t: null },
                advert: { tx: new Set(), copies: 0, hops: [], deep_copies: 0, last_t: null }
            };
            cells.set(k, c);
        }

        return c;
    }

    function pairFor(prefix, oid) {

        const k = `${prefix}|${oid}`;
        let p = pairs.get(k);

        if (!p) {
            p = { advert: new Map(), sonar: new Map() };
            pairs.set(k, p);
        }

        return p;
    }

    function ref(key) {

        if (!key || nodesRef.has(key)) {
            return;
        }

        const rec = ctx.nodes.get(key);

        nodesRef.set(key, {
            n: rec && rec.name ? rec.name : null,
            t: rec ? rec.type : null,
            la: rec ? rec.lat : null,
            lo: rec ? rec.lon : null
        });
    }

    function hopObjects(item, cov, hint) {

        const p = parsed(item, hint);

        if (!p.usable) {
            return null;
        }

        return p.hops.map(h => {

            const r = resolver.resolve(h);

            countHop(cov, r);
            ref(r.k);

            return { h: h, k: r.k, c: r.c };
        });
    }

    function accumulatePair(map, item, hops, extra) {

        const pk = `${item.scope}|${item.row.path_hex || ""}`;
        let e = map.get(pk);
        const t = item.row.observed_at;

        if (!e) {
            e = {
                n: item.n, scope: item.scope, hops: hops,
                count: 0, tx: new Set(), first_t: t, last_t: t, last_seq: null,
                cp: { s: 0, u: 0, o: 0, x: 0 }, ev: null, ev_t: -Infinity
            };
            map.set(pk, e);
        }

        e.count++;
        e.tx.add(item.tx);

        if (Number.isFinite(t)) {
            e.first_t = Number.isFinite(e.first_t) ? Math.min(e.first_t, t) : t;
            e.last_t = Number.isFinite(e.last_t) ? Math.max(e.last_t, t) : t;
        }

        if (extra && extra.seq !== undefined) {
            e.last_seq = extra.seq;
        }

        // verdetto «l'altro tipo poteva seguire?» (D57): conteggio per copia;
        // i dettagli per hop sono quelli dell'osservazione più recente
        if (extra && extra.ev) {

            const tt = Number.isFinite(t) ? t : -Infinity;

            e.cp[extra.ev.v]++;

            if (!e.ev || tt >= e.ev_t) {
                e.ev = extra.ev;
                e.ev_t = tt;
            }
        }
    }

    // --- sonar (solo sorgenti accettate)

    for (const it of sonarRx) {

        const src = sources.get(it.prefix);

        if (!src) {
            continue;
        }

        const oid = it.o.id;
        const c = cellFor(it.prefix, oid).sonar;
        const t = it.row.observed_at;

        c.tx.add(it.tx);
        c.copies++;
        c.hops.push(it.n);

        if (it.n >= PARAMS.deepMinHops) {
            c.deep_copies++;
        }

        if (Number.isFinite(t) && (c.last_t === null || t > c.last_t)) {
            c.last_t = t;
        }

        if (it.scope) {

            for (const h of [hist.all, hist.by_observer[oid]]) {
                h.sonar[it.scope].copies[binIndex(it.n)]++;
                h.sonar[it.scope].total_copies++;
            }

            const bk = `${it.tx}@${oid}`;
            const b = bestMap.sonar.get(bk);

            if (!b || it.n > b.n) {
                bestMap.sonar.set(bk, { n: it.n, scope: it.scope, oid: oid });
            }
        }

        const hops = hopObjects(it, coverage.sonar, toInt(it.row.hash_size));

        if (hops === null) {
            coverage.unusable_paths.sonar++;
            continue;
        }

        accumulatePair(pairFor(it.prefix, oid).sonar, it, hops, {
            seq: it.row.seq,
            ev: evaluate(it, "sonar", toInt(it.row.hash_size))
        });
    }

    // --- advert

    for (const it of advertRows) {

        const src = it.src;

        if (!src || !it.common) {
            continue;
        }

        addToMapSet(seenAny, src.prefix, it.tx);

        if (Number.isFinite(it.t) && (src.last_advert_t === null || it.t > src.last_advert_t)) {
            src.last_advert_t = it.t;
        }

        const oid = it.o.id;

        // L'advert di un nodo risentito dal nodo stesso (ritorno via
        // repeater) prova che è partito («visto da qualcuno», sopra) ma
        // non entra in matrice, istogrammi e coppie: il Sonar non registra
        // l'eco dei propri messaggi (D18), il confronto resta a parità.
        if (oid === src.observer_id) {
            continue;
        }

        for (const h of [hist.all, hist.by_observer[oid]]) {
            h.advert[it.scope].copies[binIndex(it.n)]++;
            h.advert[it.scope].total_copies++;
        }

        const bk = `${it.tx}@${oid}`;
        const b = bestMap.advert.get(bk);

        if (!b || it.n > b.n) {
            bestMap.advert.set(bk, { n: it.n, scope: it.scope, oid: oid });
        }

        const c = cellFor(src.prefix, oid).advert;

        c.tx.add(it.tx);
        c.copies++;
        c.hops.push(it.n);

        if (it.n >= PARAMS.deepMinHops) {
            c.deep_copies++;
        }

        if (Number.isFinite(it.t) && (c.last_t === null || it.t > c.last_t)) {
            c.last_t = it.t;
        }

        const hops = hopObjects(it, coverage.adverts, null);

        if (hops === null) {
            coverage.unusable_paths.adverts++;
            continue;
        }

        accumulatePair(pairFor(src.prefix, oid).advert, it, hops, { ev: evaluate(it, "advert", null) });
    }

    for (const type of ["advert", "sonar"]) {
        for (const b of bestMap[type].values()) {
            for (const h of [hist.all, hist.by_observer[b.oid]]) {
                h[type][b.scope].best[binIndex(b.n)]++;
                h[type][b.scope].total_transmissions++;
            }
        }
    }

    for (const [p, set] of seenAny) {
        sources.get(p).advert_seen_any = set.size;
    }

    /* ---------- repeater a posizioni profonde (prova positiva) ---------- */

    const deepAdv = new Map();   // chiave repeater -> accumulatori
    const deepSonar = new Map();

    function deepSlot(map, key) {

        let e = map.get(key);

        if (!e) {
            e = {
                tx: new Set(), sources: new Set(), observers: new Set(), max_pos: 0, last_t: null, copies: 0,
                follow: { s: 0, u: 0, o: 0, x: 0 }, stop: null, stop_t: -Infinity
            };
            map.set(key, e);
        }

        return e;
    }

    // evalType: "sonar" per le copie Sonar (D57: l'advert dello stesso ambito
    // sullo stesso percorso poteva seguire?); null per gli advert
    function collectDeep(map, cov, it, hint, srcId, evalType) {

        if (it.n < PARAMS.deepMinHops) {
            return;
        }

        const p = parsed(it, hint);

        if (!p.usable) {
            return;
        }

        const ev = evalType ? evaluate(it, evalType, hint) : null;

        // posizioni 9 .. n-1 (indici 8 .. n-2): il gateway (posizione n) è escluso
        for (let i = PARAMS.deep - 1; i <= it.n - 2; i++) {

            const r = resolver.resolve(p.hops[i]);

            countHop(cov, r);

            if (!r.k) {
                continue;
            }

            const e = deepSlot(map, r.k);
            const t = it.row.observed_at;

            ref(r.k);
            e.tx.add(it.tx);
            e.sources.add(srcId);
            e.observers.add(it.o.id);
            e.copies++;
            e.max_pos = Math.max(e.max_pos, i + 1);

            if (Number.isFinite(t) && (e.last_t === null || t > e.last_t)) {
                e.last_t = t;
            }

            if (ev) {

                const tt = Number.isFinite(t) ? t : -Infinity;

                e.follow[ev.v]++;

                if (ev.stop && tt >= e.stop_t) {
                    e.stop = ev.stop;
                    e.stop_t = tt;
                }
            }
        }
    }

    for (const it of advertRows) {
        collectDeep(deepAdv, coverage.deep_adverts, it, null, it.key, null);
    }

    const sonarDeepTx = new Set();
    const sonarDeepSources = new Set();
    let sonarDeepCopies = 0;

    for (const it of sonarRx) {

        if (it.n >= PARAMS.deepMinHops) {
            sonarDeepCopies++;
            sonarDeepTx.add(it.tx);
            sonarDeepSources.add(it.prefix);
        }

        collectDeep(deepSonar, coverage.deep_sonar, it, toInt(it.row.hash_size), it.prefix, "sonar");
    }

    const repeaters = [];
    const repKeys = new Set([...deepAdv.keys(), ...deepSonar.keys()]);

    for (const key of repKeys) {

        const a = deepAdv.get(key) || null;
        const s = deepSonar.get(key) || null;
        const proven = !!a && a.tx.size >= PARAMS.minDeepTransmissions && a.sources.size >= PARAMS.minDeepSources;

        let status;

        if (proven) {
            status = "proven";
        } else if (a) {
            status = "indication";
        } else {
            status = "messages_only";
        }

        repeaters.push({
            key: key,
            status: status,
            advert: a && {
                transmissions: a.tx.size,
                sources: a.sources.size,
                observers: a.observers.size,
                max_position: a.max_pos,
                last_t: a.last_t
            },
            sonar: s && {
                transmissions: s.tx.size,
                sources: s.sources.size,
                observers: s.observers.size,
                max_position: s.max_pos,
                last_t: s.last_t
            },
            // D57: per le copie Sonar profonde che contengono il repeater, un
            // advert dello stesso ambito sullo stesso percorso poteva seguire?
            follow: s ? s.follow : null,
            stop: s && s.stop ? s.stop : null
        });
    }

    const statusRank = { proven: 0, indication: 1, messages_only: 2 };

    repeaters.sort((x, y) => {

        if (statusRank[x.status] !== statusRank[y.status]) {
            return statusRank[x.status] - statusRank[y.status];
        }

        const xt = (x.advert ? x.advert.transmissions : 0) * 1e6 + (x.sonar ? x.sonar.transmissions : 0);
        const yt = (y.advert ? y.advert.transmissions : 0) * 1e6 + (y.sonar ? y.sonar.transmissions : 0);

        if (xt !== yt) {
            return yt - xt;
        }

        return x.key < y.key ? -1 : 1;
    });

    const repeatersTruncated = Math.max(0, repeaters.length - PARAMS.maxRepeaters);

    repeaters.length = Math.min(repeaters.length, PARAMS.maxRepeaters);

    for (const r of repeaters) {

        if (r.stop) {
            ref(r.stop.key);
        }
    }

    /* ---------- uscita: matrice e coppie ---------- */

    function statsOut(c) {

        return {
            received: c.tx.size,
            copies: c.copies,
            hops: hopStats(c.hops),
            deep_copies: c.deep_copies,
            last_t: c.last_t
        };
    }

    const matrix = [];

    for (const src of sources.values()) {
        for (const o of observers) {

            if (o.id === src.observer_id) {
                continue;
            }

            const c = cells.get(`${src.prefix}|${o.id}`);
            const empty = {
                sonar: { tx: new Set(), copies: 0, hops: [], deep_copies: 0, last_t: null },
                advert: { tx: new Set(), copies: 0, hops: [], deep_copies: 0, last_t: null }
            };
            const cc = c || empty;

            matrix.push({
                source: src.prefix,
                observer: o.id,
                // null = l'osservatore non ha la tabella (nodo non aggiornato): nessun dato, non zero
                sonar: o.tables.sonar_rx ? statsOut(cc.sonar) : null,
                advert: src.key && o.tables.path_observations ? statsOut(cc.advert) : null
            });
        }
    }

    const pairsOut = {};

    for (const [pk, p] of pairs) {

        const out = {};
        const truncated = {};

        for (const type of ["advert", "sonar"]) {

            const list = Array.from(p[type].values())
                .map(e => {

                    const row = {
                        n: e.n,
                        scope: e.scope,
                        hops: e.hops,
                        count: e.count,
                        transmissions: e.tx.size,
                        first_t: e.first_t,
                        last_t: e.last_t,
                        last_seq: e.last_seq,
                        // D57: l'altro tipo di pacchetto poteva seguire? Conteggio per copia
                        cp: e.cp
                    };

                    // dettagli per hop dell'osservazione più recente: tetti propri e
                    // dell'altro tipo (solo se qualcuno è noto) e codice di ogni hop
                    if (e.ev) {

                        row.hs = e.ev.hs;
                        row.fr = e.ev.free;

                        if (e.ev.own.some(c => c !== null)) {
                            row.co = e.ev.own;
                        }

                        if (e.ev.oth.some(c => c !== null)) {
                            row.cx = e.ev.oth;
                        }
                    }

                    return row;
                })
                .sort((a, b) => (b.last_t || 0) - (a.last_t || 0));

            truncated[type] = Math.max(0, list.length - PARAMS.maxPathsPerPair);
            out[type] = list.slice(0, PARAMS.maxPathsPerPair);
        }

        out.truncated = truncated;
        pairsOut[pk] = out;
    }

    /* ---------- limiti operativi (D54-D60) ---------- */

    const lim = limitsRepeaters(ctx.caps, { has: hasTime, t0: tFirst, t1: tLast });

    for (const r of lim.list) {
        ref(r.key);
    }

    function gwOut(cell, type, scope) {

        const ceilings = Array.from(cell.ceil.entries())
            .map(([cap, copies]) => ({ cap: cap, copies: copies }))
            .sort((a, b) => (b.copies - a.copies) || (a.cap - b.cap))
            .slice(0, PARAMS.maxCeilings);

        const top = Array.from(cell.gws.entries())
            .map(([key, g]) => ({
                key: key,
                copies: g.copies,
                cap: capOut(g.cap),
                lb: lowerBound(key, type, scope)
            }))
            .sort((a, b) => (b.copies - a.copies) || (a.key < b.key ? -1 : 1))
            .slice(0, PARAMS.maxGatewayTop);

        for (const g of top) {
            ref(g.key);
        }

        return {
            copies: cell.copies,
            direct: cell.direct,
            unusable: cell.unusable,
            resolved: cell.resolved,
            known: cell.known,
            uncertain: cell.uncertain,
            below_deep: cell.below_deep,
            ceilings: ceilings,
            top: top
        };
    }

    function gwBlock(g) {

        const out = {};

        for (const type of ["advert", "sonar"]) {
            out[type] = {
                FLOOD: gwOut(g[type].FLOOD, type, "FLOOD"),
                TC: gwOut(g[type].TC, type, "TC")
            };
        }

        return out;
    }

    const gatewaysOut = { all: gwBlock(gw.all), by_observer: {} };

    for (const o of observers) {
        gatewaysOut.by_observer[o.id] = gwBlock(gw.by_observer[o.id]);
    }

    // posizioni delle sorgenti e dei repeater referenziati
    for (const s of sources.values()) {
        ref(s.key);
    }

    const nodesRefOut = {};

    for (const [k, v] of nodesRef) {

        // limite minimo osservato (D58), solo se il repeater è mai comparso
        const lb = lbMap.get(k);

        nodesRefOut[k] = lb && lb.some(x => x > 0) ? Object.assign({}, v, { lb: lb }) : v;
    }

    /* ---------- stato dei dati ---------- */

    const observersOut = observers.map(o => {

        const s = sel.get(o.id);
        const advRows = s.adv.filter(r => scopeOf(r.route_type));
        const msgs = new Set();
        let rxCopies = 0;

        for (const it of sonarRx) {
            if (it.o.id === o.id) {
                rxCopies++;
                msgs.add(it.tx);
            }
        }

        let aFirst = null;
        let aLast = null;

        for (const r of advRows) {
            if (Number.isFinite(r.observed_at)) {
                aFirst = aFirst === null ? r.observed_at : Math.min(aFirst, r.observed_at);
                aLast = aLast === null ? r.observed_at : Math.max(aLast, r.observed_at);
            }
        }

        return {
            id: o.id,
            label: o.label,
            lat: o.lat,
            lon: o.lon,
            error: o.error,
            own_prefixes: Array.from(o.ownPrefixes).sort(),
            tables: o.tables,
            counts: {
                // tabella assente = «nessun dato» (null), mai zero
                adverts: o.tables.path_observations ? advRows.length : null,
                advert_first_t: aFirst,
                advert_last_t: aLast,
                sonar_rx_copies: o.tables.sonar_rx ? rxCopies : null,
                sonar_rx_messages: o.tables.sonar_rx ? msgs.size : null,
                sonar_tx: o.tables.sonar_tx ? s.tx.length : null,
                advert_tx: o.tables.advert_tx ? s.atx.length : null
            }
        };
    });

    for (const o of observers) {

        const missing = Object.keys(o.tables).filter(t => !o.tables[t]);

        if (o.error) {
            notes.push({ code: "observer_error", observer: o.id, message: o.error });
        } else if (missing.length > 0) {
            notes.push({ code: "observer_missing_tables", observer: o.id, tables: missing });
        }
    }

    if (!ctx.participants) {
        notes.push({ code: "no_participant_filter" });
    }

    for (const s of sources.values()) {

        if (s.key_status !== "ok") {
            notes.push({ code: "source_key_" + s.key_status, prefix: s.prefix });
        }
    }

    const excludedOut = Array.from(excluded.entries())
        .map(([p, e]) => {

            const keys = ctx.keysByPrefix.get(p) || [];
            const rec = keys.length === 1 ? ctx.nodes.get(keys[0]) : null;

            return {
                prefix: p,
                name: rec && rec.name ? rec.name : null,
                copies: e.copies,
                messages: e.messages.size,
                observers: Array.from(e.observers).sort()
            };
        })
        .sort((a, b) => b.copies - a.copies);

    const sonarSpan = { first_t: null, last_t: null };

    for (const it of sonarRx) {

        const t = it.row.observed_at;

        if (Number.isFinite(t)) {
            sonarSpan.first_t = sonarSpan.first_t === null ? t : Math.min(sonarSpan.first_t, t);
            sonarSpan.last_t = sonarSpan.last_t === null ? t : Math.max(sonarSpan.last_t, t);
        }
    }

    const needed = PARAMS.neededForClassification;

    return {
        schema: SCHEMA_VERSION,
        analysis: "propagation",
        engine: ENGINE_VERSION,
        generated_at: ctx.now,
        mode: ctx.mode,
        window: {
            id: win.id,
            label: win.label,
            kind: win.kind,
            first_t: hasTime ? tFirst : null,
            last_t: hasTime ? tLast : null,
            common_from: commonFrom
        },
        params: {
            deep: PARAMS.deep,
            deep_min_hops: PARAMS.deepMinHops,
            min_deep_transmissions: PARAMS.minDeepTransmissions,
            min_deep_sources: PARAMS.minDeepSources,
            margin_days: PARAMS.marginDays,
            hist_bins: PARAMS.histBins,
            max_paths_per_pair: PARAMS.maxPathsPerPair,
            candidates: resolver.candidates
        },
        observers: observersOut,
        sources: Array.from(sources.values()),
        excluded_sources: excludedOut,
        matrix: matrix,
        hist: hist,
        pairs: pairsOut,
        nodes_ref: nodesRefOut,
        repeaters: repeaters,
        repeaters_truncated: repeatersTruncated,
        limits: {
            available: ctx.caps.byKey.size > 0,
            // per osservatore (D65): righe di repeater_config (database + storia del job),
            // repeater distinti, repeater con impostazioni nel periodo, primo/ultimo istante;
            // rows = null: tabella assente (no data); 0 = nodo senza repeater gestiti
            observers: limitsObservers(observers, lim.list),
            params: { carry_secs: PARAMS.capCarrySecs },
            // repeater con impostazioni valide in qualche punto del periodo e, degli altri,
            // quanti hanno letture solo prima o solo dopo (D64)
            in_period: lim.inPeriod,
            outside: lim.outside,
            repeaters: lim.list,
            changed_in_window: lim.changed,
            gateways: gatewaysOut
        },
        coverage: coverage,
        sufficiency: {
            sonar_deep_copies: sonarDeepCopies,
            sonar_deep_transmissions: sonarDeepTx.size,
            sonar_deep_sources: sonarDeepSources.size,
            needed_transmissions: needed.transmissions,
            needed_sources: needed.sources,
            classification_available: false
        },
        sonar_span: sonarSpan,
        notes: notes
    };
}

module.exports = {
    SCHEMA_VERSION,
    ENGINE_VERSION,
    PARAMS,
    isUsableCoordinate,
    parsePath,
    naturalKey,
    mergeRows,
    mergeCaps,
    mergeNodes,
    buildCapModel,
    capAt,
    effectiveCap,
    createContext,
    listWindows,
    analyzeWindow
};
