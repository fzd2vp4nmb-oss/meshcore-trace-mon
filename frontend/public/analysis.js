"use strict";

/* ==========================================
   analysis.js — scheda «Analysis» (docs/ARCHITECTURE.md §88)

   La scheda è un CONTENITORE di analisi: oggi una sola, «propagation»
   (path degli advert contro path dei messaggi Sonar), registrata in
   ANALYSIS_REGISTRY. I dati non si calcolano qui né nel server: li produce
   analysis_job.js (cron, ogni due ore) e li serve /api/analysis/* in sola
   lettura (analysis_api.js). Questo file li legge e li disegna.

   File NUOVO, caricato dopo app.js: app.js non è modificato. Riusa per nome
   (dichiarazioni di primo livello, §84/§85) createOsmTileLayer(),
   offsetSegmentPixels(), bearingDegrees(), addTraceArrowMarker(), le icone
   TRACE_*_ICON, isUsableMapCoordinate(), escapeHtml(), formatUnixTime(),
   safeLocalStorageGet/Set(), stopAutoRefresh() e le costanti delle frecce.
   Chi modifica una di queste funzioni in app.js deve controllare anche
   questo file (elenco dei chiamanti nel §88).

   Regole di progetto rispettate qui:
     - ogni nome o stringa che arriva dai dati passa da escapeHtml() (§34),
       sia nel testo sia negli attributi;
     - ogni fetch asincrona ha un requestId: una risposta in ritardo che trova
       il token cambiato viene scartata (come nodesTabRequestId, §65);
     - nessun auto-refresh: i dati sono precalcolati ogni due ore, la scheda
       mostra l'orario di calcolo e avverte se sono vecchi o se l'ultimo giro
       del job è fallito; aprendo la scheda si ferma il timer condiviso
       (stopAutoRefresh) lasciato da Trace/Nodes/Repeaters;
     - «nessun dato» non è zero: una tabella assente (nodo non aggiornato) o
       un periodo senza Sonar si mostrano come «no data»;
     - linguaggio non accusatorio (D8): «proven forwarded at ≥ 9 hops»,
       «indication», mai «colpevole»; nessuna classe di limite (D24);
     - i tre tetti flood (pannello 6 e note nei pannelli 3, 4, 5, §89) sono
       noti SOLO per i repeater gestiti da trace-mon (repeater_config): ogni
       altro hop resta «tetto non noto». La regola del tetto effettivo è
       un'ipotesi di lavoro (SPEC §2.3). «would stop / not stopped» è un
       fatto sul path (l'altro tipo di pacchetto lo avrebbe seguito?), mai
       una classe del repeater (D24). JSON calcolati prima del §89 non hanno
       `limits`: il pannello 6 lo dice invece di mostrare tabelle vuote.
     - l'ELENCO dei repeater gestiti è VARIABILE (§90): ogni gestore di
       trace-mon può aggiungerne o toglierne, un nodo può partire senza e
       averne più tardi. La tabella del pannello 6 è riferita al PERIODO
       mostrato: impostazioni in vigore alla sua fine (non quelle di oggi),
       solo i repeater che ne hanno nel periodo, badge «added in this
       period» / «no longer read», una nota per quelli fuori periodo e una
       tabella delle fonti per nodo. Un JSON senza `period` (motore 1.1.0)
       si mostra come prima.

   Le funzioni «pure» (nessun DOM, nessuna fetch: modelli e stringhe HTML) sono
   separate dal disegno per poterle provare da sole
   (sandbox_tests/test_analysis_frontend_2026_10_21.js).
========================================== */

const ANALYSIS_API_BASE = "/api/analysis";

// oltre questa età i dati sono «vecchi»: il job gira ogni due ore
const ANALYSIS_STALE_SECS = 6 * 3600;

// colori: advert blu (come le frecce del path advert, §84), sonar arancio
const ANALYSIS_ADVERT_COLOR = "#1e6fd9";
const ANALYSIS_SONAR_COLOR = "#d9480f";

// posizione «profonda» predefinita; il valore vero arriva da data.params.deep
const ANALYSIS_DEFAULT_DEEP = 9;

const ANALYSIS_MAX_MAP_PATHS = 12;

const ANALYSIS_STATUS_RANK = { proven: 0, indication: 1, messages_only: 2 };

const ANALYSIS_STATUS_TEXT = {
    proven: tl("an.optProven"),
    indication: tl("an.optIndication"),
    messages_only: tl("an.optSonarOnly")
};

const ANALYSIS_STATUS_TIP = {
    proven: tl("an.tipProven"),
    indication: tl("an.tipIndication"),
    messages_only: tl("an.tipSonarOnly")
};

const ANALYSIS_REGISTRY = {
    propagation: {
        label: tl("an.regPropagation"),
        panelId: "analysisPropagation",
        render: renderAnalysisPropagation
    }
};

/* =========================
   STATO
========================= */

let analysisCurrent = "propagation";
let analysisIndex = null;           // risposta di /windows
let analysisWindowId = null;
let analysisData = null;            // JSON della finestra mostrata
let analysisRequestId = 0;
let analysisHistChart = null;
let analysisPairModel = null;
let analysisPairSelected = new Set();   // id dei path disegnati sulla mappa
let analysisPairSource = null;
let analysisPairObserver = null;
let analysisPairMap = null;
let analysisPairMarkerGroup = null;
let analysisPairSegmentGroup = null;
let analysisPairInfoControl = null;
let analysisPairSegmentDefs = [];
let analysisMapDirty = false;

/* =========================
   FUNZIONI PURE: formati
========================= */

function analysisFiniteNumber(v) {

    return typeof v === "number" && Number.isFinite(v);
}

// Etichetta di una finestra di analisi ({id, label, kind}, v. analysis_engine.js):
// il motore manda la label in inglese ("All history", "Live (current database)",
// "October 2026"), ma la finestra è identificata solo dall'id, quindi
// l'etichetta si ricostruisce qui nella lingua scelta (v. i18n.js). Se l'id
// non ha una forma nota si usa la label del motore così com'è.
function analysisWindowLabel(win) {

    if (!win) {
        return "";
    }

    if (win.id === "all") {
        return tl("an.winAll");
    }

    if (win.id === "live") {
        return tl("an.winLive");
    }

    const m = /^(\d{4})-(\d{2})$/.exec(String(win.id));
    const months = tl("common.monthNames").split(",");
    const month = m ? parseInt(m[2], 10) : 0;

    if (m && month >= 1 && month <= 12 && months.length === 12) {
        return `${months[month - 1]} ${m[1]}`;
    }

    return win.label || win.id || "";
}

function analysisNoData() {

    return `<span class="analysisNoData">${tle("an.noData")}</span>`;
}

// numero intero o «no data» (null/undefined = tabella assente, non zero)
function analysisCountHtml(v) {

    return analysisFiniteNumber(v) ? escapeHtml(String(v)) : analysisNoData();
}

// «1 copy» / «5 copies»: numero + parola al singolare o al plurale (testo semplice, da escapare dal chiamante se serve)
function analysisPlural(n, one, many) {

    return `${n} ${n === 1 ? one : many}`;
}

function analysisFormatTime(t) {

    if (!analysisFiniteNumber(t) || t <= 0) {
        return "—";
    }

    if (typeof formatUnixTime === "function") {
        return formatUnixTime(t);
    }

    return new Date(t * 1000).toISOString();
}

function analysisFormatSpan(first, last) {

    if (!analysisFiniteNumber(first) || !analysisFiniteNumber(last)) {
        return "—";
    }

    return `${analysisFormatTime(first)} → ${analysisFormatTime(last)}`;
}

function analysisFormatDuration(secs) {

    if (!analysisFiniteNumber(secs) || secs < 0) {
        return "—";
    }

    if (secs < 90) {
        return `${Math.round(secs)} s`;
    }

    if (secs < 90 * 60) {
        return `${Math.round(secs / 60)} min`;
    }

    if (secs < 48 * 3600) {
        return `${Math.round(secs / 3600)} h`;
    }

    return tl("an.nDays", { n: Math.round(secs / 86400) });
}

// min / mediana / max degli hop di una cella della matrice
function analysisHopsText(h) {

    if (!h || !analysisFiniteNumber(h.min)) {
        return "—";
    }

    return `${h.min} / ${h.median} / ${h.max}`;
}

function analysisObserverLabel(o) {

    if (!o) {
        return "?";
    }

    if (o.id === "local" && (!o.label || o.label === "local")) {
        return tl("an.thisNode");
    }

    return o.label || o.id;
}

function analysisSourceLabel(s) {

    if (!s) {
        return "?";
    }

    return s.label || s.prefix;
}

function analysisDeep(data) {

    return data && data.params && analysisFiniteNumber(data.params.deep)
        ? data.params.deep
        : ANALYSIS_DEFAULT_DEEP;
}

function analysisFindObserver(data, id) {

    return (Array.isArray(data.observers) ? data.observers : []).find(o => o && o.id === id) || null;
}

function analysisFindSource(data, prefix) {

    return (data.sources || []).find(s => s.prefix === prefix) || null;
}

function analysisNodeRef(data, key) {

    if (!key || !data || !data.nodes_ref) {
        return null;
    }

    return data.nodes_ref[key] || null;
}

/* =========================
   FUNZIONI PURE: stato di aggiornamento
========================= */

// {state: "ok"|"stale"|"failed"|"empty", ageSecs, ...}: orario del SERVER
// (server_time) quando c'è, così un orologio sbagliato del browser non
// produce falsi «dati vecchi».
function analysisFreshness(index, nowSecs) {

    const result = {
        state: "ok",
        ageSecs: null,
        generatedAt: null,
        failed: false,
        failedAt: null,
        error: null
    };

    if (!index || typeof index !== "object") {
        result.state = "empty";
        return result;
    }

    const now = analysisFiniteNumber(index.server_time)
        ? index.server_time
        : (analysisFiniteNumber(nowSecs) ? nowSecs : Math.floor(Date.now() / 1000));

    result.generatedAt = analysisFiniteNumber(index.generated_at) ? index.generated_at : null;

    if (result.generatedAt === null) {
        result.state = "empty";
    } else {
        result.ageSecs = Math.max(0, now - result.generatedAt);

        if (result.ageSecs > ANALYSIS_STALE_SECS) {
            result.state = "stale";
        }
    }

    if (index.job && index.job.ok === false) {
        result.failed = true;
        result.failedAt = analysisFiniteNumber(index.job.failed_at) ? index.job.failed_at : null;
        result.error = typeof index.job.error === "string" ? index.job.error : null;

        if (result.state === "ok" || result.state === "stale") {
            result.state = "failed";
        }
    }

    return result;
}

// HTML degli avvisi in cima alla scheda (vuoto se tutto è in ordine)
function analysisNoticeHtml(index, fresh) {

    const parts = [];

    if (fresh.state === "empty" && fresh.failed) {

        parts.push(
            tlh("an.noticeFailedNoResult", { error: fresh.error ? ` (${fresh.error})` : "" })
        );

    } else if (fresh.state === "empty") {

        parts.push(tle("an.noticeNoData"));

    } else {

        if (fresh.failed) {
            parts.push(
                tlh("an.noticeLastRunFailed", {
                    at: fresh.failedAt ? ` (${analysisFormatTime(fresh.failedAt)})` : "",
                    error: fresh.error ? `: ${fresh.error}` : "",
                    time: analysisFormatTime(fresh.generatedAt)
                })
            );
        }

        if (fresh.ageSecs !== null && fresh.ageSecs > ANALYSIS_STALE_SECS) {
            parts.push(
                tlh("an.noticeStale", { age: analysisFormatDuration(fresh.ageSecs) })
            );
        }
    }

    return parts.map(p => `<div class="analysisWarning">${p}</div>`).join("");
}

/* =========================
   FUNZIONI PURE: pannello 1, stato dei dati
========================= */

function analysisNoteText(note, data) {

    const obsLabel = id => analysisObserverLabel(analysisFindObserver(data, id) || { id: id });

    switch (note && note.code) {

        case "observer_missing_tables":
            return tl("an.noteMissingTables", { tracer: obsLabel(note.observer), tables: (note.tables || []).join(", ") });

        case "observer_error":
            return tl("an.noteTracerError", { tracer: obsLabel(note.observer), message: note.message || tl("an.unknownError") });

        case "no_participant_filter":
            return tl("an.noteNoParticipantFilter");

        case "prefix_conflict":
            return tl("an.notePrefixConflict", { prefix: note.prefix, tracers: (note.observers || []).map(obsLabel).join(", ") });

        case "source_key_ambiguous":
            return tl("an.noteSourceAmbiguous", { prefix: note.prefix });

        case "source_key_unknown":
            return tl("an.noteSourceUnknown", { prefix: note.prefix });

        default:
            return tl("an.noteGeneric", { code: note && note.code ? note.code : "?" });
    }
}

// riquadro a scorrimento orizzontale per le tabelle dati del pannello 1, come
// le tabelle degli altri pannelli: sugli schermi stretti (390 px) la tabella
// dei tracciatori (8 colonne) e quella delle sorgenti Sonar (7) allargavano
// l'intera pagina fino a 740 px (§95)
function analysisStatusScrollBox(tableHtml) {

    return `<div class="analysisScroll analysisScrollStatus">${tableHtml}</div>`;
}

function analysisStatusHtml(data, index) {

    const h = [];
    const win = data.window || {};
    const deep = analysisDeep(data);

    // --- finestra e periodo comune
    const modeText = data.mode === "collector"
        ? tl("an.modeCollector")
        : tl("an.modeNode");

    const sonarSpan = data.sonar_span && analysisFiniteNumber(data.sonar_span.first_t)
        ? analysisFormatSpan(data.sonar_span.first_t, data.sonar_span.last_t)
        : tl("an.noSonarInWindow");

    const common = analysisFiniteNumber(win.common_from)
        ? tl("an.commonFrom", { time: analysisFormatTime(win.common_from) })
        : tl("an.commonWhole");

    h.push(
        '<table class="analysisKv">' +
        `<tr><th>${tle("an.kvWindow")}</th><td>${escapeHtml(analysisWindowLabel(win))}</td></tr>` +
        `<tr><th>${tle("an.kvDataSpan")}</th><td>${escapeHtml(analysisFormatSpan(win.first_t, win.last_t))}</td></tr>` +
        `<tr><th>${tle("an.kvSonarSpan")}</th><td>${escapeHtml(sonarSpan)}</td></tr>` +
        `<tr><th>${tle("an.kvComparison")}</th><td>${escapeHtml(common)}</td></tr>` +
        `<tr><th>${tle("an.kvScope")}</th><td>${escapeHtml(modeText)}</td></tr>` +
        `<tr><th>${tle("an.kvDeep")}</th><td>${escapeHtml(tl("an.orBeyond", { n: String(deep) }))}</td></tr>` +
        "</table>"
    );

    // --- osservatori
    h.push(`<h5>${tle("an.hTracers")}</h5>`);

    const obsRows = (data.observers || []).map(o => {

        const c = o.counts || {};
        const hasPos = isUsableMapCoordinate(o.lat, o.lon);
        const cls = o.error ? ' class="analysisRowError"' : "";

        const sonarRx = analysisFiniteNumber(c.sonar_rx_messages)
            ? `${escapeHtml(String(c.sonar_rx_messages))} <span class="analysisMuted">(${escapeHtml(analysisPlural(c.sonar_rx_copies, tl("an.wCopy"), tl("an.wCopies")))})</span>`
            : analysisNoData();

        const missing = o.tables
            ? Object.keys(o.tables).filter(t => !o.tables[t])
            : [];

        // Posizione e Stato come badge, negli stessi colori dei verdetti del
        // pannello 5: verde = a posto, ambra = incompleto (tabelle mancanti),
        // rosso = errore o posizione assente (§93)
        const state = o.error
            ? `<span class="analysisBadge analysisBadgeStop analysisBadgeWrap">${escapeHtml(o.error)}</span>`
            : (missing.length > 0
                ? `<span class="analysisBadge analysisBadgeMaybe analysisBadgeWrap">${tle("an.missing")} ${escapeHtml(missing.join(", "))}</span>`
                : `<span class="analysisBadge analysisBadgeOpen">${tle("an.stateOk")}</span>`);

        const position = hasPos
            ? `<span class="analysisBadge analysisBadgeOpen">${tle("an.yes")}</span>`
            : `<span class="analysisBadge analysisBadgeStop">${tle("an.no")}</span>`;

        return `<tr${cls}>` +
            `<td>${escapeHtml(analysisObserverLabel(o))}</td>` +
            `<td>${position}</td>` +
            `<td>${analysisCountHtml(c.adverts)}</td>` +
            `<td>${escapeHtml(analysisFormatSpan(c.advert_first_t, c.advert_last_t))}</td>` +
            `<td>${sonarRx}</td>` +
            `<td>${analysisCountHtml(c.sonar_tx)}</td>` +
            `<td>${analysisCountHtml(c.advert_tx)}</td>` +
            `<td>${state}</td>` +
            "</tr>";
    });

    h.push(analysisStatusScrollBox(
        '<table class="analysisTable">' +
        `<tr><th>${tle("an.thTracer")}</th><th>${tle("an.thPosition")}</th><th>${tle("an.thAdvertsReceived")}</th><th>${tle("an.thAdvertsSpan")}</th>` +
        `<th>${tle("an.thSonarReceived")}</th><th>${tle("an.thSonarSent")}</th><th>${tle("an.thAdvertsSent")}</th><th>${tle("an.thState")}</th></tr>` +
        (obsRows.length > 0 ? obsRows.join("") : `<tr><td colspan="8">${tle("an.noTracer")}</td></tr>`) +
        "</table>"
    ));

    // --- sorgenti
    h.push(`<h5>${tle("an.hSonarSources")}</h5>`);

    const srcRows = (data.sources || []).map(s => {

        const tx = s.tx || {};
        const owner = s.observer_id ? analysisFindObserver(data, s.observer_id) : null;

        return "<tr>" +
            `<td>${escapeHtml(analysisSourceLabel(s))}</td>` +
            `<td><code>${escapeHtml(s.prefix)}</code></td>` +
            `<td>${owner ? escapeHtml(analysisObserverLabel(owner)) : `<span class="analysisMuted">${tle("an.notKnownNode")}</span>`}</td>` +
            `<td>${escapeHtml(String(tx.sent || 0))}` +
            (tx.unknown ? ` <span class="analysisMuted">${tlh("an.txUncertain", { n: String(tx.unknown) })}</span>` : "") +
            (tx.failed ? ` <span class="analysisMuted">${tlh("an.txFailed", { n: String(tx.failed) })}</span>` : "") + "</td>" +
            `<td>${analysisCountHtml(s.advert_tx_logged)}</td>` +
            `<td>${escapeHtml(String(s.advert_seen_any || 0))}</td>` +
            `<td>${escapeHtml(analysisFormatTime(s.last_advert_t))}</td>` +
            "</tr>";
    });

    h.push(analysisStatusScrollBox(
        '<table class="analysisTable">' +
        `<tr><th>${tle("an.thSource")}</th><th>${tle("an.thPrefix")}</th><th>${tle("an.thNode")}</th><th>${tle("an.thSonarSent")}</th>` +
        `<th>${tle("an.thAdvertsSent")}</th><th>${tle("an.thAdvertsSeen")}</th><th>${tle("an.thLastAdvert")}</th></tr>` +
        (srcRows.length > 0 ? srcRows.join("") : `<tr><td colspan="7">${tle("an.noSonarSource")}</td></tr>`) +
        "</table>"
    ));

    // --- sorgenti escluse
    const excluded = data.excluded_sources || [];

    if (excluded.length > 0) {

        h.push(`<h5>${tle("an.hExcluded")}</h5>`);
        h.push(
            `<p class="analysisHelp">${tle("an.helpExcluded")}</p>`
        );

        const exRows = excluded.map(e => {

            const names = (e.observers || []).map(id => analysisObserverLabel(analysisFindObserver(data, id) || { id: id }));

            return "<tr>" +
                `<td>${escapeHtml(e.name || tl("an.unknown"))}</td>` +
                `<td><code>${escapeHtml(e.prefix)}</code></td>` +
                `<td>${escapeHtml(String(e.messages))}</td>` +
                `<td>${escapeHtml(String(e.copies))}</td>` +
                `<td>${escapeHtml(names.join(", "))}</td>` +
                "</tr>";
        });

        h.push(analysisStatusScrollBox(
            '<table class="analysisTable">' +
            `<tr><th>${tle("an.thName")}</th><th>${tle("an.thPrefix")}</th><th>${tle("an.thMessages")}</th><th>${tle("an.thCopies")}</th><th>${tle("an.thHeardBy")}</th></tr>` +
            exRows.join("") + "</table>"
        ));
    }

    // --- sufficienza delle prove profonde
    const suf = data.sufficiency || {};

    h.push(`<h5>${tle("an.hDeepEvidence")}</h5>`);
    h.push(
        '<p class="analysisHelp">' +
        tlh("an.deepEvidence", {
            copies: analysisPlural(suf.sonar_deep_copies || 0, tl("an.wCopy"), tl("an.wCopies")),
            hops: String(analysisDeep(data) + 1),
            transmissions: analysisPlural(suf.sonar_deep_transmissions || 0, tl("an.wTransmission"), tl("an.wTransmissions")),
            sources: analysisPlural(suf.sonar_deep_sources || 0, tl("an.wSource"), tl("an.wSources")),
            needTx: String(suf.needed_transmissions || 20),
            needSrc: String(suf.needed_sources || 3),
            verdict: suf.classification_available ? tl("an.enoughData") : tl("an.notEnoughData")
        }) +
        "</p>"
    );

    // --- risoluzione dei nomi
    const cov = data.coverage || {};
    const covRow = (label, c) => c
        ? "<tr>" +
            `<td>${escapeHtml(label)}</td><td>${escapeHtml(String(c.hops))}</td><td>${escapeHtml(String(c.resolved))}</td>` +
            `<td>${escapeHtml(String(c.ambiguous))}</td><td>${escapeHtml(String(c.unknown))}</td></tr>`
        : "";

    h.push(`<h5>${tle("an.hNameResolution")}</h5>`);
    h.push(
        `<p class="analysisHelp">${tle("an.helpNameResolution")}</p>`
    );
    h.push(analysisStatusScrollBox(
        '<table class="analysisTable">' +
        `<tr><th>${tle("an.thHopsCounted")}</th><th>${tle("an.thTotal")}</th><th>${tle("an.thResolved")}</th><th>${tle("an.thAmbiguousPrefix")}</th><th>${tle("an.thNoKnownRepeater")}</th></tr>` +
        covRow(tl("an.covAdverts"), cov.adverts) +
        covRow(tl("an.covSonar"), cov.sonar) +
        covRow(tl("an.covDeepAdverts"), cov.deep_adverts) +
        covRow(tl("an.covDeepSonar"), cov.deep_sonar) +
        "</table>"
    ));

    // --- note e avvisi del job
    const notes = (data.notes || []).map(n => `<li>${escapeHtml(analysisNoteText(n, data))}</li>`);
    const warnings = ((index && index.job && index.job.warnings) || []).map(w => `<li>${tlh("an.jobWarning", { warning: w })}</li>`);

    if (notes.length + warnings.length > 0) {
        h.push(`<h5>${tle("an.hNotes")}</h5>`);
        h.push(`<ul class="analysisNotes">${notes.concat(warnings).join("")}</ul>`);
    }

    return h.join("");
}

// riga di riepilogo in cima: orario di calcolo, esito, durata
function analysisInfoHtml(index, data, fresh) {

    if (!index || fresh.state === "empty") {
        return "";
    }

    const job = index.job || {};
    const parts = [
        fresh.ageSecs !== null
            ? tlh("an.infoComputedAgo", { time: analysisFormatTime(fresh.generatedAt), age: analysisFormatDuration(fresh.ageSecs) })
            : tlh("an.infoComputed", { time: analysisFormatTime(fresh.generatedAt) })
    ];

    parts.push(job.ok === false ? tle("an.lastRunFailed") : tle("an.lastRunOk"));

    if (analysisFiniteNumber(job.duration_ms)) {
        parts.push(tlh("an.infoTook", { s: (job.duration_ms / 1000).toFixed(1) }));
    }

    if (job.engine) {
        parts.push(tlh("an.infoEngine", { engine: job.engine }));
    }

    parts.push(tle("an.infoInference"));

    return parts.join(" · ");
}

/* =========================
   FUNZIONI PURE: pannello 2, matrice
========================= */

function analysisMatrixCellHtml(cell, source, observer) {

    const sent = source && source.tx ? (source.tx.sent || 0) + (source.tx.unknown || 0) : 0;
    const s = cell.sonar;
    const a = cell.advert;
    const lines = [];

    if (s === null || s === undefined) {

        lines.push(`<div class="amLine"><span class="amTag amSonar">Sonar</span> ${analysisNoData()}</div>`);

    } else if (s.received === 0) {

        lines.push(
            `<div class="amLine"><span class="amTag amSonar">Sonar</span> ${tle("an.noneReceived")}` +
            (sent > 0 ? ` <span class="analysisMuted">${tlnh("an.ofSent", sent)}</span>` : "") + "</div>"
        );

    } else {

        lines.push(
            `<div class="amLine"><span class="amTag amSonar">Sonar</span> <b>${escapeHtml(String(s.received))}</b>` +
            (sent > 0 ? ` ${tlnh("an.ofSent", sent)}` : ` ${tlne("an.messagesWord", s.received)}`) +
            ` <span class="analysisMuted">· ${escapeHtml(analysisPlural(s.copies, tl("an.wCopy"), tl("an.wCopies")))}</span></div>`
        );
        lines.push(
            `<div class="amSub">${tlh("an.hopsText", { text: analysisHopsText(s.hops) })}` +
            (s.deep_copies ? ` · <b>${tlnh("an.nDeep", s.deep_copies)}</b>` : "") + "</div>"
        );
    }

    if (a === null || a === undefined) {

        lines.push(`<div class="amLine"><span class="amTag amAdvert">Advert</span> ${analysisNoData()}</div>`);

    } else if (a.received === 0) {

        lines.push(`<div class="amLine"><span class="amTag amAdvert">Advert</span> ${tle("an.noneSeen")}</div>`);

    } else {

        lines.push(
            `<div class="amLine"><span class="amTag amAdvert">Advert</span> <b>${escapeHtml(String(a.received))}</b> ${tlne("an.seenWord", a.received)}` +
            ` <span class="analysisMuted">· ${escapeHtml(analysisPlural(a.copies, tl("an.wCopy"), tl("an.wCopies")))}</span></div>`
        );
        lines.push(
            `<div class="amSub">${tlh("an.hopsText", { text: analysisHopsText(a.hops) })}` +
            (a.deep_copies ? ` · <b>${tlnh("an.nDeep", a.deep_copies)}</b>` : "") + "</div>"
        );
    }

    return lines.join("");
}

function analysisMatrixHtml(data) {

    const observers = data.observers || [];
    const sources = data.sources || [];

    if (sources.length === 0 || observers.length === 0) {
        return `<p class="analysisHelp">${tle("an.matrixEmpty")}</p>`;
    }

    const cells = new Map();

    for (const c of (data.matrix || [])) {
        cells.set(`${c.source}|${c.observer}`, c);
    }

    const head = observers.map(o => `<th>${escapeHtml(analysisObserverLabel(o))}</th>`).join("");

    const rows = sources.map(s => {

        const tds = observers.map(o => {

            if (s.observer_id === o.id) {
                return `<td class="analysisSelfCell" data-tooltip="${tle("an.selfCellTip")}">—</td>`;
            }

            const cell = cells.get(`${s.prefix}|${o.id}`);

            if (!cell) {
                return `<td>${analysisNoData()}</td>`;
            }

            const selected = analysisPairSource === s.prefix && analysisPairObserver === o.id ? " selected" : "";

            return `<td class="analysisMatrixCell${selected}" data-source="${escapeHtml(s.prefix)}" data-observer="${escapeHtml(o.id)}">` +
                analysisMatrixCellHtml(cell, s, o) + "</td>";
        }).join("");

        const adv = s.advert_tx_logged === null || s.advert_tx_logged === undefined ? "" :
            `<div class="amSub">${tlnh("an.advertsLogged", s.advert_tx_logged)}</div>`;

        return `<tr><th class="analysisRowHead">${escapeHtml(analysisSourceLabel(s))}` +
            `<div class="amSub"><code>${escapeHtml(s.prefix)}</code></div>` +
            `<div class="amSub">${tlnh("an.sonarSentN", (s.tx && s.tx.sent) || 0)}</div>${adv}</th>${tds}</tr>`;
    });

    // riquadro a scorrimento orizzontale: con molti tracciatori la matrice
    // (una colonna da 190 px per tracciatore) scorre nel riquadro invece di
    // allargare l'intera pagina (§93); la prima colonna (sorgente) resta
    // ferma a sinistra durante lo scorrimento (CSS, §95)
    return '<div class="analysisScroll analysisScrollMatrix">' +
        '<table class="analysisTable analysisMatrix">' +
        `<tr><th>${tle("an.matrixCorner")}</th>${head}</tr>${rows.join("")}</table></div>`;
}

/* =========================
   FUNZIONI PURE: pannello 3, istogramma
========================= */

// scope: "both" | "FLOOD" | "TC"; metric: "copies" | "best"; ymode: "share" | "count"
function analysisHistogramModel(data, observerId, scope, metric, ymode) {

    const hist = data.hist || {};
    const src = observerId === "all" ? hist.all : (hist.by_observer || {})[observerId];
    const bins = data.params && analysisFiniteNumber(data.params.hist_bins) ? data.params.hist_bins : 25;
    const scopes = scope === "FLOOD" ? ["FLOOD"] : (scope === "TC" ? ["TC"] : ["FLOOD", "TC"]);
    const key = metric === "best" ? "best" : "copies";

    const labels = [];

    for (let i = 0; i < bins; i++) {
        labels.push(i === bins - 1 ? `${i}+` : String(i));
    }

    const series = {};

    for (const kind of ["advert", "sonar"]) {

        const counts = new Array(bins).fill(0);
        let totalCopies = 0;
        let totalTx = 0;

        for (const sc of scopes) {

            const h = src && src[kind] && src[kind][sc];

            if (!h) {
                continue;
            }

            for (let i = 0; i < bins; i++) {
                counts[i] += analysisFiniteNumber(h[key] && h[key][i]) ? h[key][i] : 0;
            }

            totalCopies += analysisFiniteNumber(h.total_copies) ? h.total_copies : 0;
            totalTx += analysisFiniteNumber(h.total_transmissions) ? h.total_transmissions : 0;
        }

        const total = counts.reduce((x, y) => x + y, 0);

        series[kind] = {
            counts: counts,
            share: counts.map(c => (total > 0 ? (c * 100) / total : 0)),
            total: total,
            copies: totalCopies,
            transmissions: totalTx,
            values: ymode === "count" ? counts : counts.map(c => (total > 0 ? (c * 100) / total : 0))
        };
    }

    return {
        labels: labels,
        advert: series.advert,
        sonar: series.sonar,
        empty: series.advert.total === 0 && series.sonar.total === 0,
        ymode: ymode === "count" ? "count" : "share"
    };
}

/* =========================
   FUNZIONI PURE: pannello 4, confronto di coppia
========================= */

function analysisPathSignature(row) {

    return (row.hops || []).map(h => h.h).join(">");
}

// coppia scelta di default: quella con più copie Sonar, poi più advert
function analysisDefaultPair(data) {

    let best = null;

    for (const c of (data.matrix || [])) {

        const score = ((c.sonar && c.sonar.copies) || 0) * 1_000_000 + ((c.advert && c.advert.copies) || 0);

        if (best === null || score > best.score) {
            best = { score: score, source: c.source, observer: c.observer };
        }
    }

    return best ? { source: best.source, observer: best.observer } : null;
}

// righe delle due tabelle: path distinti con segnalazione di quelli comuni
function analysisBuildPairModel(data, sourcePrefix, observerId) {

    const raw = (data.pairs || {})[`${sourcePrefix}|${observerId}`] || {};

    // ordine di visualizzazione (e degli id): più copie prima, a parità il più recente
    const byRecurrence = (a, b) => ((b.count || 0) - (a.count || 0)) || ((b.last_t || 0) - (a.last_t || 0));
    const advertRows = Array.isArray(raw.advert) ? raw.advert.slice().sort(byRecurrence) : [];
    const sonarRows = Array.isArray(raw.sonar) ? raw.sonar.slice().sort(byRecurrence) : [];
    const sigAdvert = new Set(advertRows.map(analysisPathSignature));
    const sigSonar = new Set(sonarRows.map(analysisPathSignature));

    const build = (kind, rows, otherSet) => rows.map((r, i) => Object.assign({}, r, {
        id: `${kind}:${i}`,
        kind: kind,
        signature: analysisPathSignature(r),
        inOther: otherSet.has(analysisPathSignature(r))
    }));

    const cell = (data.matrix || []).find(c => c.source === sourcePrefix && c.observer === observerId) || null;

    return {
        source: analysisFindSource(data, sourcePrefix),
        observer: analysisFindObserver(data, observerId),
        sourcePrefix: sourcePrefix,
        observerId: observerId,
        advert: build("advert", advertRows, sigSonar),
        sonar: build("sonar", sonarRows, sigAdvert),
        truncated: raw.truncated || { advert: 0, sonar: 0 },
        cell: cell
    };
}

// informazioni sui tetti di un hop di una riga di confronto: codice del verdetto
// (D57: b bloccato, u incerto, p passa, c visto a quella posizione, n nessuna
// evidenza), tetto del tipo del path e tetto dell'altro tipo
function analysisHopExtra(row, index) {

    if (!row || typeof row.hs !== "string" || !Array.isArray(row.hops) || row.hs.length !== row.hops.length) {
        return null;
    }

    return {
        code: row.hs.charAt(index),
        own: Array.isArray(row.co) ? row.co[index] : null,
        oth: Array.isArray(row.cx) ? row.cx[index] : null,
        kind: row.kind
    };
}

// tooltip dei tetti di un hop (testo non escapato: lo escapa il chiamante)
function analysisHopLimitTip(extra, position) {

    if (!extra) {
        return "";
    }

    const own = extra.kind === "sonar" ? tl("an.kindSonarMsg") : tl("an.kindAdvert");
    const other = extra.kind === "sonar" ? tl("an.kindAdvert") : tl("an.kindSonarMsg");
    const known = c => (Array.isArray(c) || analysisFiniteNumber(c));
    const parts = [];

    if (known(extra.own)) {
        parts.push(tl("an.capOf", { kind: own, cap: analysisCapText(extra.own) }));
    }

    if (known(extra.oth)) {
        parts.push(tl("an.capOf", { kind: other, cap: analysisCapText(extra.oth) }));
    }

    const verdict = {
        b: tl("an.verdictB", { other: other, position: position }),
        u: tl("an.verdictU", { other: other }),
        p: tl("an.verdictP", { other: other }),
        c: tl("an.verdictC", { other: other }),
        n: tl("an.verdictN", { other: other })
    }[extra.code];

    if (verdict) {
        parts.push(verdict);
    }

    return parts.join(" · ");
}

// testo di un hop con nome (escapato) o prefisso non risolto; extra (facoltativo):
// tetti e verdetto dell'altro tipo di pacchetto per questo hop (vedi analysisHopExtra)
function analysisHopHtml(hop, data, position, n, deep, extra) {

    const info = hop.k ? analysisNodeRef(data, hop.k) : null;
    const isDeepProof = position >= deep && position <= n - 1;
    const cls = ["analysisHop"];
    const code = extra && typeof extra.code === "string" ? extra.code : "";

    if (isDeepProof) {
        cls.push("analysisHopDeep");
    }

    if (code === "b") {
        cls.push("analysisHopStop");
    } else if (code === "u") {
        cls.push("analysisHopMaybe");
    }

    const limitTip = analysisHopLimitTip(extra, position);
    const sup = (code === "b" || code === "u") && extra.oth !== null && extra.oth !== undefined
        ? `<sup class="analysisHopCap">${escapeHtml(analysisCapText(extra.oth))}</sup>`
        : "";

    if (info && info.n) {

        const tip = tl("an.hopTipNamed", { position: position, prefix: hop.h, key: hop.k.slice(0, 12) }) + (limitTip ? ` · ${limitTip}` : "");

        return `<span class="${cls.join(" ")}" data-tooltip="${escapeHtml(tip)}">${escapeHtml(info.n)}${sup}</span>`;
    }

    cls.push("analysisHopUnknown");

    const why = hop.c > 1
        ? tl("an.hopShared", { n: hop.c, prefix: hop.h })
        : (hop.k ? tl("an.hopNoName", { prefix: hop.h }) : tl("an.hopNoRepeaterTip", { prefix: hop.h }));

    return `<span class="${cls.join(" ")}" data-tooltip="${escapeHtml(tl("an.hopTipUnknown", { position: position, why: why }))}">?${escapeHtml(hop.h)}</span>`;
}

function analysisPathHtml(row, model, data) {

    const deep = analysisDeep(data);
    const n = (row.hops || []).length;
    const src = escapeHtml(analysisSourceLabel(model.source) === "?" ? model.sourcePrefix : analysisSourceLabel(model.source));
    const obs = escapeHtml(analysisObserverLabel(model.observer));
    const hops = (row.hops || []).map((h, i) => analysisHopHtml(h, data, i + 1, n, deep, analysisHopExtra(row, i)));

    return [`<span class="analysisEnd">${src}</span>`].concat(hops, [`<span class="analysisEnd">${obs}</span>`]).join(" → ");
}

function analysisPairRowsHtml(rows, model, data, selected, otherName) {

    if (rows.length === 0) {
        return `<tr><td colspan="8">${tle("an.noPathForPair")}</td></tr>`;
    }

    return rows.map(r => {

        const checked = selected.has(r.id) ? " checked" : "";
        const scope = r.scope === "TC" ? tl("an.scopeRegionFlood") : tl("an.scopeNoRegionFlood");

        return `<tr class="${selected.has(r.id) ? "analysisPairSelectedRow" : ""}">` +
            `<td><input type="checkbox" class="analysisPairToggle" data-path="${escapeHtml(r.id)}"${checked} aria-label="${tle("an.showOnMap")}"></td>` +
            `<td>${escapeHtml(scope)}</td>` +
            `<td>${escapeHtml(String(r.n))}</td>` +
            `<td>${escapeHtml(String(r.count))}</td>` +
            `<td>${escapeHtml(String(r.transmissions))}</td>` +
            `<td>${escapeHtml(analysisFormatTime(r.first_t))}<br>${escapeHtml(analysisFormatTime(r.last_t))}</td>` +
            `<td class="analysisPathCell">${analysisPathHtml(r, model, data)}</td>` +
            `<td>${r.inOther ? `<span class="analysisBadge" data-tooltip="${escapeHtml(tl("an.alsoInTip", { name: otherName }))}">${tlh("an.alsoIn", { name: otherName })}</span>` : ""}${analysisCounterpartHtml(r, data)}</td>` +
            "</tr>";
    }).join("");
}

function analysisPairHeaderHtml() {

    return `<tr><th>${tle("an.pairThMap")}</th><th>${tle("an.thScope")}</th><th>${tle("an.thHops")}</th><th>${tle("an.thCopies")}</th><th>${tle("an.thTransmissions")}</th>` +
        `<th>${tle("an.thFirstLast")}</th><th>${tle("an.thPathSrcTracer")}</th><th>${tle("an.thComparison")}</th></tr>`;
}

function analysisPairSummaryHtml(model) {

    if (!model.cell) {
        return `<p class="analysisHelp">${tle("an.noDataForPair")}</p>`;
    }

    const parts = [];
    const s = model.cell.sonar;
    const a = model.cell.advert;

    parts.push(
        s === null
            ? `Sonar: ${analysisNoData()}`
            : escapeHtml(tl("an.pairSonar", { messages: analysisPlural(s.received, tl("an.wMessage"), tl("an.wMessages")), copies: analysisPlural(s.copies, tl("an.wCopy"), tl("an.wCopies")), hops: analysisHopsText(s.hops) }))
    );
    parts.push(
        a === null
            ? `Advert: ${analysisNoData()}`
            : escapeHtml(tln("an.pairAdvert", a.received, { seen: String(a.received), copies: analysisPlural(a.copies, tl("an.wCopy"), tl("an.wCopies")), hops: analysisHopsText(a.hops) }))
    );

    return `<p class="analysisPairSummary">${parts.join(" &nbsp;|&nbsp; ")} <span class="analysisMuted">${tle("an.hopsLegend")}</span></p>`;
}

/* =========================
   FUNZIONI PURE: mappa del path
========================= */

function analysisDescribeCoordinates(la, lo) {

    if (la === null || la === undefined || lo === null || lo === undefined) {
        return tl("an.coordUnknown");
    }

    if (la === 0 && lo === 0) {
        return tl("common.coordNoGps");
    }

    return tl("common.coordInvalid", { lat: la, lon: lo });
}

function analysisMakePoint(spec) {

    const usable = isUsableMapCoordinate(spec.lat, spec.lon);

    return {
        role: spec.role,
        step: spec.step,
        name: spec.name,
        key: spec.key || null,
        nodeType: spec.nodeType === undefined ? null : spec.nodeType,
        shown: usable,
        lat: usable ? spec.lat : null,
        lon: usable ? spec.lon : null,
        reason: usable ? null : { kind: spec.reasonKind || "missing", text: spec.reasonText || analysisDescribeCoordinates(spec.lat, spec.lon) }
    };
}

// punti del path nell'ordine sorgente → hop 1 … hop N → osservatore
function analysisBuildPathPoints(data, model, row) {

    const points = [];
    const srcObs = model.source && model.source.observer_id ? analysisFindObserver(data, model.source.observer_id) : null;
    const srcRef = model.source ? analysisNodeRef(data, model.source.key) : null;
    const srcPos = srcObs && isUsableMapCoordinate(srcObs.lat, srcObs.lon)
        ? { la: srcObs.lat, lo: srcObs.lon }
        : (srcRef ? { la: srcRef.la, lo: srcRef.lo } : { la: null, lo: null });

    points.push(analysisMakePoint({
        role: "origin",
        step: tl("an.stepSource"),
        name: model.source ? analysisSourceLabel(model.source) : model.sourcePrefix,
        key: model.source ? model.source.key : null,
        nodeType: srcRef ? srcRef.t : 1,
        lat: srcPos.la,
        lon: srcPos.lo
    }));

    (row.hops || []).forEach((hop, i) => {

        const info = hop.k ? analysisNodeRef(data, hop.k) : null;
        const step = `Hop ${i + 1}`;

        if (!hop.k) {

            points.push(analysisMakePoint({
                role: "hop",
                step: step,
                name: `?${hop.h}`,
                lat: null,
                lon: null,
                reasonKind: hop.c > 1 ? "duplicate" : "missing",
                reasonText: hop.c > 1
                    ? tl("an.reasonShared", { prefix: hop.h, n: hop.c })
                    : tl("an.reasonNoRepeater", { prefix: hop.h })
            }));

            return;
        }

        points.push(analysisMakePoint({
            role: "hop",
            step: step,
            name: info && info.n ? info.n : `?${hop.h}`,
            key: hop.k,
            lat: info ? info.la : null,
            lon: info ? info.lo : null
        }));
    });

    const obs = model.observer;

    points.push(analysisMakePoint({
        role: "src",
        step: tl("an.stepTracer"),
        name: analysisObserverLabel(obs),
        lat: obs ? obs.lat : null,
        lon: obs ? obs.lon : null
    }));

    return points;
}

// tratti fra punti MOSTRATI consecutivi; bridged = c'è almeno un punto omesso in mezzo (§84)
function analysisBuildSegments(points) {

    const shownIdx = [];

    points.forEach((p, i) => {
        if (p.shown) {
            shownIdx.push(i);
        }
    });

    const segments = [];

    for (let k = 1; k < shownIdx.length; k++) {

        const a = points[shownIdx[k - 1]];
        const b = points[shownIdx[k]];

        segments.push({ from: a, to: b, bridged: shownIdx[k] - shownIdx[k - 1] > 1 });
    }

    return segments;
}

/* =========================
   FUNZIONI PURE: pannello 5, repeater profondi
========================= */

function analysisRepeaterRows(data, statusFilter, textFilter) {

    const needle = (textFilter || "").trim().toLowerCase();
    const rows = [];

    for (const r of (data.repeaters || [])) {

        if (statusFilter && statusFilter !== "all" && r.status !== statusFilter) {
            continue;
        }

        const info = analysisNodeRef(data, r.key);
        const name = info && info.n ? info.n : null;

        if (needle) {

            const hay = `${name || ""} ${r.key}`.toLowerCase();

            if (!hay.includes(needle)) {
                continue;
            }
        }

        rows.push({ key: r.key, name: name, status: r.status, advert: r.advert, sonar: r.sonar, follow: r.follow, stop: r.stop });
    }

    rows.sort((a, b) => {

        const ra = ANALYSIS_STATUS_RANK[a.status] === undefined ? 9 : ANALYSIS_STATUS_RANK[a.status];
        const rb = ANALYSIS_STATUS_RANK[b.status] === undefined ? 9 : ANALYSIS_STATUS_RANK[b.status];

        if (ra !== rb) {
            return ra - rb;
        }

        const ta = (a.advert && a.advert.transmissions) || 0;
        const tb = (b.advert && b.advert.transmissions) || 0;

        if (ta !== tb) {
            return tb - ta;
        }

        const sa = (a.sonar && a.sonar.transmissions) || 0;
        const sb = (b.sonar && b.sonar.transmissions) || 0;

        if (sa !== sb) {
            return sb - sa;
        }

        return (a.name || a.key).localeCompare(b.name || b.key);
    });

    return rows;
}

function analysisRepeaterStatsCells(s) {

    if (!s) {
        return `<td colspan="5" class="analysisMuted">${tle("an.noneSeen")}</td>`;
    }

    return `<td>${escapeHtml(String(s.transmissions))}</td>` +
        `<td>${escapeHtml(String(s.sources))}</td>` +
        `<td>${escapeHtml(String(s.observers))}</td>` +
        `<td>${escapeHtml(String(s.max_position))}</td>` +
        `<td>${escapeHtml(analysisFormatTime(s.last_t))}</td>`;
}

function analysisRepeatersHtml(rows, data) {

    const ctx = data || {};

    const head =
        `<tr><th rowspan="2">Repeater</th><th rowspan="2">${tle("an.colStatus")}</th>` +
        `<th colspan="5">${tle("an.colSeenAdverts")}</th><th colspan="5">${tle("an.colSeenSonar")}</th>` +
        `<th rowspan="2" data-tooltip="${tle("an.tipCouldFollow")}">${tle("an.colCouldFollow")}</th>` +
        `<th rowspan="2" data-tooltip="${tle("an.tipAdvertCap")}">${tle("an.colAdvertCap")}</th></tr>` +
        `<tr><th>${tle("an.colTransm")}</th><th>${tle("an.colSources")}</th><th>${tle("an.colTracers")}</th><th>${tle("an.colDeepest")}</th><th>${tle("an.colLast")}</th>` +
        `<th>${tle("an.colTransm")}</th><th>${tle("an.colSources")}</th><th>${tle("an.colTracers")}</th><th>${tle("an.colDeepest")}</th><th>${tle("an.colLast")}</th></tr>`;

    if (rows.length === 0) {
        return `<thead>${head}</thead><tbody><tr><td colspan="14">${tle("an.noRepeaterMatches")}</td></tr></tbody>`;
    }

    const body = rows.map(r => {

        const label = r.name ? escapeHtml(r.name) : `<span class="analysisMuted">${tle("an.unnamed")}</span>`;
        const statusText = ANALYSIS_STATUS_TEXT[r.status] || r.status;
        const tip = ANALYSIS_STATUS_TIP[r.status] || "";

        return "<tr>" +
            `<td class="analysisRepName">${label}<div class="amSub"><code>${escapeHtml(String(r.key).slice(0, 8))}</code></div></td>` +
            `<td><span class="analysisStatus analysisStatus_${escapeHtml(r.status)}" data-tooltip="${escapeHtml(tip)}">${escapeHtml(statusText)}</span></td>` +
            analysisRepeaterStatsCells(r.advert) +
            analysisRepeaterStatsCells(r.sonar) +
            `<td>${analysisFollowHtml(r, ctx)}</td>` +
            `<td>${analysisRepeaterCapHtml(r, ctx)}</td>` +
            "</tr>";
    }).join("");

    return `<thead>${head}</thead><tbody>${body}</tbody>`;
}

/* =========================
   FUNZIONI PURE: limiti operativi (§89)

   Tre tetti flood (Flood Max Hops: Unscoped, Advert, e quello generale)
   NOTI solo per i repeater gestiti da trace-mon (repeater_config). La
   ricostruzione e i verdetti li calcola il motore: qui si formattano.
   La regola del tetto effettivo è un'ipotesi di lavoro (SPEC §2.3).
========================= */

const ANALYSIS_KIND_LABEL = { advert: tl("an.kindAdvert"), sonar: tl("an.kindSonarMsg") };
const ANALYSIS_SCOPE_LABEL = { FLOOD: tl("an.scopeNoRegion"), TC: tl("an.scopeRegion") };

// il job gira ogni 2 h e il motore dà un tetto per valido ancora 6 h
// dall'ultima lettura (data.limits.params.carry_secs)
const ANALYSIS_DEFAULT_CARRY_SECS = 6 * 3600;

// tetto: numero se certo, [lo, hi] se incerto (cambio tra due letture), altro = non noto
function analysisCapText(c) {

    if (Array.isArray(c) && c.length === 2 && analysisFiniteNumber(c[0]) && analysisFiniteNumber(c[1])) {
        return `${c[0]}–${c[1]}`;
    }

    return analysisFiniteNumber(c) ? String(c) : "?";
}

function analysisLimits(data) {

    return data && data.limits && typeof data.limits === "object" ? data.limits : null;
}

function analysisNodeName(data, key) {

    const info = key ? analysisNodeRef(data, key) : null;

    if (info && info.n) {
        return info.n;
    }

    return key ? `${String(key).slice(0, 8)}…` : "?";
}

/* ----- periodo e valori a fine periodo (§90, D63-D65) ----- */

// Elenco dei repeater VARIABILE: ogni gestore di trace-mon può aggiungerne o
// toglierne, un nodo può partire senza e averne più tardi. La tabella è
// quindi riferita al PERIODO mostrato: le impostazioni in vigore alla sua
// fine (non quelle di oggi), solo i repeater che ne hanno nel periodo, con
// badge per quelli aggiunti o non più letti; gli altri sono in una nota.

const ANALYSIS_PARAM_LABEL = { max: "Flood Max Hops", unscoped: "Unscoped", advert: "Advert" };

// quanti nomi mostrare nella nota dei repeater fuori periodo
const ANALYSIS_OUTSIDE_NAMES = 5;

// stato di un repeater rispetto al periodo (D64): «in» se ha impostazioni
// valide in qualche punto del periodo, «before»/«after» se le ha solo prima/dopo.
// JSON senza `period` (motore 1.1.0, o finestra senza righe): tutti «in».
function analysisPeriodOf(r) {

    const p = r && r.period;

    if (p && (p.state === "in" || p.state === "before" || p.state === "after")) {
        return { state: p.state, added: p.added === true, ended: p.ended === true, known: true };
    }

    return { state: "in", added: false, ended: false, known: false };
}

//
// Valore di un'impostazione o di un tetto alla FINE del periodo:
//   known  numero certo
//   range  incerto: il cambio è avvenuto in un punto sconosciuto tra due letture
//   last   non noto a fine periodo (nessuna lettura valida poco prima): si
//          mostra, attenuato, l'ultimo valore letto
//   none   non noto
// `end` è il valore a fine periodo (numero, [lo, hi] o null), `cur` l'ultimo
// letto. Senza periodo (`known` falso) `end` non esiste e vale `cur`.
//
function analysisPeriodCap(end, cur, periodKnown) {

    if (analysisFiniteNumber(end)) {
        return { kind: "known", value: end, min: end, text: String(end), reads: null };
    }

    if (Array.isArray(end) && end.length === 2 && analysisFiniteNumber(end[0]) && analysisFiniteNumber(end[1])) {
        return { kind: "range", value: null, min: Math.min(end[0], end[1]), text: `${end[0]}–${end[1]}`, reads: null };
    }

    if (analysisFiniteNumber(cur)) {
        return periodKnown
            ? { kind: "last", value: cur, min: null, text: String(cur), reads: null }
            : { kind: "known", value: cur, min: cur, text: String(cur), reads: null };
    }

    return { kind: "none", value: null, min: null, text: "?", reads: null };
}

// letture del segmento in vigore a t1 (ultimo con inizio <= t1), se ha quel valore
function analysisSegReads(segs, t1, value) {

    if (!Array.isArray(segs) || !analysisFiniteNumber(t1) || !analysisFiniteNumber(value)) {
        return null;
    }

    let cover = null;

    for (const s of segs) {
        if (Array.isArray(s) && analysisFiniteNumber(s[1]) && s[1] <= t1) {
            cover = s;
        }
    }

    return cover && cover[0] === value && analysisFiniteNumber(cover[3]) ? cover[3] : null;
}

// nomi degli osservatori da cui arrivano le letture di un repeater
function analysisObserverNames(data, ids) {

    return (Array.isArray(ids) ? ids : [])
        .map(id => analysisObserverLabel(analysisFindObserver(data, id) || { id: id }))
        .join(", ");
}

// una riga della tabella dei limiti (modello, nessun HTML)
function analysisLimitRowModel(data, r) {

    const info = analysisNodeRef(data, r.key);
    const per = analysisPeriodOf(r);
    const p = r.params || {};
    const t1 = data.window && analysisFiniteNumber(data.window.last_t) ? data.window.last_t : null;

    const setting = k => {

        const q = p[k] || {};
        const cell = analysisPeriodCap(q.end, q.cur, per.known);

        if (cell.kind === "known" && per.known) {
            cell.reads = analysisSegReads(q.segs, t1, cell.value);
        } else if (cell.kind === "known" || cell.kind === "last") {
            cell.reads = analysisFiniteNumber(q.reads) ? q.reads : null;
        }

        return cell;
    };

    const endEff = r.eff_end && typeof r.eff_end === "object" ? r.eff_end : null;
    const nowEff = r.eff_now && typeof r.eff_now === "object" ? r.eff_now : {};
    const eff = (kind, scope) => analysisPeriodCap(
        endEff && endEff[kind] ? endEff[kind][scope] : undefined,
        nowEff[kind] ? nowEff[kind][scope] : undefined,
        per.known
    );

    const settings = { max: setting("max"), unscoped: setting("unscoped"), advert: setting("advert") };
    const effective = {
        advert: { FLOOD: eff("advert", "FLOOD"), TC: eff("advert", "TC") },
        sonar: { FLOOD: eff("sonar", "FLOOD"), TC: eff("sonar", "TC") }
    };
    const mins = [effective.advert.FLOOD, effective.advert.TC, effective.sonar.FLOOD, effective.sonar.TC]
        .map(c => c.min)
        .filter(analysisFiniteNumber);

    return {
        key: r.key,
        name: info && info.n ? info.n : null,
        period: per,
        settings: settings,
        effective: effective,
        first_t: r.first_t,
        last_t: r.last_t,
        rows: analysisFiniteNumber(r.rows) ? r.rows : 0,
        observers: Array.isArray(r.observers) ? r.observers : [],
        changes: Array.isArray(r.changes) ? r.changes : [],
        hasValue: Object.values(settings).some(c => c.kind !== "none"),
        minEff: mins.length > 0 ? Math.min(...mins) : null
    };
}

// righe della tabella dei limiti: SOLO i repeater con impostazioni nel periodo
// (D64); prima quelli con un tetto noto, dal più restrittivo, poi quelli senza
// nessuna lettura valida
function analysisLimitsRows(data) {

    const lim = analysisLimits(data);

    if (!lim) {
        return [];
    }

    const rows = (Array.isArray(lim.repeaters) ? lim.repeaters : [])
        .filter(r => r && typeof r === "object" && analysisPeriodOf(r).state === "in")
        .map(r => analysisLimitRowModel(data, r));

    rows.sort((a, b) => {

        if (a.hasValue !== b.hasValue) {
            return a.hasValue ? -1 : 1;
        }

        if (a.minEff !== b.minEff) {

            if (a.minEff === null) {
                return 1;
            }

            if (b.minEff === null) {
                return -1;
            }

            return a.minEff - b.minEff;
        }

        return (a.name || a.key).localeCompare(b.name || b.key);
    });

    return rows;
}

// repeater con impostazioni solo fuori dal periodo: prima / dopo
function analysisLimitsOutside(data) {

    const out = { before: [], after: [] };
    const lim = analysisLimits(data);

    if (!lim || !Array.isArray(lim.repeaters)) {
        return out;
    }

    for (const r of lim.repeaters) {

        if (!r || typeof r !== "object" || analysisPeriodOf(r).state === "in") {
            continue;
        }

        const state = analysisPeriodOf(r).state;

        const info = analysisNodeRef(data, r.key);

        out[state].push({ key: r.key, name: info && info.n ? info.n : null, first_t: r.first_t, last_t: r.last_t });
    }

    const byName = (a, b) => String(a.name || a.key).localeCompare(String(b.name || b.key));

    out.before.sort((a, b) => ((b.last_t || 0) - (a.last_t || 0)) || byName(a, b));
    out.after.sort((a, b) => ((a.first_t || 0) - (b.first_t || 0)) || byName(a, b));

    return out;
}

// nota sotto la tabella: i repeater che hanno impostazioni solo prima o solo dopo il periodo
function analysisLimitsOutsideHtml(data) {

    const out = analysisLimitsOutside(data);

    if (out.before.length === 0 && out.after.length === 0) {
        return "";
    }

    const list = (items, field) => {

        const shown = items.slice(0, ANALYSIS_OUTSIDE_NAMES).map(x =>
            `${escapeHtml(x.name || `${String(x.key).slice(0, 8)}…`)} (${field === "last_t" ? tle("an.lastRead") : tle("an.firstRead")} ${escapeHtml(analysisFormatTime(x[field]))})`
        );

        if (items.length > shown.length) {
            shown.push(tlh("an.plusMore", { n: String(items.length - shown.length) }));
        }

        return shown.join(", ");
    };

    const parts = [];

    if (out.before.length > 0) {
        parts.push(tlnh("an.outsideBefore", out.before.length, { list: I18N.html(list(out.before, "last_t")) }));
    }

    if (out.after.length > 0) {
        parts.push(tlnh("an.outsideAfter", out.after.length, { list: I18N.html(list(out.after, "first_t")) }));
    }

    return '<p class="analysisHelp">' +
        tlh("an.outsideNote", { parts: I18N.html(parts.join("; ")) }) +
        "</p>";
}

function analysisLimitValueCell(c, carry, strong) {

    const text = escapeHtml(c.text);
    const shown = strong ? `<b>${text}</b>` : text;

    if (c.kind === "none") {
        return '<td class="analysisMuted">?</td>';
    }

    if (c.kind === "last") {
        const tip = tl("an.capLastTip", { duration: analysisFormatDuration(carry), value: c.text });

        return `<td class="analysisMuted"><span class="analysisCapLast" data-tooltip="${escapeHtml(tip)}">${text}</span></td>`;
    }

    if (c.kind === "range") {
        return `<td><span class="analysisCapRange" data-tooltip="${tle("an.capRangeTip")}">${shown}</span></td>`;
    }

    // un valore visto in una sola lettura (tipico di un cambio appena avvenuto) non è confermato
    return c.reads === 1
        ? `<td><span class="analysisCapSingle" data-tooltip="${tle("an.capSingleTip")}">${shown}</span></td>`
        : `<td>${shown}</td>`;
}

function analysisLimitsChangesHtml(changes) {

    const inWin = changes.filter(c => c && c.in_window);

    if (changes.length === 0) {
        return `<span class="analysisMuted">${tle("an.noneRecorded")}</span>`;
    }

    if (inWin.length === 0) {
        return `<span class="analysisMuted">${tle("an.noneInPeriod")}</span>`;
    }

    const shown = inWin.slice(0, 3).map(c =>
        `<div>${escapeHtml(ANALYSIS_PARAM_LABEL[c.p] || String(c.p))}: ${escapeHtml(String(c.from))} → ${escapeHtml(String(c.to))}` +
        `<div class="amSub">${tlh("an.changeBetween", { from: analysisFormatTime(c.after), to: analysisFormatTime(c.before) })}</div></div>`
    );

    if (inWin.length > shown.length) {
        shown.push(`<div class="amSub">${tlh("an.plusMore", { n: String(inWin.length - shown.length) })}</div>`);
    }

    return shown.join("");
}

// badge «aggiunto nel periodo» / «non più letto» di una riga
function analysisLimitBadgesHtml(r, carry) {

    const parts = [];

    if (r.period.added) {
        parts.push(
            '<span class="analysisBadge analysisBadgeNew" data-tooltip="' +
            escapeHtml(tl("an.badgeAddedTip", { time: analysisFormatTime(r.first_t) })) +
            `">${tle("an.badgeAdded")}</span>`
        );
    }

    if (r.period.ended) {
        parts.push(
            '<span class="analysisBadge analysisBadgeNone" data-tooltip="' +
            escapeHtml(tl("an.badgeEndedTip", { duration: analysisFormatDuration(carry), time: analysisFormatTime(r.last_t) })) +
            `">${tle("an.badgeEnded")}</span>`
        );
    }

    return parts.length > 0 ? `<div class="analysisBadgeRow">${parts.join(" ")}</div>` : "";
}

function analysisLimitsHtml(rows, data) {

    const lim = analysisLimits(data) || {};
    const carry = lim.params && analysisFiniteNumber(lim.params.carry_secs) ? lim.params.carry_secs : ANALYSIS_DEFAULT_CARRY_SECS;
    const aware = rows.length === 0 || rows.some(r => r.period.known);

    const head =
        `<thead><tr><th rowspan="2">Repeater</th>` +
        (aware
            ? `<th colspan="3" data-tooltip="${tle("an.limTipSettingsEnd")}">${tle("an.limThSettingsEnd")}</th>`
            : `<th colspan="3">${tle("an.limThSettingsRepeater")}</th>`) +
        `<th colspan="4" data-tooltip="${tle("an.limTipEffective")}">${tle("an.limThEffective")}</th>` +
        `<th rowspan="2" data-tooltip="${tle("an.limTipKnown")}">${tle("an.limThKnown")}</th>` +
        `<th rowspan="2">${tle("an.limThChanges")}</th></tr>` +
        `<tr><th>Flood Max Hops (Unscoped)</th><th>Flood Max Hops (Advert)</th><th>Flood Max Hops</th>` +
        `<th>${tle("an.limThAdvertNoRegion")}</th><th>${tle("an.limThAdvertRegion")}</th><th>${tle("an.limThMessageNoRegion")}</th><th>${tle("an.limThMessageRegion")}</th></tr></thead>`;

    if (rows.length === 0) {
        return `${head}<tbody><tr><td colspan="9">${tle("an.limNoRepeater")}</td></tr></tbody>`;
    }

    const body = rows.map(r => {

        const label = r.name ? escapeHtml(r.name) : `<span class="analysisMuted">${tle("an.unnamed")}</span>`;
        const changed = r.changes.some(c => c && c.in_window);
        const noValue = r.hasValue ? "" : ` <span class="analysisBadge analysisBadgeNone" data-tooltip="${tle("an.noValidTip")}">${tle("an.noValidReading")}</span>`;
        const readers = analysisObserverNames(data, r.observers);

        return `<tr${changed ? ' class="analysisRowChanged"' : ""}>` +
            `<td class="analysisRepName">${label}${noValue}<div class="amSub"><code>${escapeHtml(String(r.key).slice(0, 8))}</code></div></td>` +
            analysisLimitValueCell(r.settings.unscoped, carry, false) +
            analysisLimitValueCell(r.settings.advert, carry, false) +
            analysisLimitValueCell(r.settings.max, carry, false) +
            analysisLimitValueCell(r.effective.advert.FLOOD, carry, true) +
            analysisLimitValueCell(r.effective.advert.TC, carry, true) +
            analysisLimitValueCell(r.effective.sonar.FLOOD, carry, true) +
            analysisLimitValueCell(r.effective.sonar.TC, carry, true) +
            `<td>${escapeHtml(analysisFormatSpan(r.first_t, r.last_t))}` +
            `<div class="amSub">${escapeHtml(analysisPlural(r.rows, tl("an.wReading"), tl("an.wReadings")))}${readers ? ` · ${escapeHtml(readers)}` : ""}</div>` +
            `${analysisLimitBadgesHtml(r, carry)}</td>` +
            `<td>${analysisLimitsChangesHtml(r.changes)}</td>` +
            "</tr>";
    }).join("");

    return `${head}<tbody>${body}</tbody>`;
}

// una riga per osservatore: da dove vengono le letture dei tetti (D65)
function analysisSourcesRows(data) {

    const lim = analysisLimits(data);

    if (!lim || !Array.isArray(lim.observers)) {
        return [];
    }

    return lim.observers.filter(o => o && typeof o === "object").map(o => {

        const obs = analysisFindObserver(data, o.id);
        const finite = v => (analysisFiniteNumber(v) ? v : null);

        return {
            id: o.id,
            label: analysisObserverLabel(obs || { id: o.id }),
            error: !!(obs && obs.error),
            rows: o.rows === null ? null : finite(o.rows),
            repeaters: finite(o.repeaters),
            in_period: finite(o.in_period),
            first_t: finite(o.first_t),
            last_t: finite(o.last_t)
        };
    });
}

// nota di una riga delle fonti: [testo, classe]; la tabella assente è un
// avviso, un nodo senza repeater gestiti è una situazione normale
function analysisSourceNote(r) {

    if (r.rows === null) {
        return [
            r.error
                ? tl("an.srcNoteReadFailed")
                : tl("an.srcNoteNoTable"),
            "warn"
        ];
    }

    if (r.repeaters === 0 || r.rows === 0) {
        return [tl("an.srcNoteNoRepeater"), "info"];
    }

    if (r.in_period === 0) {
        return [tl("an.srcNoteOutside"), "info"];
    }

    if (r.error) {
        return [tl("an.srcNoteDbError"), "warn"];
    }

    return ["", "none"];
}

function analysisSourcesHtml(data) {

    const rows = analysisSourcesRows(data);

    const head =
        `<thead><tr><th>${tle("an.thNode")}</th>` +
        `<th data-tooltip="${tle("an.srcTipReadings")}">${tle("an.srcThReadings")}</th>` +
        `<th data-tooltip="${tle("an.srcTipRepeaters")}">${tle("an.srcThRepeaters")}</th>` +
        `<th data-tooltip="${tle("an.srcTipInPeriod")}">${tle("an.srcThInPeriod")}</th>` +
        `<th>${tle("an.srcThFirstLast")}</th><th>${tle("an.thNote")}</th></tr></thead>`;

    if (rows.length === 0) {
        return `${head}<tbody><tr><td colspan="6">${tle("an.srcNoNode")}</td></tr></tbody>`;
    }

    const body = rows.map(r => {

        const [text, kind] = analysisSourceNote(r);
        const note = text === ""
            ? '<span class="analysisMuted">—</span>'
            : (kind === "warn"
                ? `<span class="analysisBadge analysisBadgeMaybe">${escapeHtml(r.rows === null ? tl("an.badgeNoTable") : tl("an.badgeCheck"))}</span> ${escapeHtml(text)}`
                : `<span class="analysisMuted">${escapeHtml(text)}</span>`);

        return "<tr>" +
            `<td>${escapeHtml(r.label)}</td>` +
            `<td>${analysisCountHtml(r.rows)}</td>` +
            `<td>${analysisCountHtml(r.repeaters)}</td>` +
            `<td>${analysisCountHtml(r.in_period)}</td>` +
            `<td>${escapeHtml(analysisFormatSpan(r.first_t, r.last_t))}</td>` +
            `<td>${note}</td>` +
            "</tr>";
    }).join("");

    return `${head}<tbody>${body}</tbody>`;
}

// gateway più frequenti di una cella, come testo (nome escapato, tetto noto o limite minimo osservato)
function analysisGatewayTopHtml(top, data) {

    if (!Array.isArray(top) || top.length === 0) {
        return '<span class="analysisMuted">—</span>';
    }

    return top.map(g => {

        const name = escapeHtml(analysisNodeName(data, g.key));
        let cap;

        if (g.cap !== null && g.cap !== undefined) {
            cap = tlh("an.gwCap", { cap: analysisCapText(g.cap) });
        } else if (analysisFiniteNumber(g.lb) && g.lb > 0) {
            cap = tlh("an.gwCapUnknownSeen", { n: String(g.lb) });
        } else {
            cap = tle("an.gwCapUnknown");
        }

        return `<div>${name} <span class="analysisMuted">(${cap})</span> · ${escapeHtml(String(g.copies))}</div>`;
    }).join("");
}

function analysisPercent(n, total) {

    return total > 0 ? `${Math.round((n * 100) / total)} %` : "—";
}

// una riga per osservatore, tipo e ambito con almeno una copia
function analysisGatewayRows(data) {

    const lim = analysisLimits(data);

    if (!lim || !lim.gateways) {
        return [];
    }

    const rows = [];

    for (const o of (data.observers || [])) {

        const g = (lim.gateways.by_observer || {})[o.id];

        if (!g || o.error) {
            continue;
        }

        for (const kind of ["advert", "sonar"]) {
            for (const scope of ["FLOOD", "TC"]) {

                const cell = g[kind] && g[kind][scope];

                if (cell && (cell.copies > 0 || cell.direct > 0)) {
                    rows.push({ observer: o, kind: kind, scope: scope, cell: cell });
                }
            }
        }
    }

    return rows;
}

function analysisGatewaysHtml(rows, data) {

    const head =
        `<thead><tr><th>${tle("an.thTracer")}</th><th>${tle("an.gwThPackets")}</th><th>${tle("an.thCopies")}</th>` +
        `<th data-tooltip="${tle("an.gwTipResolved")}">${tle("an.gwThResolved")}</th>` +
        `<th data-tooltip="${tle("an.gwTipKnown")}">${tle("an.gwThKnown")}</th>` +
        `<th data-tooltip="${tle("an.gwTipBelow")}">${tlh("an.gwThBelow")}</th>` +
        `<th>${tle("an.gwThCaps")}</th><th>${tle("an.gwThMain")}</th></tr></thead>`;

    if (rows.length === 0) {
        return `${head}<tbody><tr><td colspan="8">${tle("an.gwNoCopy")}</td></tr></tbody>`;
    }

    const body = rows.map(r => {

        const c = r.cell;
        const ceilings = (c.ceilings || []).length > 0
            ? c.ceilings.map(x => `<div>${escapeHtml(String(x.cap))} <span class="analysisMuted">· ${escapeHtml(String(x.copies))}</span></div>`).join("")
            : `<span class="analysisMuted">${tle("an.noneKnown")}</span>`;

        return "<tr>" +
            `<td>${escapeHtml(analysisObserverLabel(r.observer))}</td>` +
            `<td>${escapeHtml(ANALYSIS_KIND_LABEL[r.kind] === "advert" ? "Advert" : "Sonar")}, ${escapeHtml(ANALYSIS_SCOPE_LABEL[r.scope])}</td>` +
            `<td>${escapeHtml(String(c.copies))}${c.direct ? `<div class="amSub">${tlh("an.plusDirect", { n: String(c.direct) })}</div>` : ""}</td>` +
            `<td>${escapeHtml(analysisPercent(c.resolved, c.copies))}</td>` +
            `<td>${escapeHtml(analysisPercent(c.known, c.copies))}${c.uncertain ? `<div class="amSub">${tlh("an.whileChanging", { n: String(c.uncertain) })}</div>` : ""}</td>` +
            `<td>${escapeHtml(c.known > 0 || c.below_deep > 0 ? analysisPercent(c.below_deep, c.copies) : "—")}</td>` +
            `<td>${ceilings}</td>` +
            `<td class="analysisPathCell">${analysisGatewayTopHtml(c.top, data)}</td>` +
            "</tr>";
    }).join("");

    return `${head}<tbody>${body}</tbody>`;
}

// avvisi del pannello 6: dati di una versione precedente, nessuna lettura,
// repeater aggiunti o non più letti nel periodo, regimi mescolati
function analysisLimitsNoticeHtml(data) {

    const lim = analysisLimits(data);
    const warn = text => `<div class="analysisWarning">${escapeHtml(text)}</div>`;

    if (!lim) {
        return warn(tl("an.limNoticeOld"));
    }

    const parts = [];
    const missing = (Array.isArray(lim.observers) ? lim.observers : []).filter(o => o && o.rows === null);

    if (!lim.available) {
        parts.push(warn(
            tl("an.limNoticeNone")
        ));
    }

    if (missing.length > 0) {

        const names = missing.map(o => analysisObserverLabel(analysisFindObserver(data, o.id) || { id: o.id })).join(", ");

        parts.push(warn(tl("an.limNoticeMissing", { names: names })));
    }

    const rows = analysisLimitsRows(data);
    const added = rows.filter(r => r.period.added).length;
    const ended = rows.filter(r => r.period.ended).length;

    if (added > 0 || ended > 0) {

        const what = [];

        if (added > 0) {
            what.push(tln("an.limAdded", added));
        }

        if (ended > 0) {
            what.push(tln("an.limEnded", ended));
        }

        parts.push(warn(
            tl("an.limNoticeAddedEnded", { what: what.join(tl("an.and")) })
        ));
    }

    if (analysisFiniteNumber(lim.changed_in_window) && lim.changed_in_window > 0) {
        parts.push(warn(
            tln("an.limChanged", lim.changed_in_window)
        ));
    }

    return parts.join("");
}

// soffitti da disegnare nell'istogramma: al massimo 2 per tipo, con almeno il 5 % delle copie e dentro l'asse
function analysisCeilingLines(data, observerId, scope, bins) {

    const out = { advert: [], sonar: [], total: { advert: 0, sonar: 0 } };
    const lim = analysisLimits(data);

    if (!lim || !lim.gateways) {
        return out;
    }

    const g = observerId === "all" ? lim.gateways.all : (lim.gateways.by_observer || {})[observerId];

    if (!g) {
        return out;
    }

    const scopes = scope === "FLOOD" ? ["FLOOD"] : (scope === "TC" ? ["TC"] : ["FLOOD", "TC"]);

    for (const kind of ["advert", "sonar"]) {

        const merged = new Map();
        let copies = 0;

        for (const sc of scopes) {

            const cell = g[kind] && g[kind][sc];

            if (!cell) {
                continue;
            }

            copies += analysisFiniteNumber(cell.copies) ? cell.copies : 0;

            for (const c of (cell.ceilings || [])) {
                merged.set(c.cap, (merged.get(c.cap) || 0) + c.copies);
            }
        }

        out.total[kind] = copies;

        out[kind] = Array.from(merged.entries())
            .map(([cap, n]) => ({ cap: cap, copies: n, share: copies > 0 ? (n * 100) / copies : 0 }))
            .filter(x => x.cap <= bins - 2 && x.share >= 5)
            .sort((a, b) => (b.copies - a.copies) || (a.cap - b.cap))
            .slice(0, 2);
    }

    return out;
}

function analysisCeilingNoteHtml(lines) {

    const parts = [];

    for (const kind of ["advert", "sonar"]) {
        for (const l of (lines[kind] || [])) {
            parts.push(
                tlh("an.ceilingPart", {
                    share: Math.round(l.share) + " %",
                    kind: ANALYSIS_KIND_LABEL[kind],
                    copies: String(l.copies),
                    total: String(lines.total[kind]),
                    cap: String(l.cap)
                })
            );
        }
    }

    if (parts.length === 0) {
        return "";
    }

    return `<span class="analysisMuted">${tlh("an.ceilingNote", { parts: I18N.html(parts.join("; ")) })}</span>`;
}

// testo del verdetto «l'altro tipo di pacchetto poteva seguire?» di una riga di confronto
function analysisCounterpartHtml(row, data) {

    const cp = row && row.cp;

    if (!cp) {
        return "";
    }

    const n = k => (analysisFiniteNumber(cp[k]) ? cp[k] : 0);
    const total = n("s") + n("u") + n("o") + n("x");

    if (total === 0) {
        return "";
    }

    const other = row.kind === "advert" ? tl("an.kindSonarMsg") : tl("an.kindAdvert");
    const scope = ANALYSIS_SCOPE_LABEL[row.scope] || "";
    const basis = tl("an.cpBasis", { other: other, scope: scope });
    const share = k => (n(k) === total ? tl("an.allCopies") : tl("an.nOf", { n: n(k), total: analysisPlural(total, tl("an.wCopy"), tl("an.wCopies")) }));
    const badge = (cls, text, tip) => `<span class="analysisBadge ${cls}" data-tooltip="${escapeHtml(tip)}">${escapeHtml(text)}</span>`;
    const parts = [];

    if (n("s") > 0) {

        const i = typeof row.hs === "string" ? row.hs.indexOf("b") : -1;
        const hop = i >= 0 && Array.isArray(row.hops) ? row.hops[i] : null;
        const cap = i >= 0 && Array.isArray(row.cx) ? row.cx[i] : null;
        const where = i >= 0
            ? ` ${tlh("an.atHop", { hop: String(i + 1), name: hop && hop.k ? analysisNodeName(data, hop.k) : "?", cap: analysisCapText(cap) })}`
            : ` ${tle("an.settingChangedSince")}`;

        parts.push(`<div>${badge("analysisBadgeStop", tl("an.badgeStop"), basis)}${where} <span class="analysisMuted">· ${escapeHtml(share("s"))}</span></div>`);
    }

    if (n("u") > 0) {
        parts.push(`<div>${badge("analysisBadgeMaybe", tl("an.badgeChanging"), basis)} <span class="analysisMuted">· ${tlh("an.settingChangedAround", { share: share("u") })}</span></div>`);
    }

    if (n("o") > 0) {

        const free = analysisFiniteNumber(row.fr) && row.fr > 0
            ? `, ${tlh("an.hopsNoEvidence", { count: analysisPlural(row.fr, tl("an.wHop"), tl("an.wHops")) })}`
            : "";

        parts.push(`<div>${badge("analysisBadgeOpen", tl("an.badgeOpen"), basis)}${free} <span class="analysisMuted">· ${escapeHtml(share("o"))}</span></div>`);
    }

    if (n("x") > 0) {
        parts.push(`<div>${badge("analysisBadgeNone", tl("an.badgeNoCap"), basis)} <span class="analysisMuted">· ${escapeHtml(share("x"))}</span></div>`);
    }

    return parts.join("");
}

// pannello 5: l'advert dello stesso ambito sugli stessi percorsi Sonar poteva seguire?
function analysisFollowHtml(r, data) {

    const f = r && r.follow;

    if (!f) {
        return '<span class="analysisMuted">—</span>';
    }

    const n = k => (analysisFiniteNumber(f[k]) ? f[k] : 0);
    const total = n("s") + n("u") + n("o") + n("x");

    if (total === 0) {
        return '<span class="analysisMuted">—</span>';
    }

    const basis = tl("an.followBasis");
    const badge = (cls, text) => `<span class="analysisBadge ${cls}" data-tooltip="${escapeHtml(basis)}">${escapeHtml(text)}</span>`;
    const parts = [];

    if (n("s") > 0) {

        const st = r.stop;
        const where = st
            ? ` ${tlh("an.followWhere", { name: analysisNodeName(data, st.key), cap: analysisCapText(st.cap), pos: String(st.pos) })}`
            : "";

        parts.push(`<div>${badge("analysisBadgeStop", tl("an.badgeStop"))} ${escapeHtml(`${n("s")}/${total}`)}${where}</div>`);
    }

    if (n("u") > 0) {
        parts.push(`<div>${badge("analysisBadgeMaybe", tl("an.badgeChanging"))} ${escapeHtml(`${n("u")}/${total}`)}</div>`);
    }

    if (n("o") > 0) {
        parts.push(`<div>${badge("analysisBadgeOpen", tl("an.badgeOpen"))} ${escapeHtml(`${n("o")}/${total}`)}</div>`);
    }

    if (n("x") > 0) {
        parts.push(`<div>${badge("analysisBadgeNone", tl("an.badgeNoCap"))} ${escapeHtml(`${n("x")}/${total}`)}</div>`);
    }

    return parts.join("");
}

// pannello 5: tetto advert noto del repeater, oppure limite minimo osservato
function analysisRepeaterCapHtml(r, data) {

    const lim = analysisLimits(data);
    const known = lim && Array.isArray(lim.repeaters) ? lim.repeaters.find(x => x && x.key === r.key) : null;

    // tetti in vigore a FINE periodo (D63); un JSON senza `eff_end` ha solo i correnti
    let eff = null;

    if (known) {
        eff = known.eff_end && typeof known.eff_end === "object" ? known.eff_end : (known.eff_now || null);
    }

    const has = v => analysisFiniteNumber(v) || Array.isArray(v);
    const num = v => (has(v) ? analysisCapText(v) : "?");

    if (eff && eff.advert && (has(eff.advert.FLOOD) || has(eff.advert.TC))) {
        return `<span data-tooltip="${escapeHtml(tl("an.repCapTip", { a: num(eff.sonar && eff.sonar.FLOOD), b: num(eff.sonar && eff.sonar.TC) }))}">${tlh("an.repCapAdv", { a: num(eff.advert.FLOOD), b: num(eff.advert.TC) })}</span>`;
    }

    const info = analysisNodeRef(data, r.key);
    const lb = info && Array.isArray(info.lb) ? Math.max(info.lb[0] || 0, info.lb[1] || 0) : 0;

    if (lb > 0) {
        return `<span class="analysisMuted" data-tooltip="${tle("an.repCapSeenTip")}">${tlh("an.repCapSeen", { n: String(lb) })}</span>`;
    }

    return '<span class="analysisMuted">—</span>';
}

/* =========================
   DOM: utilità
========================= */

function analysisEl(id) {

    return document.getElementById(id);
}

function analysisSetHtml(id, html) {

    const el = analysisEl(id);

    if (el) {
        el.innerHTML = html;
    }
}

// la scheda è davvero visibile (Leaflet e Chart.js vanno creati con il
// contenitore visibile, come per le mappe del §84)
function analysisPageVisible() {

    const page = analysisEl("analysisPage");

    return !!page && page.style.display !== "none";
}

function analysisIsDark() {

    return document.body.classList.contains("dark");
}

async function analysisFetchJson(url) {

    try {

        const res = await fetch(url);
        let body = null;

        try {
            body = await res.json();
        } catch (e) {
            body = null;
        }

        return { ok: res.ok, status: res.status, body: body };

    } catch (err) {

        return { ok: false, status: 0, body: null };
    }
}

function analysisFillSelect(select, options, selected) {

    select.innerHTML = "";

    for (const o of options) {

        const opt = document.createElement("option");

        opt.value = o.value;
        opt.textContent = o.text;
        select.appendChild(opt);
    }

    if (selected !== null && selected !== undefined && options.some(o => o.value === selected)) {
        select.value = selected;
    }
}

/* =========================
   CARICAMENTO
========================= */

function analysisPopulateTypeSelector() {

    const select = analysisEl("analysisTypeSelector");

    if (!select || select.options.length > 0) {
        return;
    }

    analysisFillSelect(
        select,
        Object.keys(ANALYSIS_REGISTRY).map(id => ({ value: id, text: ANALYSIS_REGISTRY[id].label })),
        analysisCurrent
    );
}

// riempie il selettore del periodo e ritorna l'id scelto: l'ultimo usato se
// esiste ancora, altrimenti quello predefinito dell'indice
function analysisPopulateWindowSelector() {

    const select = analysisEl("analysisWindowSelector");
    const windows = (analysisIndex && analysisIndex.windows) || [];

    if (windows.length === 0) {

        if (select) {
            select.innerHTML = "";
        }

        return null;
    }

    const saved = safeLocalStorageGet("analysisWindow");
    const ids = windows.map(w => w.id);
    const chosen = ids.includes(saved) ? saved : (ids.includes(analysisIndex.default) ? analysisIndex.default : ids[0]);

    if (select) {
        analysisFillSelect(select, windows.map(w => ({ value: w.id, text: analysisWindowLabel(w) })), chosen);
    }

    return chosen;
}

function analysisShowLoadError(res) {

    const noData = res.status === 404 && res.body && /No analysis data/.test(String(res.body.error || ""));
    const content = analysisEl("analysisContent");

    if (noData) {

        analysisData = null;
        analysisIndex = null;

        if (content) {
            content.style.display = "none";
        }

        analysisSetHtml("analysisInfo", "");
        analysisSetHtml(
            "analysisNotice",
            `<div class="analysisWarning">${tle("an.loadNoData")}</div>`
        );

        return;
    }

    // errore di rete o del server: se c'è già una vista, resta (con l'avviso)
    analysisSetHtml(
        "analysisNotice",
        `<div class="analysisWarning">${tlh("an.loadError", { reason: res.status === 0 ? tl("an.networkError") : `HTTP ${res.status}` })}` +
        `${analysisData ? ` ${tle("an.showingEarlier")}` : ""}</div>`
    );

    if (!analysisData && content) {
        content.style.display = "none";
    }
}

async function loadAnalysisTab() {

    const requestId = ++analysisRequestId;

    analysisInitListeners();
    analysisPopulateTypeSelector();

    const res = await analysisFetchJson(`${ANALYSIS_API_BASE}/${encodeURIComponent(analysisCurrent)}/windows`);

    if (requestId !== analysisRequestId) {
        return;
    }

    if (!res.ok || !res.body || !Array.isArray(res.body.windows)) {

        analysisShowLoadError(res);

        return;
    }

    const previousGenerated = analysisIndex ? analysisIndex.generated_at : null;

    analysisIndex = res.body;

    const chosen = analysisPopulateWindowSelector();

    if (chosen === null) {

        analysisData = null;

        const fresh = analysisFreshness(analysisIndex);

        analysisSetHtml("analysisInfo", "");
        analysisSetHtml("analysisNotice", analysisNoticeHtml(analysisIndex, fresh));

        const content = analysisEl("analysisContent");

        if (content) {
            content.style.display = "none";
        }

        return;
    }

    // stessa finestra, stessi dati già in mano: niente nuova richiesta, si
    // aggiornano solo intestazione e avvisi (e si rimette a posto la mappa,
    // che mentre la scheda era nascosta non ha potuto misurarsi)
    if (
        analysisData &&
        analysisWindowId === chosen &&
        previousGenerated === analysisIndex.generated_at &&
        analysisData.generated_at === analysisIndex.generated_at
    ) {

        analysisRenderHeader();
        analysisAfterShow();

        return;
    }

    await analysisLoadWindow(chosen);
}

async function analysisLoadWindow(id) {

    const requestId = ++analysisRequestId;

    const res = await analysisFetchJson(
        `${ANALYSIS_API_BASE}/${encodeURIComponent(analysisCurrent)}/data?window=${encodeURIComponent(id)}`
    );

    if (requestId !== analysisRequestId) {
        return;
    }

    if (!res.ok || !res.body || typeof res.body !== "object") {

        analysisShowLoadError(res);

        return;
    }

    analysisWindowId = id;
    analysisData = res.body;

    analysisRenderAll();
}

/* =========================
   DISEGNO: intestazione e pannelli
========================= */

function analysisRenderHeader() {

    const fresh = analysisFreshness(analysisIndex);

    analysisSetHtml("analysisInfo", analysisInfoHtml(analysisIndex, analysisData, fresh));
    analysisSetHtml("analysisNotice", analysisNoticeHtml(analysisIndex, fresh));
}

function analysisRenderAll() {

    if (!analysisData) {
        return;
    }

    analysisRenderHeader();

    const content = analysisEl("analysisContent");

    if (content) {
        content.style.display = "block";
    }

    for (const id of Object.keys(ANALYSIS_REGISTRY)) {

        const panel = analysisEl(ANALYSIS_REGISTRY[id].panelId);

        if (panel) {
            panel.style.display = id === analysisCurrent ? "block" : "none";
        }
    }

    ANALYSIS_REGISTRY[analysisCurrent].render(analysisData);
}

function renderAnalysisPropagation(data) {

    // coppia: si tiene quella scelta se esiste ancora in questi dati
    const exists = analysisPairSource !== null && (data.matrix || []).some(c => c.source === analysisPairSource && c.observer === analysisPairObserver);

    if (!exists) {

        const def = analysisDefaultPair(data);

        analysisPairSource = def ? def.source : null;
        analysisPairObserver = def ? def.observer : null;
        analysisPairSelected = new Set();
    }

    analysisSetHtml("analysisStatus", analysisStatusHtml(data, analysisIndex));
    analysisRenderMatrix();
    analysisPopulateHistControls(data);
    analysisRenderHistogram();
    analysisPopulatePairControls(data);
    analysisRenderPair(!exists);
    analysisRenderRepeaters();
    analysisRenderLimits();
}

function analysisRenderMatrix() {

    if (!analysisData) {
        return;
    }

    // il ridisegno (anche quello al clic su una cella) non deve riportare a
    // sinistra lo scorrimento orizzontale della matrice (§93)
    const host = analysisEl("analysisMatrix");
    const find = () => (host && typeof host.querySelector === "function") ? host.querySelector(".analysisScrollMatrix") : null;
    const before = find();
    const left = before ? before.scrollLeft : 0;

    analysisSetHtml("analysisMatrix", analysisMatrixHtml(analysisData));

    if (left > 0) {

        const after = find();

        if (after) {
            after.scrollLeft = left;
        }
    }
}

/* ----- istogramma ----- */

function analysisPopulateHistControls(data) {

    const obs = analysisEl("analysisHistObserver");

    if (obs) {

        const previous = obs.value || "all";
        const options = [{ value: "all", text: tl("an.allTracers") }].concat(
            (data.observers || []).filter(o => !o.error).map(o => ({ value: o.id, text: analysisObserverLabel(o) }))
        );

        analysisFillSelect(obs, options, previous);
    }

    const restore = (id, key, allowed) => {

        const el = analysisEl(id);
        const saved = safeLocalStorageGet(key);

        if (el && allowed.includes(saved)) {
            el.value = saved;
        }
    };

    restore("analysisHistScope", "analysisHistScope", ["both", "FLOOD", "TC"]);
    restore("analysisHistMetric", "analysisHistMetric", ["copies", "best"]);
    restore("analysisHistYMode", "analysisHistYMode", ["share", "count"]);
}

function analysisDeepLinePlugin(minHops, color, textColor) {

    return {
        id: "analysisDeepLine",
        afterDraw(chart) {

            const x = chart.scales && chart.scales.x;
            const area = chart.chartArea;

            if (!x || !area || !(minHops > 0)) {
                return;
            }

            const a = x.getPixelForValue(minHops - 1);
            const b = x.getPixelForValue(minHops);
            const px = (a + b) / 2;
            const ctx = chart.ctx;

            ctx.save();
            ctx.strokeStyle = color;
            ctx.setLineDash([6, 4]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(px, area.top);
            ctx.lineTo(px, area.bottom);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = textColor;
            ctx.font = "12px sans-serif";
            ctx.textAlign = "left";
            ctx.fillText(tl("an.deepLineLabel", { n: minHops }), px + 6, area.top + 14);
            ctx.restore();
        }
    };
}

// soffitti dei gateway: una linea tratteggiata tra la barra del tetto e la successiva
// (una copia non può avere più hop del tetto del suo gateway), colore della serie;
// haloColor (facoltativo): contorno dell'etichetta nel colore dello sfondo, perché
// resti leggibile quando cade sopra una barra senza nasconderla
function analysisCapLinesPlugin(lines, textColor, haloColor) {

    return {
        id: "analysisCapLines",
        afterDraw(chart) {

            const x = chart.scales && chart.scales.x;
            const area = chart.chartArea;

            if (!x || !area) {
                return;
            }

            const ctx = chart.ctx;
            let row = 0;

            for (const kind of ["advert", "sonar"]) {
                for (const l of (lines[kind] || [])) {

                    const color = kind === "advert" ? ANALYSIS_ADVERT_COLOR : ANALYSIS_SONAR_COLOR;
                    const px = (x.getPixelForValue(l.cap) + x.getPixelForValue(l.cap + 1)) / 2;

                    ctx.save();
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.setLineDash([2, 3]);
                    ctx.beginPath();
                    ctx.moveTo(px, area.top);
                    ctx.lineTo(px, area.bottom);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    const label = tl("an.capLineLabel", { kind: kind === "advert" ? "Advert" : "Sonar", cap: l.cap, share: Math.round(l.share) });
                    const ty = area.top + 30 + row * 14;

                    ctx.font = "12px sans-serif";
                    ctx.textAlign = "right";

                    if (haloColor && typeof ctx.strokeText === "function") {

                        ctx.lineJoin = "round";
                        ctx.lineWidth = 3;
                        ctx.strokeStyle = haloColor;
                        ctx.strokeText(label, px - 6, ty);
                    }

                    ctx.fillStyle = textColor;
                    ctx.fillText(label, px - 6, ty);
                    ctx.restore();

                    row++;
                }
            }
        }
    };
}

function analysisRenderHistogram() {

    if (!analysisData) {
        return;
    }

    if (analysisHistChart) {

        analysisHistChart.destroy();
        analysisHistChart = null;
    }

    const value = (id, fallback) => {
        const el = analysisEl(id);
        return el && el.value ? el.value : fallback;
    };

    const observer = value("analysisHistObserver", "all");
    const scope = value("analysisHistScope", "both");
    const metric = value("analysisHistMetric", "copies");
    const ymode = value("analysisHistYMode", "share");
    const model = analysisHistogramModel(analysisData, observer, scope, metric, ymode);
    const container = analysisEl("analysisHistContainer");
    const canvas = analysisEl("analysisHistChart");
    const note = analysisEl("analysisHistNote");
    const gwNote = analysisEl("analysisHistGateway");
    const lines = analysisCeilingLines(analysisData, observer, scope, model.labels.length);
    const unit = metric === "best" ? tl("an.wTransmissions") : tl("an.wCopies");
    const counted = n => analysisPlural(n, metric === "best" ? tl("an.wTransmission") : tl("an.wCopy"), unit);

    if (note) {

        note.innerHTML = model.empty
            ? tle("an.histEmpty")
            : `${tle("an.histAdvertsName")}: ${escapeHtml(counted(model.advert.total))}` +
              ` &nbsp;|&nbsp; Sonar: ${escapeHtml(counted(model.sonar.total))}` +
              (model.ymode === "share" ? ` <span class="analysisMuted">· ${tle("an.histShareNote")}</span>` : "");
    }

    if (gwNote) {
        gwNote.innerHTML = model.empty ? "" : analysisCeilingNoteHtml(lines);
    }

    if (container) {
        container.style.display = model.empty ? "none" : "block";
    }

    if (model.empty || !canvas || typeof Chart === "undefined") {
        return;
    }

    const dark = analysisIsDark();
    const tickColor = dark ? "#dddddd" : "#444444";
    const haloColor = dark ? "rgba(18,18,18,0.9)" : "rgba(255,255,255,0.9)";
    const gridColor = dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.10)";
    const minHops = analysisData.params && analysisFiniteNumber(analysisData.params.deep_min_hops)
        ? analysisData.params.deep_min_hops
        : analysisDeep(analysisData) + 1;

    analysisHistChart = new Chart(canvas, {
        type: "bar",
        data: {
            labels: model.labels,
            datasets: [
                {
                    label: `${tl("an.histAdvertsName")} (${counted(model.advert.total)})`,
                    data: model.advert.values,
                    backgroundColor: ANALYSIS_ADVERT_COLOR + "cc",
                    borderColor: ANALYSIS_ADVERT_COLOR,
                    borderWidth: 1,
                    analysisSeries: "advert"
                },
                {
                    label: `Sonar (${counted(model.sonar.total)})`,
                    data: model.sonar.values,
                    backgroundColor: ANALYSIS_SONAR_COLOR + "cc",
                    borderColor: ANALYSIS_SONAR_COLOR,
                    borderWidth: 1,
                    analysisSeries: "sonar"
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: {
                    title: { display: true, text: tl("an.histXAxis"), color: tickColor },
                    ticks: { color: tickColor },
                    grid: { color: gridColor }
                },
                y: {
                    beginAtZero: true,
                    title: { display: true, text: model.ymode === "share" ? tl("an.histYShare") : tl("an.histYNumber", { unit: unit }), color: tickColor },
                    ticks: { color: tickColor },
                    grid: { color: gridColor }
                }
            },
            plugins: {
                legend: { labels: { color: tickColor } },
                tooltip: {
                    callbacks: {
                        title: items => tl("an.histTipTitle", { label: items[0].label }),
                        label: item => {

                            const s = model[item.dataset.analysisSeries];
                            const i = item.dataIndex;

                            return `${item.dataset.analysisSeries === "advert" ? tl("an.histAdvertsName") : "Sonar"}: ` +
                                `${counted(s.counts[i])} (${s.share[i].toFixed(1)} %)`;
                        }
                    }
                }
            }
        },
        plugins: [analysisDeepLinePlugin(minHops, tickColor, tickColor), analysisCapLinesPlugin(lines, tickColor, haloColor)]
    });
}

/* ----- confronto di coppia ----- */

function analysisPopulatePairControls(data) {

    const srcSel = analysisEl("analysisPairSource");

    if (!srcSel) {
        return;
    }

    analysisFillSelect(
        srcSel,
        (data.sources || []).map(s => ({ value: s.prefix, text: `${analysisSourceLabel(s)} (${s.prefix})` })),
        analysisPairSource
    );

    analysisPopulatePairObservers();
}

function analysisPopulatePairObservers() {

    const obsSel = analysisEl("analysisPairObserver");

    if (!obsSel || !analysisData) {
        return;
    }

    const source = analysisFindSource(analysisData, analysisPairSource);
    const options = (analysisData.observers || [])
        .filter(o => !source || o.id !== source.observer_id)
        .map(o => ({ value: o.id, text: analysisObserverLabel(o) }));

    analysisFillSelect(obsSel, options, analysisPairObserver);
}

// resetSelection: ripropone i due path più frequenti (uno per tipo)
function analysisRenderPair(resetSelection) {

    const section = analysisEl("analysisPairBody");

    if (!analysisData || !analysisPairSource || !analysisPairObserver) {

        analysisPairModel = null;

        if (section) {
            section.style.display = "none";
        }

        analysisSetHtml("analysisPairEmpty", `<p class="analysisHelp">${tle("an.pairEmpty")}</p>`);

        return;
    }

    analysisSetHtml("analysisPairEmpty", "");

    if (section) {
        section.style.display = "block";
    }

    const model = analysisBuildPairModel(analysisData, analysisPairSource, analysisPairObserver);

    analysisPairModel = model;

    if (resetSelection) {

        analysisPairSelected = new Set();

        if (model.advert.length > 0) {
            analysisPairSelected.add(model.advert[0].id);
        }

        if (model.sonar.length > 0) {
            analysisPairSelected.add(model.sonar[0].id);
        }
    } else {

        // i path possono essere cambiati con i nuovi dati: si tengono solo gli id ancora presenti
        const valid = new Set(model.advert.concat(model.sonar).map(r => r.id));

        analysisPairSelected = new Set(Array.from(analysisPairSelected).filter(id => valid.has(id)));
    }

    analysisSetHtml("analysisPairSummary", analysisPairSummaryHtml(model));

    analysisSetHtml(
        "analysisPairAdvertTable",
        analysisPairHeaderHtml() + analysisPairRowsHtml(model.advert, model, analysisData, analysisPairSelected, "Sonar")
    );
    analysisSetHtml(
        "analysisPairSonarTable",
        analysisPairHeaderHtml() + analysisPairRowsHtml(model.sonar, model, analysisData, analysisPairSelected, "advert")
    );

    const more = kind => model.truncated && model.truncated[kind] > 0
        ? `<p class="analysisHelp">${escapeHtml(tln("an.pairTruncated", model.truncated[kind]))}</p>`
        : "";

    analysisSetHtml("analysisPairAdvertMore", more("advert"));
    analysisSetHtml("analysisPairSonarMore", more("sonar"));

    analysisRenderPairMap();
}

function analysisSelectPair(source, observer, scrollToPair) {

    if (!analysisData) {
        return;
    }

    analysisPairSource = source;
    analysisPairObserver = observer;

    const srcSel = analysisEl("analysisPairSource");

    if (srcSel) {
        srcSel.value = source;
    }

    analysisPopulatePairObservers();

    const obsSel = analysisEl("analysisPairObserver");

    if (obsSel && obsSel.value) {
        analysisPairObserver = obsSel.value;
    }

    analysisRenderMatrix();
    analysisRenderPair(true);

    if (scrollToPair) {

        const head = analysisEl("analysisPairHeading");

        if (head && typeof head.scrollIntoView === "function") {
            head.scrollIntoView({ block: "start", behavior: "smooth" });
        }
    }
}

/* ----- mappa ----- */

function analysisEnsurePairMap() {

    if (analysisPairMap) {
        return analysisPairMap;
    }

    analysisPairMap = L.map("analysisPairMap").setView([42.5, 12.5], 5);

    createOsmTileLayer().addTo(analysisPairMap);

    analysisPairMarkerGroup = L.layerGroup().addTo(analysisPairMap);
    analysisPairSegmentGroup = L.layerGroup().addTo(analysisPairMap);

    // pane delle frecce, per-mappa (stesso nome e stesso z-index di Trace)
    const arrowPane = analysisPairMap.createPane("traceArrowPane");

    arrowPane.style.zIndex = 660;
    arrowPane.style.pointerEvents = "none";

    // riquadro in alto a destra: legenda e punti non mostrati (stessa
    // classe e stessa palette ambra del riquadro del §84)
    analysisPairInfoControl = L.control({ position: "topright" });

    analysisPairInfoControl.onAdd = function () {

        const div = L.DomUtil.create("div", "nodePathInfo");

        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);

        div.style.display = "none";

        return div;
    };

    analysisPairInfoControl.addTo(analysisPairMap);

    analysisPairMap.on("zoomend", analysisRenderPairSegments);

    return analysisPairMap;
}

function analysisPairInfoHtml(entries, omitted) {

    const lines = entries.map(e =>
        `<li><span class="analysisSwatch" style="background:${e.color}"></span>` +
        `${escapeHtml(e.kind === "advert" ? "Advert" : "Sonar")} · ${escapeHtml(analysisPlural(e.row.n, tl("an.wHop"), tl("an.wHops")))} · ${escapeHtml(analysisPlural(e.row.count, tl("an.wCopy"), tl("an.wCopies")))}</li>`
    );

    let html = `<div class="nodePathInfoTitle">${tle("an.mapPaths")}</div><ul>${lines.join("")}</ul>`;

    if (omitted.length > 0) {

        html += `<div class="nodePathInfoTitle">${tle("an.mapNotShown")}</div><ul>` +
            omitted.map(o => `<li>${escapeHtml(o.kind === "advert" ? "Advert" : "Sonar")} · ${escapeHtml(o.step)} (${escapeHtml(o.name)}): ${escapeHtml(o.reason)}</li>`).join("") +
            "</ul>" +
            `<div class="nodePathInfoLegend"><span class="nodePathInfoSwatch"></span>${tle("an.mapLegend")}</div>`;
    }

    return html;
}

function analysisRenderPairMap() {

    const mapEl = analysisEl("analysisPairMap");

    if (!mapEl || !analysisPairModel) {
        return;
    }

    // contenitore nascosto: Leaflet non saprebbe misurarlo; si rifà alla riapertura
    if (!analysisPageVisible()) {

        analysisMapDirty = true;

        return;
    }

    analysisMapDirty = false;

    const map = analysisEnsurePairMap();

    map.invalidateSize();

    analysisPairMarkerGroup.clearLayers();
    analysisPairSegmentGroup.clearLayers();
    analysisPairSegmentDefs = [];

    const model = analysisPairModel;
    const rows = model.advert.concat(model.sonar).filter(r => analysisPairSelected.has(r.id));
    const bounds = [];
    const placed = new Set();
    const entries = [];
    const omitted = [];
    const perKind = { advert: 0, sonar: 0 };

    for (const row of rows) {

        const color = row.kind === "advert" ? ANALYSIS_ADVERT_COLOR : ANALYSIS_SONAR_COLOR;
        const points = analysisBuildPathPoints(analysisData, model, row);
        const k = perKind[row.kind]++;
        const sign = (row.kind === "advert" ? 1 : -1) * (1 + 0.7 * k);

        entries.push({ kind: row.kind, row: row, color: color });

        for (const p of points) {

            if (!p.shown) {

                omitted.push({ kind: row.kind, step: p.step, name: p.name, reason: p.reason.text });

                continue;
            }

            const id = `${p.lat},${p.lon},${p.role === "hop" ? p.name : p.role}`;

            if (placed.has(id)) {
                continue;
            }

            placed.add(id);
            bounds.push([p.lat, p.lon]);

            const label = p.role === "origin" ? tl("an.markerSource", { name: p.name }) : (p.role === "src" ? tl("an.markerTracer", { name: p.name }) : p.name);
            const marker = L.marker([p.lat, p.lon], { icon: nodePathIconForPoint(p) });

            marker.bindTooltip(escapeHtml(label), { permanent: p.role !== "hop", direction: "top" });
            marker.addTo(analysisPairMarkerGroup);
        }

        for (const s of analysisBuildSegments(points)) {

            analysisPairSegmentDefs.push({
                latlngFrom: { lat: s.from.lat, lng: s.from.lon },
                latlngTo: { lat: s.to.lat, lng: s.to.lon },
                bridged: s.bridged,
                isDegenerate: s.from.lat === s.to.lat && s.from.lon === s.to.lon,
                color: color,
                sign: sign
            });
        }
    }

    if (bounds.length >= 2) {

        map.fitBounds(bounds, { padding: [30, 30], animate: false, maxZoom: 16 });

    } else if (bounds.length === 1) {

        map.setView(bounds[0], 13, { animate: false });
    }

    analysisRenderPairSegments();

    if (analysisPairInfoControl) {

        const container = analysisPairInfoControl.getContainer();

        if (container) {

            container.innerHTML = rows.length > 0 ? analysisPairInfoHtml(entries, omitted) : "";
            container.style.display = rows.length > 0 ? "block" : "none";
        }
    }

    const caption = analysisEl("analysisPairCaption");

    if (caption) {

        caption.textContent = rows.length === 0
            ? tl("an.mapCaptionEmpty")
            : tl("an.mapCaption", { paths: rows.length, points: bounds.length }) +
              (omitted.length > 0 ? tl("an.mapCaptionOmitted", { n: omitted.length }) : "") + ".";
    }
}

// frecce a distanza fissa in pixel dal marker: dipendono dallo zoom, quindi
// si ridisegnano a ogni zoomend (stessa ragione e stesse costanti di Trace)
function analysisRenderPairSegments() {

    if (!analysisPairMap || !analysisPairSegmentGroup) {
        return;
    }

    analysisPairSegmentGroup.clearLayers();

    const zoom = analysisPairMap.getZoom();

    for (const def of analysisPairSegmentDefs) {

        const off = offsetSegmentPixels(analysisPairMap, zoom, def.latlngFrom, def.latlngTo, def.sign);
        const offset = off.latlngs;

        const line = L.polyline(offset, {
            color: def.color,
            weight: 3,
            opacity: 0.85,
            dashArray: def.bridged ? "8 6" : null
        });

        if (def.bridged) {
            line.bindTooltip(tle("an.mapBridgedTip"), { sticky: true });
        }

        line.addTo(analysisPairSegmentGroup);

        if (def.isDegenerate) {
            continue;
        }

        const bearing = bearingDegrees(offset[0], offset[1]);
        const MID_T = 0.7;

        addTraceArrowMarker(offset, bearing, def.color, MID_T, analysisPairSegmentGroup);

        const desiredEndT = 1 - TRACE_ARROW_END_BACKOFF_PIXELS / off.lengthPixels;
        const minEndT = MID_T + TRACE_ARROW_MIN_SEPARATION_PIXELS / off.lengthPixels;

        addTraceArrowMarker(offset, bearing, def.color, Math.min(0.98, Math.max(desiredEndT, minEndT)), analysisPairSegmentGroup);
    }
}

/* ----- repeater ----- */

function analysisRenderRepeaters() {

    if (!analysisData) {
        return;
    }

    const statusEl = analysisEl("analysisRepStatus");
    const textEl = analysisEl("analysisRepFilter");
    const rows = analysisRepeaterRows(analysisData, statusEl ? statusEl.value : "all", textEl ? textEl.value : "");
    const all = analysisData.repeaters || [];
    const count = s => all.filter(r => r.status === s).length;

    const summary =
        tl("an.repSummary", { total: all.length, proven: count("proven"), indication: count("indication"), sonar: count("messages_only"), shown: rows.length }) +
        (analysisData.repeaters_truncated ? ` ${tl("an.repCut")}` : "");

    analysisSetHtml("analysisRepSummary", `<p class="analysisHelp">${escapeHtml(summary)}</p>`);
    analysisSetHtml("analysisRepeatersTable", analysisRepeatersHtml(rows, analysisData));
}

/* ----- pannello 6: limiti operativi ----- */

function analysisRenderLimits() {

    if (!analysisData) {
        return;
    }

    const lim = analysisLimits(analysisData);
    const body = analysisEl("analysisLimitsBody");

    analysisSetHtml("analysisLimitsNotice", analysisLimitsNoticeHtml(analysisData));

    // JSON di prima del §89: niente tabelle vuote, solo l'avviso
    if (body) {
        body.style.display = lim ? "block" : "none";
    }

    if (!lim) {
        return;
    }

    analysisSetHtml("analysisLimitsTable", analysisLimitsHtml(analysisLimitsRows(analysisData), analysisData));
    analysisSetHtml("analysisLimitsOutside", analysisLimitsOutsideHtml(analysisData));
    analysisSetHtml("analysisSourcesTable", analysisSourcesHtml(analysisData));
    analysisSetHtml("analysisGatewaysTable", analysisGatewaysHtml(analysisGatewayRows(analysisData), analysisData));
}

/* =========================
   RIAPERTURA, TEMA, LISTENER
========================= */

// scheda tornata visibile: le mappe e i grafici creati o ridisegnati mentre
// era nascosta si rimisurano
function analysisAfterShow() {

    if (!analysisData) {
        return;
    }

    if (analysisPairMap) {
        analysisPairMap.invalidateSize();
    }

    if (analysisMapDirty) {
        analysisRenderPairMap();
    }

    if (analysisHistChart) {
        analysisHistChart.resize();
    } else if (analysisPageVisible()) {
        analysisRenderHistogram();
    }
}

function analysisOnThemeChange() {

    if (analysisData && analysisPageVisible()) {
        analysisRenderHistogram();
    }
}

let analysisListenersReady = false;

function analysisInitListeners() {

    if (analysisListenersReady) {
        return;
    }

    analysisListenersReady = true;

    const on = (id, type, fn) => {

        const el = analysisEl(id);

        if (el) {
            el.addEventListener(type, fn);
        }
    };

    on("analysisTypeSelector", "change", e => {

        if (ANALYSIS_REGISTRY[e.target.value]) {

            analysisCurrent = e.target.value;
            analysisData = null;
            analysisIndex = null;
            loadAnalysisTab();
        }
    });

    on("analysisWindowSelector", "change", e => {

        safeLocalStorageSet("analysisWindow", e.target.value);
        analysisLoadWindow(e.target.value);
    });

    on("analysisMatrix", "click", e => {

        const td = e.target.closest ? e.target.closest("td.analysisMatrixCell") : null;

        if (td) {
            analysisSelectPair(td.dataset.source, td.dataset.observer, true);
        }
    });

    for (const [id, key] of [
        ["analysisHistScope", "analysisHistScope"],
        ["analysisHistMetric", "analysisHistMetric"],
        ["analysisHistYMode", "analysisHistYMode"]
    ]) {
        on(id, "change", e => {

            safeLocalStorageSet(key, e.target.value);
            analysisRenderHistogram();
        });
    }

    on("analysisHistObserver", "change", analysisRenderHistogram);

    on("analysisPairSource", "change", e => analysisSelectPair(e.target.value, analysisPairObserver, false));
    on("analysisPairObserver", "change", e => analysisSelectPair(analysisPairSource, e.target.value, false));

    const toggle = e => {

        const box = e.target;

        if (!box || !box.classList || !box.classList.contains("analysisPairToggle")) {
            return;
        }

        const id = box.dataset.path;

        if (box.checked) {

            if (analysisPairSelected.size >= ANALYSIS_MAX_MAP_PATHS) {

                box.checked = false;

                const caption = analysisEl("analysisPairCaption");

                if (caption) {
                    caption.textContent = tl("an.mapMax", { n: ANALYSIS_MAX_MAP_PATHS });
                }

                return;
            }

            analysisPairSelected.add(id);

        } else {

            analysisPairSelected.delete(id);
        }

        const tr = box.closest("tr");

        if (tr) {
            tr.classList.toggle("analysisPairSelectedRow", box.checked);
        }

        analysisRenderPairMap();
    };

    on("analysisPairAdvertTable", "change", toggle);
    on("analysisPairSonarTable", "change", toggle);

    on("analysisPairClearMap", "click", () => {

        analysisPairSelected = new Set();

        document.querySelectorAll(".analysisPairToggle").forEach(b => {

            b.checked = false;

            const tr = b.closest("tr");

            if (tr) {
                tr.classList.remove("analysisPairSelectedRow");
            }
        });

        analysisRenderPairMap();
    });

    on("analysisRepStatus", "change", analysisRenderRepeaters);
    on("analysisRepFilter", "input", analysisRenderRepeaters);

    // il tema cambia le classi del body in un altro listener (index.html):
    // si ridisegna dopo, con i colori nuovi
    on("themeButton", "click", () => setTimeout(analysisOnThemeChange, 80));
}
