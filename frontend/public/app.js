//
// Wrapper sicuri per localStorage (code review 2026-08-20, §3.6) —
// prima nessuna delle chiamate dirette a localStorage.getItem/
// setItem in questo file (25, tutte convertite qui sotto) era
// protetta da try/catch: in modalità privata di alcuni browser (o
// con quota superata) localStorage può lanciare, interrompendo a
// metà l'handler sincrono che la contiene — spesso un event listener
// che continuerebbe con altro lavoro dopo la riga incriminata.
// getItem fallita ritorna null (stesso valore che localStorage
// ritorna per una chiave assente, così i chiamanti esistenti che già
// gestiscono "null/assente" continuano a funzionare senza modifiche
// al proprio codice); setItem fallita viene solo loggata — la
// preferenza semplicemente non persiste per questa sessione.
//
function safeLocalStorageGet(key) {

    try {
        return localStorage.getItem(key);

    } catch (err) {

        console.warn(
            `localStorage.getItem('${key}') fallito:`,
            err
        );

        return null;
    }
}

function safeLocalStorageSet(key, value) {

    try {
        localStorage.setItem(key, value);

    } catch (err) {

        console.warn(
            `localStorage.setItem('${key}') fallito:`,
            err
        );
    }
}

//
// Controllo res.ok (code review 2026-08-20, §4) — diverse fetch in
// questo file (es. /api/meshnodes, /api/nodes, /api/device_status,
// /api/neighbors/repeaters, gli endpoint "archive list") leggevano
// res.json() senza controllare prima res.ok: su un 500/404 il body
// di errore ({"error": "..."}) veniva silenziosamente interpretato
// come se fosse il payload atteso (un array o un oggetto dati),
// producendo un fallimento silenzioso a valle (es.
// sources.forEach is not a function, o una tabella vuota senza
// messaggio d'errore) invece di un errore visibile in console — a
// differenza dei fetch che già controllavano res.ok esplicitamente.
// Chiamata subito dopo ogni fetch() sprovvista del controllo.
//
function assertResOk(res) {

    if (
        !res.ok
    ) {

        throw new Error(
            `HTTP ${res.status}`
        );
    }
}

let dataCache = null;
let chart = null;
let autoRefreshTimer = null;
let meshNodes = {};
let currentRepeaterPublicKey = null;
let nodeDetailChart = null;
let nodesDataCache = [];

//
// nodesDataReady: true dal primo /api/nodes riuscito su questa tab in
// poi, mai più tornato false. Serve solo a decidere se
// loadDeviceStatus() (v. più sotto) può richiamare in sicurezza
// applyNodesFilters() quando la posizione di SRC diventa nota — se
// /api/device_status rispondesse PRIMA di /api/nodes (ordine non
// garantito, le due fetch partono insieme da loadNodesTab() senza
// await), un riapplica-filtri con nodesDataCache ancora [] letterale
// (non "nessun nodo", ma "non ancora caricato") ridisegnerebbe
// brevemente la tabella su "No nodes data available" un istante prima
// del render vero — esattamente il tipo di blink che
// docs/ARCHITECTURE.md §65 ha già eliminato altrove in questa stessa
// tab. Quando è false, il nuovo giro di applyNodesFilters() che segue
// comunque il fetch di /api/nodes dentro loadNodesTab() basta da solo
// a far comparire il filtro Distance from SRC con la posizione ormai
// nota.
//
let nodesDataReady = false;

//
// Posizione di SRC per il filtro "Distance from SRC" (Known Nodes) —
// popolata da loadDeviceStatus(), stessa fetch già usata per la
// tabella Device Status qui sopra nella tab, nessuna chiamata di rete
// aggiuntiva. null finché non nota o se il Companion non ha ancora
// fornito coordinate GPS: getNodeDistanceThresholdKm() tratta questo
// caso disattivando il filtro (nessun nodo escluso), mai come "nessun
// nodo entro il raggio".
//
let srcCoordsCache = null;

//
// Mappa Leaflet della pagina di dettaglio traccia — creata una sola
// volta (v. ensureTraceDetailMap() più sotto) e riutilizzata ad ogni
// apertura, a differenza di nodeDetailChart (Chart.js) che viene
// distrutto e ricreato ogni volta. traceDetailLayerGroup è lo strato
// svuotato e ripopolato ad ogni apertura (solo i marker dei nodi — non
// dipendono dallo zoom), mentre traceSegmentLayerGroup (segmenti +
// frecce) viene svuotato e ripopolato sia ad ogni apertura sia ad
// ogni cambio di zoom (v. renderTraceSegmentsAtCurrentZoom() più
// sotto — lo spostamento andata/ritorno è in pixel schermo, non in
// metri, quindi va ricalcolato quando lo zoom cambia). traceSegmentDefs
// è la lista "grezza" (indipendente dallo zoom) dei segmenti della
// traccia attualmente aperta, calcolata una sola volta da
// loadTraceDetail() e consumata ad ogni (ri)disegno.
//
let traceDetailMap = null;
let traceDetailLayerGroup = null;
let traceSegmentLayerGroup = null;
let traceSegmentDefs = [];
let traceArrowPane = null;

//
// Nodo attualmente aperto nella vista dettaglio — serve al listener
// del selettore periodo per sapere per quale nodo ricaricare le
// osservazioni quando l'utente cambia mese.
//
let nodeDetailCurrentPublicKey = null;

//
// Contatori di correlazione richiesta — incrementati ad ogni nuova
// fetch avviata per la relativa vista. Prima di applicare il
// risultato di una fetch (scrivere sullo stato condiviso / fare
// render) si confronta il valore catturato all'avvio con quello
// corrente: se nel frattempo è partita una fetch più recente per la
// stessa vista, il risultato è scartato anche se arriva per ultimo.
// Senza questo controllo, click/cambi rapidi (nodo, repeater,
// sorgente dati) possono far vincere la risposta più lenta invece
// di quella più recente — stessa classe di debolezza già trovata e
// corretta lato radio nel backend del Nodo (mancanza di
// correlation-id su una risorsa condivisa), qui applicata alle
// fetch invece che agli eventi mesh.
//
let dataRequestId = 0;
let nodeDetailRequestId = 0;
let neighborRequestId = 0;

//
// Stesso pattern esteso a tutte le altre funzioni che fanno fetch,
// anche quelle che popolano solo un menu a tendina invece di dati
// visualizzati come "correnti" — un secondo giro apparso dopo la
// prima code review (v. AUDIT_seconda_passata.md) aveva trovato solo
// i tre contatori sopra, lasciando fuori loadNodesTab()/
// loadDeviceStatus() (mai segnalate) e la catena archivio/snapshot
// di Neighbours (segnalata ma non ancora corretta) più cinque
// funzioni "minori". Contatori separati per non far scartare per
// errore il risultato di una fetch a una funzione che non ha nulla a
// che fare con quella in corso.
//
let nodesTabRequestId = 0;
let deviceStatusRequestId = 0;
let dataSourcesRequestId = 0;
let meshNodesRequestId = 0;
let neighborsRepeaterListRequestId = 0;
let nodeDetailArchiveListRequestId = 0;
let neighboursArchiveListRequestId = 0;
let traceDetailRequestId = 0;

/* ==========================================
   AUTO REFRESH INTERVAL

   Change ONLY this value if acquisition
   interval changes.

   15 min -> 15 * 60 * 1000
   30 min -> 30 * 60 * 1000
   60 min -> 60 * 60 * 1000
========================================== */

const AUTO_REFRESH_INTERVAL =
    5 * 60 * 1000;

/* ==========================================
   SNR COLOR THRESHOLDS

   Change ONLY these values if you want
   to adjust SNR quality levels.

   RED     : SNR < SNR_RED_LIMIT
   ORANGE  : SNR >= SNR_RED_LIMIT
             and < SNR_GREEN_LIMIT
   GREEN   : SNR >= SNR_GREEN_LIMIT
========================================== */

const SNR_RED_LIMIT =
    0;

const SNR_GREEN_LIMIT =
    4.6;

async function loadDataSources() {

    const selector =
        document.getElementById(
            "dataSourceSelector"
        );

    if (
        !selector
    ) {

        return;
    }

    const requestId =
        ++dataSourcesRequestId;

    try {

        const res =
            await fetch(
                "/api/archive/list"
            );

        assertResOk(res);

        const sources =
            await res.json();

        if (
            requestId !== dataSourcesRequestId
        ) {

            return;
        }

        selector.innerHTML =
            "";

        sources.forEach(
            source => {

                const opt =
                    document.createElement(
                        "option"
                    );

                opt.value =
                    source.id;

                opt.textContent =
                    source.label;

                selector.appendChild(
                    opt
                );
            }
        );

        const savedSource =
            safeLocalStorageGet(
                "dataSource"
            );

        if (
            savedSource
        ) {

            selector.value =
                savedSource;
        }

    }

    catch (
        err
    ) {

        if (
            requestId !== dataSourcesRequestId
        ) {

            return;
        }

        console.error(
            err
        );
    }
}

async function loadMeshNodes() {

    const requestId =
        ++meshNodesRequestId;

    try {

        const res =
            await fetch(
                "/api/meshnodes"
            );

        assertResOk(res);

        const data =
            await res.json();

        if (
            requestId !== meshNodesRequestId
        ) {

            return;
        }

        meshNodes =
            data;
    }

    catch (
        err
    ) {

        if (
            requestId !== meshNodesRequestId
        ) {

            return;
        }

        console.error(
            err
        );

        meshNodes = {};
    }
}

async function loadData() {

    const source =
        safeLocalStorageGet(
            "dataSource"
        ) || "live";

    let url =
        "/api/data";

    if (
        source !==
        "live"
    ) {

        url =
            "/api/archive/load?file=" +
            encodeURIComponent(
                source
            );
    }

    const requestId =
        ++dataRequestId;

    try {

        const res =
            await fetch(
                url
            );

        assertResOk(
            res
        );

        const data =
            await res.json();

        if (
            requestId !== dataRequestId
        ) {

            return;
        }

        dataCache =
            data;

        populatePaths();

    }

    catch (
        err
    ) {

        if (
            requestId !== dataRequestId
        ) {

            return;
        }

        console.error(
            "Error loading data:",
            err
        );

        const table =
            document.getElementById(
                "pathTable"
            );

        if (
            table
        ) {

            table.innerHTML =
                "<tr><td>Error loading data.</td></tr>";
        }
    }
}

//
// Escaping HTML per dati NON fidati prima di iniettarli in innerHTML
// (o in un attributo). Serve in particolare per adv_name/
// matched_names e ogni altro nome risolto da resolveNodeName(): sono
// stringhe scelte liberamente da un nodo mesh qualunque (chiunque sia
// in portata radio, nessuna autenticazione), quindi vanno trattate
// come contenuto potenzialmente ostile — v. code review 2026-08-20,
// §1.1 (XSS stored). Unica funzione di escaping del file: ogni punto
// che inietta un nome proveniente dalla rete in innerHTML deve
// passare da qui, così un fix futuro (es. caratteri aggiuntivi da
// escapare) si applica ovunque in un colpo solo.
//
// Adatta sia al testo di un elemento sia al valore di un attributo
// (es. data-tooltip="..."): esegue l'escape anche delle virgolette,
// che per il solo contenuto testo non servirebbe, ma non ha effetti
// collaterali e semplifica l'uso ad un'unica funzione per entrambi i
// casi.
//
function escapeHtml(value) {

    if (
        value === null ||
        value === undefined
    ) {
        return "";
    }

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

//
// Unica sorgente delle soglie colore SNR (SNR_RED_LIMIT/
// SNR_GREEN_LIMIT sopra) — sia la tabella (colorizeSnr) sia il
// grafico Chart.js (labelTextColor in renderChart) richiamano questa
// funzione invece di riportare da capo lo stesso if/else, così le
// due viste restano garantite coerenti anche se le soglie o i colori
// cambiano in futuro.
//
function snrColor(value) {

    if (
        value < SNR_RED_LIMIT
    ) {
        return "#d32f2f";
    }

    if (
        value < SNR_GREEN_LIMIT
    ) {
        return "#f57c00";
    }

    return "#2e7d32";
}

function colorizeSnr(value) {

    if (
        typeof value !== "number"
    ) {
        return value;
    }

    const color =
        snrColor(value);

    return `
        <span style="
            color:${color};
            font-weight:bold;
        ">
            ${value} dB
        </span>
    `;
}

function resolveNodeName(
    nodeId
) {

    if (
        nodeId === "SRC"
    ) {

        return "SRC";
    }

    //
    // /api/meshnodes ora restituisce {adv_name, adv_lat, adv_lon} per
    // ogni chiave invece della semplice stringa adv_name (2026-08-25,
    // v. server.js) — .adv_name qui e su matches[0] sotto, non più il
    // valore diretto. resolveNodePosition() (v. sezione TRACE DETAIL
    // più sotto) legge .adv_lat/.adv_lon dallo stesso oggetto.
    //
    if (
        meshNodes[nodeId]
    ) {

        return meshNodes[nodeId].adv_name;
    }

    const matches =
        Object.keys(
            meshNodes
        ).filter(
            key =>
                key.toLowerCase()
                   .startsWith(
                       nodeId.toLowerCase()
                   )
        );

    if (
        matches.length === 1
    ) {

        return meshNodes[
            matches[0]
        ].adv_name;
    }

    if (
        matches.length > 1
    ) {

        return "Ambiguous";
    }

    return "Unknown";
}

function buildPathTooltip(
    pathElement
) {

    const parts =
        pathElement
            .split("→")
            .map(
                p =>
                    p.trim()
            );

    if (
        parts.length !== 2
    ) {

        return pathElement;
    }

    return (
        resolveNodeName(
            parts[0]
        ) +
        " → " +
        resolveNodeName(
            parts[1]
        )
    );
}

//
// Come buildPathTooltip(), ma un tooltip INDIPENDENTE per ciascun
// elemento invece di uno unico per l'intero "X→Y" — passando sopra
// "0d28" si vede solo il nome di 0d28, sopra "8dbb" solo quello di
// 8dbb. data-tooltip (non title): il nativo del browser non ha
// equivalente touch, il tooltip vero lo gestisce initTooltips() più
// sotto. Uso HTML, quindi il chiamante deve usare il risultato come
// contenuto dell'elemento. NON usata nella callback del tooltip di
// Chart.js (quella resta su buildPathTooltip() — testo su canvas,
// nessun elemento DOM indipendente da poter agganciare a un hover
// proprio).
//
function buildPathTooltipHtml(
    pathElement
) {

    const parts =
        pathElement
            .split("→")
            .map(
                p =>
                    p.trim()
            );

    if (
        parts.length !== 2
    ) {

        return pathElement;
    }

    return (
        `<span data-tooltip="${escapeHtml(resolveNodeName(parts[0]))}">${parts[0]}</span>` +
        "→" +
        `<span data-tooltip="${escapeHtml(resolveNodeName(parts[1]))}">${parts[1]}</span>`
    );
}

//
// Motore del tooltip per gli span data-tooltip (Trace/Nodes) —
// sostituisce l'attributo title nativo, che sui dispositivi mobili
// non ha alcun equivalente (nessun concetto di hover). Event
// delegation su document invece di un listener per elemento: gli
// span sono generati dinamicamente via innerHTML, un binding diretto
// andrebbe perso ad ogni ri-render della tabella.
//
// Placement e interazione ricalcati sul tooltip Bootstrap-like di
// riferimento (push-status.js: show()/hide() agganciati a
// onmouseover/onmouseleave, tooltip ancorato all'elemento invece che
// al cursore): quello schema funziona bene anche su mobile perché i
// browser mobili, al primo tap su un elemento, sintetizzano proprio
// una sequenza mouseover→mouseout (simulazione dell'hover), senza
// bisogno di alcun handler touch dedicato. La versione precedente qui
// aggiungeva ANCHE un handler "click" per il toggle su mobile: sullo
// stesso tap, il browser genera prima il mouseover sintetico (che
// apriva il tooltip e impostava activeTarget) e poi il click sintetico
// subito dopo, che — trovando activeTarget già uguale al target —
// lo richiudeva immediatamente. Il tooltip lampeggiava e spariva
// all'istante: è la causa della scarsa usabilità su touch. Bastava
// affidarsi solo a mouseover/mouseout, come fa il riferimento, per
// evitare la corsa fra i due handler.
//
// La posizione resta ancorata al rettangolo dell'elemento (non al
// puntatore) e il tooltip viene appeso a document.body con
// position:fixed anziché come figlio in-flow dell'elemento: alcune
// tabelle (es. #pathTable) hanno overflow-y:auto con altezza
// limitata, e un tooltip assoluto annidato lì dentro verrebbe
// tagliato dal contenitore che scrolla. Restare a livello di body con
// coordinate calcolate dal target riproduce lo stesso "si apre appena
// sotto l'etichetta" del riferimento, ma senza il rischio di clipping.
//
function initTooltips() {

    let bubble = null;
    let activeTarget = null;

    function positionTooltip(target) {

        if (!bubble) {
            return;
        }

        const margin = 4;
        const targetRect = target.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();

        let left = targetRect.left;
        let top = targetRect.bottom + margin;

        if (left + bubbleRect.width > window.innerWidth - margin) {
            left = window.innerWidth - bubbleRect.width - margin;
        }

        if (left < margin) {
            left = margin;
        }

        if (top + bubbleRect.height > window.innerHeight - margin) {
            // Non c'è spazio sotto: lo si ribalta sopra l'elemento,
            // come il flip verticale del riferimento (max-width/
            // posizionamento statico che segue il flusso).
            top = targetRect.top - bubbleRect.height - margin;
        }

        bubble.style.left = left + "px";
        bubble.style.top = top + "px";
    }

    function showTooltip(target) {

        const text =
            target.getAttribute("data-tooltip");

        if (!text) {
            return;
        }

        hideTooltip();

        bubble = document.createElement("div");
        bubble.className = "tooltip-bubble";
        bubble.textContent = text;

        document.body.appendChild(bubble);

        positionTooltip(target);

        activeTarget = target;
    }

    function hideTooltip() {

        if (bubble) {
            bubble.remove();
            bubble = null;
        }

        activeTarget = null;
    }

    //
    // mouseover/mouseout invece di mouseenter/mouseleave: questi
    // ultimi non risalgono dai figli (niente bubbling), indispensabile
    // qui perché il listener è su document, non sul singolo span.
    // Come nel riferimento, sono gli UNICI due eventi da cui dipende
    // apertura/chiusura — niente handler "click" parallelo: sui
    // browser mobili il tap li sintetizza già entrambi (mouseover al
    // tocco, mouseout al tocco successivo altrove), quindi coprono
    // anche il touch senza bisogno d'altro.
    //
    document.addEventListener(
        "mouseover",
        e => {

            const target =
                e.target.closest("[data-tooltip]");

            if (target && target !== activeTarget) {
                showTooltip(target);
            }
        }
    );

    document.addEventListener(
        "mouseout",
        e => {

            const target =
                e.target.closest("[data-tooltip]");

            if (
                target &&
                target === activeTarget &&
                !target.contains(e.relatedTarget)
            ) {
                hideTooltip();
            }
        }
    );
}

initTooltips();

function populatePaths() {
const selector =
    document.getElementById(
        "pathSelector"
    );

const savedPath =
    safeLocalStorageGet(
        "selectedPath"
    );

const currentSelection =
    savedPath ||
    selector.value;

selector.innerHTML = "";

Object.keys(
    dataCache.paths
).forEach(p => {

    const opt =
        document.createElement(
            "option"
        );

    opt.value = p;
    opt.textContent = p;

    selector.appendChild(
        opt
    );
});

if (
    currentSelection &&
    dataCache.paths[
        currentSelection
    ]
) {

    selector.value =
        currentSelection;
}

//
// BUG RISOLTO (segnalato dall'utente su Collettore, stesso difetto
// presente identico anche qui): questa funzione scriveva sempre
// "selectedPath" col valore risultante — anche quando currentSelection
// era solo un fallback (il path salvato non esisteva più nella lista
// corrente, es. cambio sorgente dati), sovrascrivendo così una scelta
// esplicita dell'utente con un valore scelto automaticamente. La
// persistenza della scelta esplicita è già gestita dal listener
// "change" di pathSelector qui sotto — populatePaths() ora legge
// soltanto, non scrive mai.
//

updateView();
}

function updateView() {

    const key =
        document.getElementById(
            "pathSelector"
        ).value;

    const data =
        dataCache.paths[key];

    renderTable(
        data.pathObservations,
        key
    );

    renderStats(
        data.linkStats
    );

    renderChart(
        data.linkSeries
    );
}

/* =========================
   TABLE
========================= */

function renderTable(rows, pathKey) {

    const table =
        document.getElementById(
            "pathTable"
        );

    if (
        !rows ||
        rows.length === 0
    ) {

        //
        // Allineato allo stile "spiega il perché" già usato da
        // Repeaters (renderNeighboursTable/renderNeighborData) e da
        // Device Status (renderDeviceStatusTable): prima di questa
        // modifica qui si azzerava silenziosamente la tabella
        // (v. docs/ARCHITECTURE.md §65). Nessun colspan: a differenza
        // delle tabelle a colonne fisse, qui le colonne dipendono dal
        // path selezionato e non sono note quando non ci sono righe.
        //
        table.innerHTML =
            "<tr><td>No trace data available for this path.</td></tr>";
        return;
    }

    const cols =
        Object.keys(
            rows[0]
        );

    let html =
        "<tr>";

    cols.forEach(
        c => {
            if (
                c.includes(
                    "→"
                )
            ) {
                html +=
                    `<th>${buildPathTooltipHtml(c)}</th>`;
            }
            else {
                html +=
                    `<th>${c}</th>`;
            }
        }
    );

    html += "</tr>";

    rows.forEach(
        (r, rowIndex) => {

            html +=
                "<tr>";

            cols.forEach(
                c => {

                    let value =
                        r[c] ??
                        "";

                    if (
                        c ===
                        "status"
                    ) {

                        if (
                            value ===
                            "OK"
                        ) {

                            value =
                                '<span style="color:green;font-weight:bold;">OK</span>';
                        }

                        else if (
                            value ===
                            "TIMEOUT"
                        ) {

                            value =
                                '<span style="color:red;font-weight:bold;">TIMEOUT</span>';
                        }
                    }

                    if (
                       typeof value ===
                       "number"
                   ) {

                       value =
                           colorizeSnr(
                               value
                           );
                   }

                    //
                    // Colonna timestamp -> link cliccabile verso la
                    // pagina di dettaglio traccia (mappa + segmenti,
                    // v. sezione TRACE DETAIL più sotto). data-row-
                    // index invece di incorporare l'intera riga nel
                    // DOM: il click handler subito sotto la recupera
                    // da "rows" per closure — stesso schema già usato
                    // da renderNodesTable() con data-key su .nodeLink
                    // (v. goToNodeDetail()). Il valore del timestamp
                    // non viene mai passato attraverso innerHTML come
                    // dato esterno: è generato da formatTimestamp()
                    // (parser.js) da sole cifre/separatori, non serve
                    // escapeHtml().
                    //
                    if (
                        c ===
                        "timestamp"
                    ) {

                        value =
                            `<a href="#" class="traceLink" data-row-index="${rowIndex}">${value}</a>`;
                    }

                    html +=
                       `<td>${value}</td>`;

                }
            );

            html +=
                "</tr>";
        }
    );

    table.innerHTML =
        html;

    table.querySelectorAll(
        ".traceLink"
    ).forEach(
        link => {

            link.addEventListener(
                "click",
                (e) => {

                    e.preventDefault();

                    goToTraceDetail(
                        rows[
                            Number(
                                link.dataset.rowIndex
                            )
                        ],
                        pathKey
                    );
                }
            );
        }
    );
}

/* =========================
   STATS
========================= */

function renderStats(
    stats
) {

    const table =
        document.getElementById(
            "statsTable"
        );

    let html =
        "<tr><th>Path Element</th><th>Avg</th><th>Min</th><th>Max</th></tr>";

    //
    // Allineato allo stile Repeaters (renderNeighboursTable): header
    // sempre presente, riga esplicita con colspan quando non ci sono
    // dati, invece di azzerare silenziosamente la tabella
    // (v. docs/ARCHITECTURE.md §65). "stats" nullo viene trattato come
    // nessuna entry, stesso messaggio.
    //
    const entries =
        stats
            ? Object.entries(
                  stats
              )
            : [];

    entries.forEach(
        ([k, v]) => {

            const avg =
                v.count
                    ? (
                        v.sum /
                        v.count
                    ).toFixed(
                        2
                    )
                    : 0;

            html += `
            <tr>
               <td>
                   ${buildPathTooltipHtml(k)}
               </td>
               <td>${colorizeSnr(Number(avg))}</td>
               <td>${colorizeSnr(v.min)}</td>
               <td>${colorizeSnr(v.max)}</td>
            </tr>`;
        }
    );

    if (
        entries.length === 0
    ) {

        html += "<tr><td colspan=\"4\">No stats data available.</td></tr>";
    }

    table.innerHTML =
        html;
}

/* =========================
   CHART
========================= */

function renderChart(
    linkSeries
) {

    if (
        chart
    ) {

        chart.destroy();

        chart = null;
    }

    const range =
        safeLocalStorageGet(
            "chartRange"
        ) ||
        "all";

    const now =
        Date.now();

    let limit =
        0;

    if (
        range ===
        "24h"
    )
        limit =
            24 *
            3600 *
            1000;

    if (
        range ===
        "3d"
    )
        limit =
            3 *
            24 *
            3600 *
            1000;

    if (
        range ===
        "7d"
    )
        limit =
            7 *
            24 *
            3600 *
            1000;

    const darkMode =
        document.body.classList.contains(
            "dark"
        );

    const tickColor =
        darkMode
            ? "#dddddd"
            : "#444444";

    const gridColor =
        darkMode
            ? "rgba(255,255,255,0.15)"
            : "rgba(0,0,0,0.10)";

    const datasets =
        [];

    let observations =
        0;

    for (
        const [
            label,
            series
        ] of Object.entries(
            linkSeries ||
            {}
        )
    ) {

        const data =
            [];

        for (
            const p of
            series
        ) {

            if (
                !p ||
                typeof p.y !==
                    "number" ||
                !p.x
            )
                continue;

            const [
                datePart,
                timePart
            ] =
                p.x.split(
                    " "
                );

            const [
                d,
                m,
                y
            ] =
                datePart.split(
                    "/"
                );

            const iso =
                `${y}-${m}-${d}T${timePart}:00`;

            const t =
                new Date(
                    iso
                ).getTime();

            if (
                isNaN(
                    t
                )
            )
                continue;

            if (
                limit > 0 &&
                t < now - limit
            )
                continue;

            data.push(
                {
                    x: t,
                    y: p.y
                }
            );
        }

        if (
            data.length >
            observations
        ) {

            observations =
                data.length;
        }

        if (
            data.length ===
            0
        )
            continue;

        data.sort(
            (
                a,
                b
            ) =>
                a.x -
                b.x
        );

        datasets.push(
            {

                label,

                data,

                borderWidth:
                    2,

                tension:
                    0.2,

                pointRadius:
                    2
            }
        );
    }

    document.getElementById(
        "rangeInfo"
    ).textContent =
        `Showing ${observations} observations`;

    const ctx =
        document.getElementById(
            "snrChart"
        );

    chart =
        new Chart(
            ctx,
            {
                type:
                    "line",

                data: {
                    datasets
                },

                options:
                    {

                        responsive:
                            true,

                        maintainAspectRatio:
                            false,

                        parsing:
                            false,

                        scales:
                            {

                                x:
                                    {

                                        type:
                                            "linear",

                                        ticks:
                                            {

                                                color:
                                                    tickColor,

                                                callback:
                                                    function (
                                                        value
                                                    ) {

                                                        return formatDateShort(
                                                            new Date(
                                                                value
                                                            )
                                                        );
                                                    },

                                                maxTicksLimit:
                                                    6
                                            },

                                        grid:
                                            {
                                                color:
                                                    gridColor
                                            }
                                    },

                                y:
                                    {

                                        ticks:
                                            {
                                                color:
                                                    tickColor
                                            },

                                        grid:
                                            {
                                                color:
                                                    gridColor
                                            },

                                        title:
                                            {

                                                display:
                                                    true,

                                                text:
                                                    "SNR",

                                                color:
                                                    tickColor
                                            }
                                    }
                            },

                        plugins:
                            {

                                legend:
                                    {

                                        labels:
                                            {

                                                color:
                                                    tickColor
                                            }
                                    },

                                tooltip:
                                    {

                                        callbacks:
                                            {

                                                title:
                                                    function (
                                                        context
                                                    ) {

                                                        const t =
                                                            context[
                                                                0
                                                            ]
                                                                .parsed
                                                                .x;

                                                        return formatDateFull(
                                                            new Date(
                                                                t
                                                            )
                                                        );
                                                    },

                                                label:
                                                    function (
                                                        context
                                                    ) {

                                                        return `${buildPathTooltip(
                                                                    context.dataset.label
                                                                )}: ${context.parsed.y} dB`;
                                                    }
                                            },

                                            labelTextColor:
                                                function (
                                                    context
                                                ) {

                                                    return snrColor(
                                                        context.parsed.y
                                                    );
                                                }
                                    }
                            }
                    }
            }
        );
}

/* =========================
   TRACE DETAIL (mappa)

   Vedi claude/analisi-fattibilita-mappa-dettaglio-traccia-2026-08-25.md
   per l'analisi di fattibilità completa. Pagina di dettaglio aperta
   cliccando il timestamp di una riga in Scheduled Trace-Path
   (renderTable() sopra): mostra su una mappa Leaflet i marker dei
   nodi coinvolti nella traccia (SRC + repeater del percorso) e un
   segmento con freccia per ciascun hop, colorato/etichettato con lo
   stesso SNR già mostrato in tabella.

   Nessuna nuova chiamata di rete per i dati della traccia stessa: la
   riga cliccata (con tutte le sue chiavi "X→Y") è già interamente
   presente in dataCache (v. updateView()/renderTable()), sia essa
   stata popolata da /api/data (live) sia da /api/archive/load (mese
   archiviato) — la pagina di dettaglio funziona quindi identica in
   entrambi i casi senza bisogno di sapere da quale delle due
   provenga. L'unica fetch qui è verso /api/device_status, per la
   posizione del nodo locale (SRC): quella non è mai in dataCache (non
   fa parte di trace.json) e va presa "live" indipendentemente dal
   fatto che la traccia visualizzata sia di un mese archiviato —
   coerente con l'assenza di uno storico posizioni in contacts.db (i
   record vengono aggiornati sul posto, non archiviati): è comunque
   impossibile mostrare la posizione "storica" di un repeater per una
   traccia vecchia, solo quella CORRENTE è disponibile, per SRC come
   per ogni altro nodo. Nota nota esplicitamente all'utente in fase di
   analisi, non una scelta implementativa silenziosa.
========================= */

//
// resolveNodePosition() — variante di resolveNodeName() (sopra) che
// restituisce la posizione invece del nome. Logica di prefix-matching
// duplicata volutamente invece di fattorizzata in un helper comune:
// resolveNodeName() ha già molti chiamanti esistenti (tooltip
// Trace/Nodes) che non hanno nulla a che fare con la posizione; un
// refactor condiviso avrebbe un raggio di impatto più ampio di quanto
// serva per questa sola funzionalità.
//
// Ritorna sempre { status, lat?, lon? }:
//   "src"         — nodeId === "SRC" (nessuna lat/lon qui: la
//                   posizione di SRC arriva da /api/device_status,
//                   non da meshNodes — v. loadTraceDetail()).
//   "ok"          — un solo nodo risolto, con adv_lat/adv_lon
//                   entrambi non nulli.
//   "no-position" — nodo risolto in modo univoco ma senza posizione
//                   nota in contacts.db (mai ricevuto un advert con
//                   GPS, o Companion/nodo senza fix).
//   "ambiguous"   — più public_key iniziano con lo stesso prefisso
//                   (stesso caso limite già gestito da
//                   resolveNodeName()).
//   "unknown"     — nessun nodo trovato in meshNodes.
//
function resolveNodePosition(
    nodeId
) {

    if (
        nodeId === "SRC"
    ) {

        return { status: "src" };
    }

    const entry =
        meshNodes[nodeId];

    if (
        entry
    ) {

        if (
            entry.adv_lat != null &&
            entry.adv_lon != null
        ) {

            return {
                status: "ok",
                lat: entry.adv_lat,
                lon: entry.adv_lon
            };
        }

        return { status: "no-position" };
    }

    const matches =
        Object.keys(
            meshNodes
        ).filter(
            key =>
                key.toLowerCase()
                   .startsWith(
                       nodeId.toLowerCase()
                   )
        );

    if (
        matches.length === 1
    ) {

        const match =
            meshNodes[
                matches[0]
            ];

        if (
            match.adv_lat != null &&
            match.adv_lon != null
        ) {

            return {
                status: "ok",
                lat: match.adv_lat,
                lon: match.adv_lon
            };
        }

        return { status: "no-position" };
    }

    if (
        matches.length > 1
    ) {

        return { status: "ambiguous" };
    }

    return { status: "unknown" };
}

//
// Etichetta SNR per i segmenti sulla mappa — stessa palette
// rosso/verde già usata da colorizeSnr() (celle numeriche della
// tabella) e dallo status TIMEOUT (span rosso in renderTable()),
// riportata identica qui invece di introdurre una seconda scala
// colori per la stessa informazione.
//
function traceSegmentLabelHtml(
    value
) {

    if (
        value === "TIMEOUT"
    ) {

        return '<span style="color:red;font-weight:bold;">TIMEOUT</span>';
    }

    if (
        typeof value === "number"
    ) {

        return colorizeSnr(
            value
        );
    }

    return escapeHtml(
        String(
            value
        )
    );
}

//
// Spostamento perpendicolare in PIXEL SCHERMO (non metri/gradi),
// ricalcolato ad ogni cambio di zoom della mappa (v.
// renderTraceSegmentsAtCurrentZoom() più sotto e il listener
// "zoomend" registrato in ensureTraceDetailMap()).
//
// Corregge un difetto della prima versione di questa funzionalità
// (v. CHANGES_mappa_dettaglio_traccia.md), segnalato dall'utente il
// 2026-08-25 dopo aver usato la funzionalità dal vivo: uno
// spostamento fisso in METRI (la versione precedente, 8m) produce una
// separazione visiva che dipende dallo zoom — impercettibile a zoom
// "da rete" (l'utente doveva zoomare molto per notarla, poi tornare
// indietro per muoversi), enorme a zoom "da strada" — perché la scala
// metri/pixel della mappa cambia con lo zoom. Era esattamente il
// problema che l'analisi di fattibilità originale aveva previsto e
// per cui raccomandava uno spostamento in pixel, non in gradi/metri
// (§3.4, claude/analisi-fattibilita-mappa-dettaglio-traccia-2026-08-25.md:
// "uno scostamento fisso in gradi di lat/lon apparirebbe invece enorme
// a zoom alto e invisibile a zoom basso") — raccomandazione non
// applicata nella prima implementazione. map.project(latlng, zoom) /
// map.unproject(point, zoom) proiettano in coordinate pixel "di
// mondo" per uno zoom esplicito, indipendenti dal pan/centro corrente
// della vista: uno spostamento calcolato lì resta quindi visivamente
// costante in pixel su schermo a qualunque zoom, MA deve essere
// ricalcolato ogni volta che lo zoom cambia (un valore calcolato una
// sola volta e poi fissato in lat/lng tornerebbe ad essere, di fatto,
// uno spostamento a dimensione fissa sul terreno — lo stesso difetto
// da cui si parte).
//
// "sign" vale 0 (nessuno spostamento: segmento disegnato sulla sua
// vera geodetica) oppure 1 (spostato di TRACE_SEGMENT_OFFSET_PIXELS
// sul lato determinato dalla direzione from->to). Il chiamante
// (renderTraceSegmentsAtCurrentZoom()) passa sempre latlng1/latlng2
// nell'ordine naturale from/to del segmento (mai scambiati): per due
// segmenti che percorrono lo stesso collegamento fisico in direzioni
// opposte ("A→B" e "B→A"), l'inversione naturale di from/to fra
// andata e ritorno ribalta GIÀ DA SOLA il lato dello spostamento
// (identità vettoriale: ruotare di 90° il vettore invertito -(dx,dy)
// dà il perpendicolare opposto a quello di (dx,dy)) — è per questo
// che "sign" non deve MAI valere -1: un'inversione esplicita del
// segno, sommata a quella naturale, le annullerebbe a vicenda
// riportando andata e ritorno sulla stessa linea (bug trovato e
// corretto in fase di test contro dati reali, v.
// CHANGES_mappa_dettaglio_traccia.md) invece di separarle come
// richiesto esplicitamente dall'utente il 2026-08-23 (sovrapposizione
// dei segmenti andata/ritorno).
//
const TRACE_SEGMENT_OFFSET_PIXELS = 6;

//
// Scostamento AGGIUNTIVO (oltre a TRACE_SEGMENT_OFFSET_PIXELS sopra)
// applicato solo all'etichetta SNR permanente di un segmento
// (.traceSegmentLabel), nella STESSA direzione perpendicolare della
// linea a cui è agganciata — v. l'uso di "perpUnit" in
// renderTraceSegmentsAtCurrentZoom() più sotto. Corregge un difetto
// segnalato dall'utente il 2026-08-25 (con screenshot) su due
// segmenti andata/ritorno paralleli: l'etichetta di un
// L.polyline con bindTooltip({direction:"center"}) è centrata
// ESATTAMENTE sul punto medio della linea — con le due linee separate
// di soli TRACE_SEGMENT_OFFSET_PIXELS*2 = 12px (v. sopra) ma i box
// delle etichette larghi ~65-75px (testo breve tipo "-5.5 dB"/
// "TIMEOUT" a 11px bold, v. .traceSegmentLabel in style.css), i due
// box finiscono quasi interamente sovrapposti: si vede un unico
// blocco di testo illeggibile invece di due valori distinti — non un
// problema di posizione dei punti di ancoraggio (già correttamente
// separati), ma delle dimensioni del box rispetto a quella
// separazione. 30px aggiuntivi per lato (60px totali fra le due
// etichette, oltre ai 12px già dati dallo scostamento della linea)
// coprono il caso peggiore (segmento quasi verticale a schermo, dove
// lo scostamento perpendicolare è quasi tutto orizzontale — l'asse in
// cui il box è più largo) senza allontanare eccessivamente
// l'etichetta dalla propria linea negli altri casi. Applicato solo
// quando sign!=0 (esiste un ritorno nella stessa traccia, quindi una
// seconda linea con cui l'etichetta potrebbe altrimenti sovrapporsi):
// un segmento senza ritorno resta com'era, centrato sulla propria
// (unica) linea. Nessun ricalcolo extra ad ogni zoom necessario: è
// l'opzione "offset" di L.Tooltip, sempre espressa in pixel schermo
// fissi rispetto al punto di ancoraggio — la stessa proprietà di
// "costanza in pixel indipendente dallo zoom" di
// TRACE_SEGMENT_OFFSET_PIXELS, qui ottenuta gratuitamente perché
// Leaflet applica l'offset al momento del disegno, non del calcolo
// delle coordinate.
//
const TRACE_SEGMENT_LABEL_OFFSET_PIXELS = 30;

function offsetSegmentPixels(
    map,
    zoom,
    latlng1,
    latlng2,
    sign
) {

    const p1 =
        map.project(
            [latlng1.lat, latlng1.lng],
            zoom
        );

    const p2 =
        map.project(
            [latlng2.lat, latlng2.lng],
            zoom
        );

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    //
    // "|| 1" evita una divisione per zero quando i due estremi
    // coincidono esattamente (caso limite: due nodi colocati alla
    // stessa posizione GPS, es. un repeater fisicamente accanto al
    // Companion). Con lunghezza 0 anche lo spostamento risultante è 0
    // (dx/dy sono già 0), quindi il segmento resta degenere ma non
    // produce NaN/Infinity; renderTraceSegmentsAtCurrentZoom() salta
    // il disegno delle frecce in questo caso (il bearing non è
    // definito fra due punti coincidenti).
    //
    const len =
        Math.sqrt(dx * dx + dy * dy) ||
        1;

    //
    // Vettore perpendicolare UNITARIO (non ancora scalato da
    // TRACE_SEGMENT_OFFSET_PIXELS né da "sign"): restituito al
    // chiamante insieme alle coordinate offset perché
    // renderTraceSegmentsAtCurrentZoom() lo riusa per spostare anche
    // l'etichetta SNR (v. TRACE_SEGMENT_LABEL_OFFSET_PIXELS sopra),
    // nella stessa identica direzione della linea — senza doverlo
    // ricalcolare da capo (stesso dx/dy/len già disponibili qui).
    //
    const perpUnitX = -dy / len;
    const perpUnitY = dx / len;

    const perpX =
        perpUnitX *
        TRACE_SEGMENT_OFFSET_PIXELS *
        sign;

    const perpY =
        perpUnitY *
        TRACE_SEGMENT_OFFSET_PIXELS *
        sign;

    const o1 =
        map.unproject(
            [p1.x + perpX, p1.y + perpY],
            zoom
        );

    const o2 =
        map.unproject(
            [p2.x + perpX, p2.y + perpY],
            zoom
        );

    return {
        latlngs: [
            [o1.lat, o1.lng],
            [o2.lat, o2.lng]
        ],
        perpUnit: { x: perpUnitX, y: perpUnitY },
        lengthPixels: len
    };
}

//
// Rotta iniziale (bearing) fra due punti [lat,lon] in gradi, 0-360 —
// formula standard great-circle, usata solo per orientare la freccia
// dell'arrowhead di ciascun segmento (v. loadTraceDetail()). 0° = Nord,
// crescente in senso orario — stessa convenzione di rotazione oraria
// di CSS transform:rotate() con angoli positivi, applicata senza
// conversioni in .traceArrowIcon (style.css).
//
function bearingDegrees(
    latlng1,
    latlng2
) {

    const lat1 =
        latlng1[0] * Math.PI / 180;

    const lat2 =
        latlng2[0] * Math.PI / 180;

    const dLon =
        (latlng2[1] - latlng1[1]) *
        Math.PI / 180;

    const y =
        Math.sin(dLon) *
        Math.cos(lat2);

    const x =
        Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) *
            Math.cos(dLon);

    return (
        Math.atan2(y, x) *
            180 / Math.PI +
        360
    ) % 360;
}

//
// Ogni segmento disegna DUE frecce, non una sola (richiesta esplicita
// dell'utente il 2026-08-25, rappresentata con l'ASCII
// "----->---->" invece di "------>-------"): una "a metà" percorso
// (ARROW_MID_T, v. renderTraceSegmentsAtCurrentZoom() più sotto) e una
// vicino alla destinazione (ARROW_END_T lì sotto). Lo scopo della
// seconda è poter guardare il marker di un nodo e capire subito, senza
// dover seguire l'intero segmento, quali collegamenti ARRIVANO a quel
// nodo (freccia appena fuori dal marker) e quali invece PARTONO da lui
// (nessuna freccia in quel punto, solo l'inizio della linea) — utile
// in particolare quando più segmenti convergono/divergono sullo stesso
// nodo.
//
// TRACE_ARROW_END_BACKOFF_PIXELS: distanza in pixel schermo (non in
// gradi/metri, stessa logica "costante a schermo indipendentemente
// dallo zoom" di TRACE_SEGMENT_OFFSET_PIXELS) fra la punta della
// freccia "di arrivo" e il centro del marker di destinazione — un
// valore fisso in "t" (frazione del segmento) sarebbe invece arbitrario:
// a seconda della lunghezza reale del segmento e dello zoom finirebbe
// ora dentro il marker (segmento corto/zoom alto), ora troppo lontano
// da esso per leggersi come "in arrivo" (segmento lungo/zoom basso).
// 18px è poco più del raggio dell'icona del marker (16px, v.
// TRACE_SRC_ICON/TRACE_REPEATER_ICON più sotto, iconSize 32x32): la
// freccia resta quindi appena fuori dal cerchio del marker, non
// sovrapposta.
//
// TRACE_ARROW_MIN_SEPARATION_PIXELS: distanza minima in pixel, oltre
// ARROW_MID_T, sotto la quale la freccia "di arrivo" non scende MAI —
// evita che le due frecce si sovrappongano fra loro sui segmenti molto
// corti a schermo (due nodi vicini, o zoom molto basso), dove seguire
// solo TRACE_ARROW_END_BACKOFF_PIXELS potrebbe altrimenti posizionare
// la freccia "di arrivo" PRIMA di quella "a metà".
//
const TRACE_ARROW_END_BACKOFF_PIXELS = 18;
const TRACE_ARROW_MIN_SEPARATION_PIXELS = 16;

//
// Crea e aggiunge un marker-freccia (icona CSS a triangolo, v.
// .traceArrowIcon in style.css) alla posizione "t" (0 = "from", 1 =
// "to") lungo il segmento "offset" (i due estremi [lat,lon] GIÀ
// spostati da offsetSegmentPixels() — non i punti veri del segmento),
// con l'orientamento "bearing" e il colore del segmento. Estratta come
// funzione a sé (invece di duplicare la creazione della divIcon)
// perché renderTraceSegmentsAtCurrentZoom() la richiama due volte per
// ogni segmento — v. il commento sopra.
//
function addTraceArrowMarker(
    offset,
    bearing,
    color,
    t
) {

    const lat =
        offset[0][0] +
        (offset[1][0] - offset[0][0]) *
            t;

    const lon =
        offset[0][1] +
        (offset[1][1] - offset[0][1]) *
            t;

    const arrowIcon =
        L.divIcon(
            {
                className: "traceArrowIconWrapper",
                html:
                    `<div class="traceArrowIcon" style="border-bottom-color:${color};transform:rotate(${bearing}deg);"></div>`,
                iconSize: [14, 12],
                iconAnchor: [7, 6]
            }
        );

    L.marker(
        [lat, lon],
        {
            icon: arrowIcon,
            interactive: false,
            pane: "traceArrowPane"
        }
    ).addTo(
        traceSegmentLayerGroup
    );
}

//
// Ridisegna segmenti + frecce di direzione usando lo zoom CORRENTE
// della mappa. traceSegmentDefs è la lista "grezza" (indipendente
// dallo zoom) calcolata una sola volta da loadTraceDetail() per la
// traccia attualmente aperta — questa funzione la consuma e basta,
// non tocca mai i dati della traccia. Richiamata subito dopo
// map.fitBounds() in loadTraceDetail() e ad ogni evento "zoomend"
// (listener registrato una sola volta in ensureTraceDetailMap(), v.
// sotto): è quest'ultima chiamata che rende lo spostamento
// andata/ritorno visivamente costante in pixel a qualunque zoom (v.
// offsetSegmentPixels() sopra) — ricalcolarlo una volta sola alla
// zoom "di apertura" e poi lasciarlo fisso in lat/lng vanificherebbe
// lo scopo. Non tocca traceDetailLayerGroup (i marker dei nodi, che
// non dipendono dallo zoom): solo traceSegmentLayerGroup viene
// svuotato e ripopolato, così uno zoom dell'utente non richiede di
// ricreare anche i marker.
//
function renderTraceSegmentsAtCurrentZoom() {

    if (
        !traceDetailMap ||
        !traceSegmentLayerGroup
    ) {

        return;
    }

    traceSegmentLayerGroup.clearLayers();

    const zoom =
        traceDetailMap.getZoom();

    traceSegmentDefs.forEach(
        def => {

            const offsetResult =
                offsetSegmentPixels(
                    traceDetailMap,
                    zoom,
                    def.latlngFrom,
                    def.latlngTo,
                    def.sign
                );

            const offset =
                offsetResult.latlngs;

            //
            // Sposta anche l'etichetta SNR, non solo la linea (v.
            // TRACE_SEGMENT_LABEL_OFFSET_PIXELS sopra) — stessa
            // direzione perpendicolare della linea (offsetResult.
            // perpUnit), stesso "sign" (0 = nessun ritorno in questa
            // traccia, quindi nessuna seconda linea/etichetta con cui
            // potrebbe sovrapporsi: offset [0,0], invariato rispetto a
            // prima).
            //
            const labelOffset = [
                offsetResult.perpUnit.x *
                    TRACE_SEGMENT_LABEL_OFFSET_PIXELS *
                    def.sign,
                offsetResult.perpUnit.y *
                    TRACE_SEGMENT_LABEL_OFFSET_PIXELS *
                    def.sign
            ];

            L.polyline(
                offset,
                {
                    color: def.color,
                    weight: 3,
                    dashArray: def.dashArray
                }
            ).bindTooltip(
                def.labelHtml,
                {
                    permanent: true,
                    direction: "center",
                    className: "traceSegmentLabel",
                    offset: labelOffset
                }
            ).addTo(
                traceSegmentLayerGroup
            );

            //
            // Nessuna freccia su un segmento degenere (v.
            // offsetSegmentPixels(): from/to sulla stessa posizione):
            // il bearing non è definito quando i due estremi
            // coincidono.
            //
            if (
                def.isDegenerate
            ) {

                return;
            }

            const bearing =
                bearingDegrees(
                    offset[0],
                    offset[1]
                );

            //
            // Freccia "a metà" (v. addTraceArrowMarker() più sopra):
            // al 70% del segmento, non esattamente al centro, per non
            // sovrapporsi all'etichetta SNR permanente — che resta
            // agganciata al centro geometrico della linea
            // (bindTooltip/direction:"center" più sopra) anche se ora
            // spostata di lato via "offset" (labelOffset), quindi la
            // convivenza fra le due non è più stretta come nella
            // prima versione, ma il 70% resta comunque un buon punto
            // "di lettura" intermedio per chi guarda il segmento nel
            // suo complesso.
            //
            const ARROW_MID_T = 0.7;

            addTraceArrowMarker(
                offset,
                bearing,
                def.color,
                ARROW_MID_T
            );

            //
            // Freccia "di arrivo", vicino a "to" (v. il commento su
            // addTraceArrowMarker() più sopra per il perché di questa
            // seconda freccia). desiredEndT: a
            // TRACE_ARROW_END_BACKOFF_PIXELS di distanza fissa da "to".
            // minEndT: mai più vicina di TRACE_ARROW_MIN_SEPARATION_PIXELS
            // oltre ARROW_MID_T, per non sovrapporsi alla freccia "a
            // metà" sui segmenti corti a schermo. 0.98 come tetto:
            // mai esattamente su "to" (sovrapporrebbe la freccia al
            // marker stesso) nemmeno quando entrambi i vincoli sopra
            // spingerebbero oltre.
            //
            const desiredEndT =
                1 -
                TRACE_ARROW_END_BACKOFF_PIXELS /
                    offsetResult.lengthPixels;

            const minEndT =
                ARROW_MID_T +
                TRACE_ARROW_MIN_SEPARATION_PIXELS /
                    offsetResult.lengthPixels;

            const ARROW_END_T =
                Math.min(
                    0.98,
                    Math.max(
                        desiredEndT,
                        minEndT
                    )
                );

            addTraceArrowMarker(
                offset,
                bearing,
                def.color,
                ARROW_END_T
            );
        }
    );
}

//
// Icone personalizzate per i marker SRC/repeater, al posto del pin blu
// di default di Leaflet — grafiche fornite dall'utente (2026-08-25,
// screenshot ripuliti dallo sfondo della mappa d'origine e ritagliati
// su un cerchio trasparente). iconAnchor al CENTRO del cerchio
// (16,16 su 32x32), non alla punta inferiore come il pin di default:
// questi sono badge circolari, non pin appuntiti — il centro del
// cerchio è il punto che deve coincidere con la coordinata lat/lon,
// non il bordo inferiore. iconRetinaUrl usa la variante -2x già
// preparata, stesso schema del pin di default di Leaflet
// (marker-icon.png/marker-icon-2x.png in vendor/leaflet/images/).
//
const TRACE_SRC_ICON =
    L.icon(
        {
            iconUrl: "images/markers/src.png",
            iconRetinaUrl: "images/markers/src-2x.png",
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            popupAnchor: [0, -16]
        }
    );

const TRACE_REPEATER_ICON =
    L.icon(
        {
            iconUrl: "images/markers/repeater.png",
            iconRetinaUrl: "images/markers/repeater-2x.png",
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            popupAnchor: [0, -16]
        }
    );

//
// Mappa Leaflet creata UNA VOLTA sola e riutilizzata ad ogni apertura
// del dettaglio (clearLayers() su traceDetailLayerGroup invece di
// distruggere/ricreare la mappa) — a differenza di nodeDetailChart
// (Chart.js), distrutto e ricreato ad ogni rendering
// (renderNodeDetailChart(): "nodeDetailChart.destroy()" seguito da
// "new Chart(...)"). Le due librerie hanno costi opposti per questa
// operazione: Chart.js ricrea un <canvas> in pochi millisecondi senza
// alcuna richiesta di rete, mentre un L.map() nuovo comporterebbe uno
// scaricamento ex novo delle tile OpenStreetMap dal server remoto ad
// ogni apertura — inutile e più lento, dato che la view (centro/zoom)
// e le tile già scaricate restano valide fra un'apertura e l'altra
// dello stesso pannello.
//
function ensureTraceDetailMap() {

    if (
        traceDetailMap
    ) {

        return traceDetailMap;
    }

    traceDetailMap =
        L.map(
            "traceDetailMap"
        ).setView(
            [0, 0],
            2
        );

    //
    // Tile OpenStreetMap standard, scaricate dinamicamente da
    // Internet ad ogni pan/zoom effettuato dall'utente — nessuna tile
    // pre-scaricata o servita dal Nodo stesso, per decisione esplicita
    // del 2026-08-25 ("Deve essere un'operazione dinamica via internet
    // [...] non voglio precaricare sul server tutti i pezzi di mappa
    // possibili"). Attribuzione riportata come richiesto dalla Tile
    // Usage Policy di OpenStreetMap.
    //
    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            maxZoom: 19,
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
        }
    ).addTo(
        traceDetailMap
    );

    traceDetailLayerGroup =
        L.layerGroup().addTo(
            traceDetailMap
        );

    //
    // Strato SEPARATO per segmenti+frecce (traceDetailLayerGroup resta
    // solo per i marker dei nodi): svuotato e ripopolato da
    // renderTraceSegmentsAtCurrentZoom(), sia subito dopo ogni
    // apertura di una traccia sia ad ogni "zoomend" (v. il listener
    // poco sotto) — separarlo da traceDetailLayerGroup evita di dover
    // ricreare anche i marker dei nodi (costosi, invariati con lo
    // zoom) ogni volta che cambia solo il livello di zoom.
    //
    traceSegmentLayerGroup =
        L.layerGroup().addTo(
            traceDetailMap
        );

    //
    // Pane dedicato alle frecce di direzione, con z-index PIÙ ALTO
    // del tooltipPane nativo di Leaflet (650) — bug reale trovato
    // testando in un browser vero (v.
    // docs/CHANGES_mappa_dettaglio_traccia.md): l'etichetta SNR
    // permanente di ogni segmento (bindTooltip su L.polyline) e la
    // freccia di quello stesso segmento condividono lo stesso punto
    // (il centro del segmento), ma il tooltipPane di Leaflet sta SOPRA
    // il markerPane di default (600) dove finiva la freccia — risultato,
    // l'etichetta (con il proprio sfondo opaco) copriva completamente
    // la freccia sottostante, invisibile pur essendo disegnata
    // correttamente. Un pane proprio, sopra ENTRAMBI (markerPane e
    // tooltipPane), risolve senza toccare lo z-index nativo di
    // Leaflet — che resta invariato per marker/tooltip di uso normale.
    // pointerEvents:none coerente con interactive:false già impostato
    // su ciascun marker-freccia: sono un indicatore puramente visivo,
    // non devono intercettare click/hover destinati alla mappa
    // sottostante.
    //
    traceArrowPane =
        traceDetailMap.createPane(
            "traceArrowPane"
        );

    traceArrowPane.style.zIndex = 660;
    traceArrowPane.style.pointerEvents = "none";

    //
    // Ricalcola lo spostamento pixel andata/ritorno ad ogni cambio di
    // zoom dell'utente (v. offsetSegmentPixels()/
    // renderTraceSegmentsAtCurrentZoom() sopra) — registrato UNA SOLA
    // volta qui, non ad ogni loadTraceDetail(): la mappa persiste fra
    // un'apertura e l'altra del pannello (v. commento in cima al
    // file), quindi registrare di nuovo lo stesso listener ad ogni
    // apertura lo farebbe accumulare (N listener attivi dopo N
    // aperture, tutti richiamati ad ogni zoom). renderTraceSegmentsAtCurrentZoom()
    // legge sempre lo stato corrente di traceSegmentDefs, quindi
    // funziona automaticamente per qualunque traccia sia aperta al
    // momento dello zoom, senza bisogno di ri-registrare nulla.
    //
    traceDetailMap.on(
        "zoomend",
        renderTraceSegmentsAtCurrentZoom
    );

    return traceDetailMap;
}

function goToTraceDetail(
    row,
    pathKey
) {

    //
    // Ferma l'auto-refresh di Trace (stesso motivo di
    // stopNodesAutoRefresh() in goToNodeDetail() più sotto: senza
    // fermarlo, loadData() continuerebbe a ricaricare dataCache e a
    // ridisegnare la tabella nascosta ogni AUTO_REFRESH_INTERVAL
    // mentre si guarda il dettaglio). backToTraceLink (index.html) lo
    // riavvia esplicitamente al ritorno via configureAutoRefresh(),
    // stesso schema già usato da backToNodesLink per Nodes.
    //
    stopAutoRefresh();

    document.querySelectorAll(
        ".tabButton"
    ).forEach(
        b => b.classList.remove("active")
    );

    document.querySelectorAll(
        ".tabPage"
    ).forEach(
        p => p.style.display = "none"
    );

    document.getElementById(
        "traceDetailPage"
    ).style.display = "block";

    loadTraceDetail(
        row,
        pathKey
    );
}

async function loadTraceDetail(
    row,
    pathKey
) {

    const requestId =
        ++traceDetailRequestId;

    const notices = [];

    const heading =
        document.getElementById(
            "traceDetailHeading"
        );

    heading.textContent =
        `${pathKey} — ${row.timestamp}`;

    //
    // Elenco dei segmenti nell'ordine del percorso: le chiavi "X→Y"
    // dell'oggetto row sono inserite da parseTraceContent() (v.
    // parser.js) nello stesso ordine del percorso (SRC→hop1,
    // hop1→hop2, ..., ultimoHop→SRC) e Object.keys() su un oggetto
    // con chiavi stringa preserva l'ordine di inserimento — stessa
    // assunzione già sfruttata da renderTable() qui sopra per
    // ordinare le colonne della tabella.
    //
    const links =
        Object.keys(
            row
        ).filter(
            c =>
                c.includes(
                    "→"
                )
        );

    const segments =
        links.map(
            link => {

                const parts =
                    link.split("→")
                        .map(p => p.trim());

                return {
                    from: parts[0],
                    to: parts[1],
                    value: row[link]
                };
            }
        );

    const nodeIds =
        new Set();

    segments.forEach(
        s => {

            nodeIds.add(s.from);
            nodeIds.add(s.to);
        }
    );

    //
    // Posizione di SRC — SEMPRE presa "live" da /api/device_status
    // (mai da dataCache/trace.json, che non la contiene): v. il
    // commento in cima a questa sezione sul perché questo vale anche
    // quando la traccia mostrata è di un mese archiviato.
    //
    let srcPosition =
        null;

    if (
        nodeIds.has("SRC")
    ) {

        try {

            const res =
                await fetch(
                    "/api/device_status"
                );

            assertResOk(res);

            const status =
                await res.json();

            if (
                requestId !== traceDetailRequestId
            ) {

                return;
            }

            if (
                status &&
                status.adv_lat != null &&
                status.adv_lon != null
            ) {

                srcPosition = {
                    lat: status.adv_lat,
                    lon: status.adv_lon
                };

            } else {

                notices.push(
                    "Posizione del nodo locale (SRC) non disponibile: il Companion collegato non ha ancora fornito coordinate GPS."
                );
            }

        } catch (
            err
        ) {

            if (
                requestId !== traceDetailRequestId
            ) {

                return;
            }

            console.error(
                "Error loading device status for trace detail:",
                err
            );

            notices.push(
                "Impossibile leggere la posizione del nodo locale (SRC) da /api/device_status."
            );
        }
    }

    if (
        requestId !== traceDetailRequestId
    ) {

        return;
    }

    const positions = {};

    if (
        srcPosition
    ) {

        positions.SRC =
            srcPosition;
    }

    nodeIds.forEach(
        id => {

            if (
                id === "SRC"
            ) {

                return;
            }

            const resolved =
                resolveNodePosition(
                    id
                );

            if (
                resolved.status === "ok"
            ) {

                positions[id] = {
                    lat: resolved.lat,
                    lon: resolved.lon
                };

            } else if (
                resolved.status === "no-position"
            ) {

                notices.push(
                    `Posizione di ${resolveNodeName(id)} (${id}) non disponibile in contacts.db.`
                );

            } else if (
                resolved.status === "ambiguous"
            ) {

                notices.push(
                    `Prefisso "${id}" ambiguo: più nodi corrispondono, impossibile determinare quale mostrare.`
                );

            } else {

                notices.push(
                    `Nodo ${id} non trovato in contacts.db.`
                );
            }
        }
    );

    if (
        row.status === "TIMEOUT"
    ) {

        notices.push(
            "Questa traccia è andata in TIMEOUT: il percorso disegnato è quello CONFIGURATO per il path, non necessariamente quello realmente seguito dai pacchetti (v. trace.sh)."
        );
    }

    const map =
        ensureTraceDetailMap();

    traceDetailLayerGroup.clearLayers();
    traceSegmentLayerGroup.clearLayers();

    //
    // invalidateSize() PRIMA di aggiungere marker/fitBounds(): il
    // contenitore #traceDetailMap era display:none fino a un istante
    // fa (goToTraceDetail() lo rende visibile appena prima di
    // chiamare questa funzione) e Leaflet, alla creazione, ha
    // calcolato le proprie dimensioni interne quando il contenitore
    // aveva ancora altezza 0 — senza questa chiamata la mappa
    // resterebbe visivamente vuota/mal centrata finché l'utente non
    // interagisce manualmente (pan/zoom).
    //
    map.invalidateSize();

    const bounds =
        [];

    Object.keys(
        positions
    ).forEach(
        id => {

            const pos =
                positions[id];

            const label =
                id === "SRC" ?
                    "SRC (nodo locale)" :
                    `${resolveNodeName(id)} (${id})`;

            L.marker(
                [pos.lat, pos.lon],
                {
                    icon:
                        id === "SRC" ?
                            TRACE_SRC_ICON :
                            TRACE_REPEATER_ICON
                }
            ).bindTooltip(
                escapeHtml(label),
                {
                    permanent: true,
                    direction: "top"
                }
            ).addTo(
                traceDetailLayerGroup
            );

            bounds.push(
                [pos.lat, pos.lon]
            );
        }
    );

    //
    // Solo dati "grezzi", indipendenti dallo zoom — nessun disegno
    // qui: renderTraceSegmentsAtCurrentZoom() (v. sopra) calcola lo
    // spostamento pixel andata/ritorno usando lo zoom corrente della
    // mappa e viene richiamata esplicitamente subito dopo
    // map.fitBounds() qui sotto (oltre che ad ogni "zoomend"
    // successivo) — deve girare DOPO che la vista ha il proprio zoom
    // definitivo, non durante la costruzione di questa lista.
    //
    traceSegmentDefs = [];

    segments.forEach(
        seg => {

            const posFrom =
                positions[seg.from];

            const posTo =
                positions[seg.to];

            if (
                !posFrom ||
                !posTo
            ) {

                //
                // Uno dei due estremi non ha posizione risolta (già
                // segnalato sopra in notices): il segmento viene
                // saltato invece di disegnare una linea verso
                // [0,0]/un punto arbitrario.
                //
                return;
            }

            //
            // Spostamento SOLO quando esiste anche il collegamento di
            // ritorno in QUESTA traccia ("B→A" fra le chiavi della
            // riga, oltre a "A→B"): un hop che compare una sola volta
            // (es. una scorciatoia sul ritorno, v. spiegazione utente
            // 2026-08-23) viene disegnato sulla sua vera geodetica,
            // senza spostamento superfluo.
            //
            // Nessuna convenzione "coppia canonica" da A/B ordinati:
            // sign fisso (0 oppure 1, mai -1) e basta, perché A e B
            // vengono passati a offsetSegmentPixels() nell'ordine
            // naturale from/to del segmento — che si INVERTE già da
            // solo fra andata ("A→B", from=A,to=B) e ritorno ("B→A",
            // from=B, to=A). Invertire l'ordine dei due punti passati
            // a offsetSegmentPixels() ribalta GIÀ DA SOLO il lato
            // dello spostamento (identità vettoriale: ruotare di 90°
            // il vettore invertito -(dx,dy) equivale a ribaltare il
            // perpendicolare ottenuto da (dx,dy)); un'ulteriore
            // inversione del segno (come nella prima versione di
            // questa funzione, poi corretta) ANNULLAVA quella
            // inversione naturale invece di rinforzarla, riportando
            // andata e ritorno esattamente sulla stessa linea — bug
            // trovato e corretto in fase di test contro dati reali
            // (v. CHANGES_mappa_dettaglio_traccia.md).
            //
            const hasReturnSegment =
                links.includes(
                    `${seg.to}→${seg.from}`
                );

            const sign =
                hasReturnSegment ?
                    1 :
                    0;

            const color =
                seg.value === "TIMEOUT" ?
                    "#d32f2f" :
                    typeof seg.value === "number" ?
                        snrColor(seg.value) :
                        "#888888";

            const isDegenerate =
                posFrom.lat === posTo.lat &&
                posFrom.lon === posTo.lon;

            traceSegmentDefs.push(
                {
                    latlngFrom: { lat: posFrom.lat, lng: posFrom.lon },
                    latlngTo: { lat: posTo.lat, lng: posTo.lon },
                    sign: sign,
                    color: color,
                    dashArray:
                        seg.value === "TIMEOUT" ?
                            "6 6" :
                            null,
                    labelHtml:
                        traceSegmentLabelHtml(seg.value),
                    isDegenerate: isDegenerate
                }
            );
        }
    );

    if (
        bounds.length > 0
    ) {

        //
        // animate:false — fitBounds() imposta subito il centro/zoom
        // definitivi (nessuna animazione), così la chiamata esplicita
        // a renderTraceSegmentsAtCurrentZoom() poco sotto legge già lo
        // zoom "finale" con cui la mappa resta visibile, invece dello
        // zoom di partenza (2, v. ensureTraceDetailMap()) o di un
        // valore intermedio dell'animazione ancora in corso.
        //
        map.fitBounds(
            bounds,
            { padding: [30, 30], animate: false }
        );

    } else {

        notices.push(
            "Nessuna posizione risolvibile per questa traccia: impossibile mostrare la mappa."
        );
    }

    //
    // Disegna segmenti+frecce con lo zoom con cui la mappa è appena
    // stata impostata sopra (o quello già attivo, se bounds era vuoto
    // e fitBounds() non è stata chiamata) — v. il commento su
    // renderTraceSegmentsAtCurrentZoom() più sopra nel file. Ogni
    // successivo cambio di zoom da parte dell'utente è gestito dal
    // listener "zoomend" registrato una sola volta in
    // ensureTraceDetailMap(), non da qui.
    //
    renderTraceSegmentsAtCurrentZoom();

    const noticesEl =
        document.getElementById(
            "traceDetailNotices"
        );

    noticesEl.innerHTML =
        notices
            .map(
                n =>
                    `<div class="traceNotice">${escapeHtml(n)}</div>`
            )
            .join("");
}

/* =========================
   AUTO REFRESH
========================= */

//
// Meccanismo di auto-refresh CONDIVISO da tutte e tre le tab (Trace,
// Nodes, Neighbours) — un solo timer attivo alla volta, dato che le
// tab sono mutuamente esclusive (una sola visibile per volta). Prima
// c'erano tre implementazioni indipendenti (un select on/off per
// Trace non legato alla visibilità della tab, un avvio/arresto
// automatico legato alla tab per Nodes, nessun refresh per
// Neighbours) — questi due helper sono ora l'unico punto che fa
// setInterval/clearInterval, richiamato da configureAutoRefresh()
// (Trace), startNodesAutoRefresh()/stopNodesAutoRefresh() e
// startNeighborsAutoRefresh()/stopNeighborsAutoRefresh() più sotto.
//
function stopAutoRefresh() {

    if (
        autoRefreshTimer
    ) {

        clearInterval(
            autoRefreshTimer
        );

        autoRefreshTimer =
            null;
    }
}

function startAutoRefresh(loadFn) {

    stopAutoRefresh();

    autoRefreshTimer =
        setInterval(
            async () => {

                await loadFn();
            },
            AUTO_REFRESH_INTERVAL
        );
}

//
// Tab Trace: il refresh resta legato alla preferenza utente
// (autoRefreshSelect, persistita in localStorage) — a differenza di
// Nodes/Neighbours non parte/si ferma automaticamente in base alla
// sola visibilità della tab, ma configureAutoRefresh() viene
// comunque richiamata anche al cambio tab (vedi index.html) così il
// refresh si ferma quando si lascia Trace e riparte, se abilitato,
// quando ci si torna — non gira più a vuoto su un'altra tab.
//
function configureAutoRefresh() {

    const mode =
        safeLocalStorageGet(
            "autoRefresh"
        ) ||
        "off";

    stopAutoRefresh();

    if (
        mode ===
        "on"
    ) {

        startAutoRefresh(
            loadData
        );
    }
}

//
// Invariante "sorgente dati archiviata ⇒ Auto Refresh forzato OFF e
// disabilitato" — prima era scritta due volte quasi identica (al
// DOMContentLoaded iniziale e nel listener "change" di
// dataSourceSelector), col rischio concreto di disallinearsi se una
// delle due copie veniva aggiornata e l'altra no. Un solo punto,
// richiamato da entrambe.
//
function syncAutoRefreshToDataSource() {

    const refreshBar =
        document.getElementById(
            "autoRefreshSelect"
        );

    const dataSourceSelector =
        document.getElementById(
            "dataSourceSelector"
        );

    if (
        !refreshBar ||
        !dataSourceSelector
    ) {

        return;
    }

    if (
        dataSourceSelector.value === "live"
    ) {

        refreshBar.disabled =
            false;
    }

    else {

        refreshBar.value =
            "off";

        refreshBar.disabled =
            true;

        stopAutoRefresh();
    }
}

/* =========================
   INIT
========================= */

document.addEventListener(
    "DOMContentLoaded",
    async () => {

document
    .getElementById(
        "pathSelector"
    )
    .addEventListener(
        "change",
        () => {

            safeLocalStorageSet(
                "selectedPath",
                document
                    .getElementById(
                        "pathSelector"
                    )
                    .value
            );

            updateView();
        }
    );

const dataSourceSelector =
    document.getElementById(
        "dataSourceSelector"
    );

if (
    dataSourceSelector
) {

dataSourceSelector.addEventListener(
    "change",
    async () => {

        safeLocalStorageSet(
            "dataSource",
            dataSourceSelector.value
        );

        syncAutoRefreshToDataSource();

        //
        // dataSourceSelector è raggiungibile solo dal tab Trace (sta
        // dentro tracePage) — configureAutoRefresh() qui è sempre
        // sicura, a differenza della chiamata a fine
        // DOMContentLoaded che invece va condizionata al tab
        // effettivamente visibile (v. più sotto).
        //
        if (
            dataSourceSelector.value === "live"
        ) {

            configureAutoRefresh();
        }

        await loadData();
    }
);

}

//
// Selettore periodo (Live/mese archiviato) della vista dettaglio
// nodo — a differenza di dataSourceSelector non c'è nulla da
// caricare al DOMContentLoaded: la selezione viene popolata da
// loadNodeDetailArchiveList() solo quando si apre un nodo (vedi
// loadNodeDetail).
//
const nodeDetailArchiveSelector =
    document.getElementById(
        "nodeDetailArchiveSelector"
    );

if (
    nodeDetailArchiveSelector
) {

    nodeDetailArchiveSelector.addEventListener(
        "change",
        () => {

            switchNodeDetailPeriod(
                nodeDetailArchiveSelector.value
            );
        }
    );
}

//
// Selettore repeater della tab Neighbours — popolato da
// loadNeighborsRepeaterList() solo quando si apre la tab (stesso
// principio del selettore periodo qui sopra).
//
const neighborRepeaterSelector =
    document.getElementById(
        "neighborRepeaterSelector"
    );

if (
    neighborRepeaterSelector
) {

    neighborRepeaterSelector.addEventListener(
        "change",
        () => {

            safeLocalStorageSet(
                "neighborRepeater",
                neighborRepeaterSelector.value
            );

            loadNeighborData(
                neighborRepeaterSelector.value
            );
        }
    );
}

const neighborsArchiveSelector =
    document.getElementById(
        "neighborsArchiveSelector"
    );

if (
    neighborsArchiveSelector
) {

    neighborsArchiveSelector.addEventListener(
        "change",
        onNeighboursArchiveChange
    );
}

const neighborsSnapshotSelector =
    document.getElementById(
        "neighborsSnapshotSelector"
    );

if (
    neighborsSnapshotSelector
) {

    neighborsSnapshotSelector.addEventListener(
        "change",
        onNeighboursSnapshotChange
    );
}

        await loadMeshNodes();

        //
        // Se l'ultima tab attiva ripristinata (script sincrono in
        // index.html, PRIMA di questo DOMContentLoaded) era Nodes,
        // loadNodesTab() è già scattato con meshNodes ancora vuoto
        // ({}) — ogni tooltip della colonna Path sarebbe rimasto
        // "Unknown" fino al prossimo refresh manuale. Nessun
        // problema per Trace: il suo caricamento sta più sotto in
        // questa stessa sequenza, già dopo loadMeshNodes().
        //
        const nodesPageAlreadyVisible =
            document.getElementById("nodesPage") &&
            document.getElementById("nodesPage").style.display !== "none";

        if (
            nodesPageAlreadyVisible &&
            typeof loadNodesTab === "function"
        ) {

            await loadNodesTab();
        }

        await loadDataSources();
        await loadData();

        const refreshSelector =
            document.getElementById(
                "autoRefreshSelect"
            );

        if (
            refreshSelector
        ) {

            refreshSelector.value =
                safeLocalStorageGet(
                    "autoRefresh"
                ) ||
                "off";

            //
            // Stesso helper usato dal listener "change" di
            // dataSourceSelector — imposta disabled/value in base
            // alla sorgente dati corrente e ferma un eventuale timer
            // residuo, senza duplicare la logica.
            //
            syncAutoRefreshToDataSource();

            refreshSelector.addEventListener(
                "change",
                () => {

                    safeLocalStorageSet(
                        "autoRefresh",
                        refreshSelector.value
                    );

                    configureAutoRefresh();
                }
            );

            //
            // BUG RISOLTO (v. AUDIT_terza_passata_tab_refresh.md):
            // questa chiamata era incondizionata, quindi girava anche
            // quando il tab ripristinato al caricamento pagina era
            // Nodes o Repeaters — configureAutoRefresh() ferma SEMPRE
            // il timer condiviso e lo riavvia solo per Trace
            // (loadData()), rompendo così in modo silenzioso
            // l'auto-refresh che il click sintetico di ripristino tab
            // in index.html (eseguito PRIMA di questo
            // DOMContentLoaded) aveva appena avviato per quel tab. Va
            // eseguita solo se il tab davvero attivo in questo
            // momento è tracePage — e solo se la sorgente dati
            // corrente non l'ha già disabilitata.
            //
            const tracePageVisible =
                document.getElementById("tracePage") &&
                document.getElementById("tracePage").style.display !== "none";

            if (
                tracePageVisible &&
                !refreshSelector.disabled
            ) {

                configureAutoRefresh();
            }
        }

        document
            .querySelectorAll(
                ".rangeButton"
            )
            .forEach(
                btn => {

                    if (
                        btn.dataset
                            .range ===
                        (
                            safeLocalStorageGet(
                                "chartRange"
                            ) ||
                            "all"
                        )
                    ) {

                        btn.classList.add(
                            "active"
                        );
                    }

                    btn.addEventListener(
                        "click",
                        () => {

                            document
                                .querySelectorAll(
                                    ".rangeButton"
                                )
                                .forEach(
                                    b =>
                                        b.classList.remove(
                                            "active"
                                        )
                                );

                            btn.classList.add(
                                "active"
                            );

                            safeLocalStorageSet(
                                "chartRange",
                                btn.dataset
                                    .range
                            );

                            updateView();
                        }
                    );
                }
            );
    }
);

/* =========================
   NODES TAB
========================= */

const NODE_TYPE_NAMES = {
    1: "chat",
    2: "repeater",
    3: "room server"
};

function formatNodeType(t) {

    return NODE_TYPE_NAMES[t] || `unknown (${t})`;
}

//
// Uniche due implementazioni di formattazione data/ora del file —
// ogni altro punto (tabelle, assi/tooltip dei grafici Chart.js) deve
// richiamare una di queste due invece di reimplementare da capo il
// calcolo di dd/mm/yyyy/hh/min, per evitare che una correzione (es.
// un bug di fuso orario) venga applicata in un punto e dimenticata
// altrove.
//
function formatDateShort(d) {

    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");

    return `${dd}/${mm} ${hh}:${min}`;
}

function formatDateFull(d) {

    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");

    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

function formatUnixTime(ts) {

    if (!ts) return "never";

    return formatDateFull(
        new Date(ts * 1000)
    );
}

function splitAdvertPathHops(hopCount, pathHex) {

    if (hopCount === 0 || !pathHex) {
        return [];
    }

    const chunkSize = Math.floor(pathHex.length / hopCount);

    //
    // hopCount dichiarato più alto di quanti "byte" siano davvero
    // presenti in pathHex produce chunkSize=0 (code review Rev.6,
    // trovato ESEGUENDO un test mirato con un watchdog, non dalla
    // sola lettura: "for (i += chunkSize)" con chunkSize=0 non
    // incrementa mai i, il ciclo non termina — CONFERMATO chiamando
    // la funzione reale sotto timeout, mai ritornata). hopCount e
    // pathHex arrivano da due colonne indipendenti di
    // path_observations (hop_count/path_hex), scritte da due campi
    // altrettanto indipendenti del payload radio lato daemon (v.
    // stesso fix gemello in mesh_modules/bot/commands/path.py
    // split_path_hops per la spiegazione completa) — un ciclo che
    // blocca la tab del browser dell'utente non appena quella riga
    // viene renderizzata, permanentemente finché la pagina non viene
    // ricaricata. Stesso fallback del lato Python: l'intera stringa
    // come un unico "hop" grezzo.
    //
    if (chunkSize < 1) {
        return [pathHex];
    }

    const hops = [];

    for (let i = 0; i < pathHex.length; i += chunkSize) {
        hops.push(pathHex.slice(i, i + chunkSize));
    }

    return hops;
}

//
// Come buildPathTooltip/buildPathTooltipHtml in Trace: un tooltip
// INDIPENDENTE per ciascun hop invece di uno unico per l'intero
// path — passando sopra un singolo hop se ne vede solo il nome
// risolto. resolveNodeName() resta l'unica fonte di verità per la
// risoluzione nome, invariata: il cambiamento è tutto in cosa
// restituisce /api/meshnodes lato server (contacts.db invece di
// mesh-nodes.json), non nella logica di lookup qui. data-tooltip
// (non title): il tooltip vero lo gestisce initTooltips() più sotto,
// con supporto touch — il chiamante usa il risultato come contenuto
// della cella.
//
function buildAdvertPathHtml(hopCount, pathHex) {

    if (hopCount === null || hopCount === undefined) {
        return "not observed";
    }

    const hops = splitAdvertPathHops(hopCount, pathHex);

    if (hops.length === 0) {
        return "DIRECT (0 hop)";
    }

    return hops
        .map(hop => `<span data-tooltip="${escapeHtml(resolveNodeName(hop))}">${hop}</span>`)
        .join(" > ");
}

function startNodesAutoRefresh() {

    startAutoRefresh(
        loadNodesTab
    );
}

function stopNodesAutoRefresh() {

    stopAutoRefresh();
}

async function loadNodesTab() {

    loadDeviceStatus();

    const table =
        document.getElementById(
            "nodesTable"
        );

    //
    // Niente "Loading..." qui: come loadData()/loadDeviceStatus(), il
    // contenuto precedente resta visibile finché i nuovi dati non sono
    // pronti, poi lo swap è atomico dentro renderNodesTable(). Prima di
    // questa modifica questo azzeramento causava un blink visibile ad
    // ogni refresh, incluso quello silenzioso in background
    // (v. docs/ARCHITECTURE.md §65).
    //

    const requestId =
        ++nodesTabRequestId;

    try {

        const res =
            await fetch(
                "/api/nodes"
            );

        assertResOk(res);

        const nodes =
            await res.json();

        if (
            requestId !== nodesTabRequestId
        ) {

            return;
        }

        nodesDataCache =
            nodes;

        nodesDataReady =
            true;

        initNodesFilters();

        applyNodesFilters();

    }

    catch (
        err
    ) {

        if (
            requestId !== nodesTabRequestId
        ) {

            return;
        }

        console.error(
            "Error loading nodes:",
            err
        );

        table.innerHTML =
            "<tr><td>Error loading data.</td></tr>";
    }
}

/* =========================
   NODES TAB: PATH FILTERS

   Filtro client-side sui dati già
   caricati (nodesDataCache) — non
   rifà la fetch, riduce solo cosa
   viene mostrato in tabella.
========================= */

function getPathChunkSize(n) {

    if (
        !n.hop_count ||
        !n.path_hex
    ) {

        // DIRECT (0 hop) o path non
        // ancora osservato: nessun
        // path definito da misurare.
        return null;
    }

    return Math.floor(
        n.path_hex.length /
        n.hop_count
    );
}

function nodeMatchesNameFilter(
    n,
    filterValue
) {

    if (
        !filterValue
    ) {

        return true;
    }

    const needle =
        filterValue.toLowerCase();

    const nameMatch =
        !!n.adv_name &&
        n.adv_name
            .toLowerCase()
            .includes(
                needle
            );

    const keyMatch =
        !!n.public_key &&
        n.public_key
            .toLowerCase()
            .includes(
                needle
            );

    return nameMatch || keyMatch;
}

function nodeMatchesTypeFilter(
    n,
    typeValue
) {

    if (
        !typeValue ||
        typeValue === "all"
    ) {

        return true;
    }

    return (
        String(n.node_type) ===
        String(typeValue)
    );
}

function nodeMatchesPathFilter(
    n,
    filterValue
) {

    if (
        !filterValue
    ) {

        return true;
    }

    if (
        !n.path_hex
    ) {

        return false;
    }

    return n.path_hex
        .toLowerCase()
        .includes(
            filterValue.toLowerCase()
        );
}

function nodeMatchesLengthFilter(
    n,
    lengthValue
) {

    if (
        !lengthValue ||
        lengthValue === "all"
    ) {

        return true;
    }

    const chunkSize =
        getPathChunkSize(
            n
        );

    if (
        chunkSize === null
    ) {

        return false;
    }

    return (
        chunkSize ===
        parseInt(
            lengthValue,
            10
        ) * 2
    );
}

//
// Filtro "Max hop count": soglia massima (hop_count <= soglia) digitata
// dall'utente in un campo libero, non un elenco predefinito come "Path
// length". Motivo, confermato con l'utente dopo una prima versione a
// corrispondenza esatta: hop_count non ha un range piccolo e stabile
// come il byte-size di un singolo hop (1/2/3, fisso per come è fatto
// l'encoding) — nel dataset reale usato per verificare questo filtro
// va da 0 a 14, e il firmware permette fino a 64 (autoadd_max_hops, v.
// docs/FIRMWARE_ANALYSIS.md §2.4); un dropdown avrebbe richiesto una
// lista lunga e comunque incompleta rispetto al limite di protocollo.
// Stesso trattamento "valore non valido/vuoto = nessun filtro" già
// usato da getNodeDistanceThresholdKm() per il campo Custom della
// distanza, per coerenza di comportamento tra i due campi liberi
// della tabella.
//
function getNodeHopCountThreshold(
    rawValue
) {

    if (
        !rawValue
    ) {

        return null;
    }

    const parsed =
        parseInt(
            rawValue,
            10
        );

    return (
        Number.isFinite(parsed) &&
        parsed >= 0
    )
        ? parsed
        : null;
}

//
// Byte fissi del buffer path a livello firmware: ContactInfo.out_path
// è un campo di 64 byte (docs/FIRMWARE_ANALYSIS.md §10, stesso valore
// già citato altrove nel progetto per lo stesso campo — v.
// docs/REVIEW_FULL_EXTENSIVE_2026-08-20_Rev6.md). Ogni hop nel path
// occupa lengthValue byte (1/2/3, lo stesso valore di "Path length"):
// il numero massimo di hop rappresentabili in quel buffer è quindi
// floor(64 / lengthValue) — 64/32/21 per 1/2/3 byte, confermato
// dall'utente rispetto alla documentazione MeshCore prima di essere
// implementato qui. null quando "Path length" è su "All": senza un
// encoding specifico selezionato non c'è un singolo tetto valido per
// tutti i nodi contemporaneamente.
//
const OUT_PATH_BUFFER_BYTES =
    64;

function getPathLengthMaxHopCount(
    pathLengthValue
) {

    if (
        !pathLengthValue ||
        pathLengthValue === "all"
    ) {

        return null;
    }

    const bytesPerHop =
        parseInt(
            pathLengthValue,
            10
        );

    if (
        !Number.isFinite(bytesPerHop) ||
        bytesPerHop <= 0
    ) {

        return null;
    }

    return Math.floor(
        OUT_PATH_BUFFER_BYTES /
        bytesPerHop
    );
}

//
// Aggiorna l'attributo max e il tooltip di "Max hop count" in base
// alla selezione corrente di "Path length" — non forza/clampa mai il
// valore già digitato dall'utente (un hop_count<=50 con Path
// length=2 byte, il cui massimo teorico è 32, produce comunque lo
// stesso risultato di <=32 per quei nodi: non è un errore, solo un
// vincolo ridondante, non serve impedirlo). Richiamata sia al cambio
// di "Path length" sia da initNodesFilters() ad ogni chiamata, stesso
// pattern già in uso per updateNodeDistanceCustomVisibility()/
// updateNodeDistanceFilterAvailability().
//
function updateNodeHopCountMaxHint() {

    const lengthSelect =
        document.getElementById(
            "nodePathLengthFilter"
        );

    const hopCountInput =
        document.getElementById(
            "nodeHopCountFilterInput"
        );

    const hopCountLabel =
        document.querySelector(
            'label[for="nodeHopCountFilterInput"]'
        );

    if (
        !hopCountInput
    ) {

        return;
    }

    const maxHops =
        getPathLengthMaxHopCount(
            lengthSelect
                ? lengthSelect.value
                : "all"
        );

    if (
        maxHops === null
    ) {

        hopCountInput.removeAttribute(
            "max"
        );

        if (
            hopCountLabel
        ) {

            hopCountLabel.removeAttribute(
                "data-tooltip"
            );
        }

        return;
    }

    hopCountInput.setAttribute(
        "max",
        String(maxHops)
    );

    if (
        hopCountLabel
    ) {

        hopCountLabel.setAttribute(
            "data-tooltip",
            `Con "Path length" su ${lengthSelect.value} byte, il massimo hop count possibile è ${maxHops} (buffer path del firmware: ${OUT_PATH_BUFFER_BYTES} byte).`
        );
    }
}

//
// A differenza di nodeMatchesLengthFilter() — che esclude anche i
// nodi DIRECT (hop_count===0), perché per un path a zero hop non
// esiste alcun "chunk" da misurare in byte — qui 0 è un valore
// perfettamente valido e voluto: un nodo DIRECT ha letteralmente zero
// elementi nel path, quindi soddisfa qualunque soglia >=0. Solo i
// nodi "not observed" (hop_count assente, nessun path mai osservato
// questo mese) restano esclusi quando il filtro è attivo, stesso
// criterio di nodeIsNotObserved() subito sotto.
//
function nodeMatchesHopCountFilter(
    n,
    hopCountThreshold
) {

    if (
        hopCountThreshold === null
    ) {

        return true;
    }

    if (
        n.hop_count === null ||
        n.hop_count === undefined
    ) {

        return false;
    }

    return (
        n.hop_count <= hopCountThreshold
    );
}

//
// Stesso identico criterio di buildAdvertPathHtml()/split
// AdvertPathHops() per "not observed": hop_count assente (mai una
// riga in path_observations per questo nodo, arrivato solo dal sync
// periodico get_contacts()) — non va confuso con hop_count===0, che
// è un advert DIRECT realmente ricevuto dal vivo.
//
function nodeIsNotObserved(
    n
) {

    return (
        n.hop_count === null ||
        n.hop_count === undefined
    );
}

//
// Un last_advert nel futuro rispetto all'orologio di QUESTO browser
// è il sintomo di un orologio sbagliato sul nodo che ha generato
// l'advert — stesso concetto del Clock Skew dei repeater (tab
// Repeaters), ma qui rilevabile lato client senza bisogno di
// un'interrogazione dedicata: last_advert arriva già dal device.
// Un last_advert assente (not observed) non è "nel futuro", è
// semplicemente ignoto — false, non true.
//
function nodeHasFutureAdvert(
    n
) {

    if (
        n.last_advert === null ||
        n.last_advert === undefined
    ) {

        return false;
    }

    const nowSecs =
        Math.floor(
            Date.now() / 1000
        );

    return n.last_advert > nowSecs;
}

//
// Distanza in km fra due coordinate (formula dell'emisenoverso, grande
// cerchio) — usata solo dal filtro "Distance from SRC" sotto, nessuna
// libreria esterna necessaria per un calcolo così piccolo.
//
function haversineDistanceKm(
    lat1,
    lon1,
    lat2,
    lon2
) {

    const R =
        6371;

    const toRad =
        deg => deg * Math.PI / 180;

    const dLat =
        toRad(lat2 - lat1);

    const dLon =
        toRad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;

    return 2 * R * Math.asin(Math.sqrt(a));
}

//
// null se non misurabile: SRC non ancora nota (srcCoordsCache) o nodo
// senza adv_lat/adv_lon proprio (989 nodi su 990 nel dataset reale
// usato per verificare questo filtro, non tutti — stesso trattamento
// "non misurabile" già usato da getPathChunkSize()/
// nodeMatchesLengthFilter() per i nodi senza un path definito).
//
function nodeDistanceFromSrcKm(
    n
) {

    if (
        !srcCoordsCache ||
        n.adv_lat == null ||
        n.adv_lon == null
    ) {

        return null;
    }

    return haversineDistanceKm(
        srcCoordsCache.lat,
        srcCoordsCache.lon,
        n.adv_lat,
        n.adv_lon
    );
}

//
// selectValue: "all" | "custom" | valore numerico in km (voce
// predefinita del <select>, v. index.html). Ritorna null quando il
// filtro va trattato come disattivo — non solo per "All", ma anche
// quando SRC non è (ancora) nota o il campo custom non contiene un
// numero valido: in nessuno di questi casi va interpretato come "0
// nodi entro il raggio", deve lasciare passare tutto, esattamente
// come "All". Il controllo è comunque disabilitato in UI quando SRC
// non è nota (v. updateNodeDistanceFilterAvailability()) — questo
// controllo qui è la stessa garanzia lato logica, indipendente
// dall'ordine con cui /api/nodes e /api/device_status rispondono.
//
function getNodeDistanceThresholdKm(
    selectValue,
    customValue
) {

    if (
        !srcCoordsCache ||
        !selectValue ||
        selectValue === "all"
    ) {

        return null;
    }

    if (
        selectValue === "custom"
    ) {

        const parsed =
            parseFloat(
                customValue
            );

        return (
            Number.isFinite(parsed) &&
            parsed >= 0
        )
            ? parsed
            : null;
    }

    const parsed =
        parseFloat(
            selectValue
        );

    return Number.isFinite(parsed)
        ? parsed
        : null;
}

function nodeMatchesDistanceFilter(
    n,
    thresholdKm
) {

    if (
        thresholdKm === null
    ) {

        return true;
    }

    const distanceKm =
        nodeDistanceFromSrcKm(
            n
        );

    if (
        distanceKm === null
    ) {

        return false;
    }

    return distanceKm <= thresholdKm;
}

//
// Mostra/nasconde il campo custom (#nodeDistanceCustomInput) in base
// alla voce corrente del <select> — richiamata sia al cambio di
// selezione sia da initNodesFilters() per allineare la UI al valore
// ripristinato da localStorage.
//
function updateNodeDistanceCustomVisibility() {

    const distanceSelect =
        document.getElementById(
            "nodeDistanceFilter"
        );

    const distanceCustomInput =
        document.getElementById(
            "nodeDistanceCustomInput"
        );

    if (
        !distanceSelect ||
        !distanceCustomInput
    ) {

        return;
    }

    distanceCustomInput.style.display =
        (distanceSelect.value === "custom")
            ? ""
            : "none";
}

//
// Abilita/disabilita il filtro Distance from SRC in base alla
// disponibilità di srcCoordsCache — richiamata da loadDeviceStatus()
// ogni volta che arriva una risposta fresca, e da initNodesFilters()
// per lo stato iniziale. data-tooltip sulla <label> (mai disabilitata)
// invece che sul <select> stesso: alcuni browser (Chromium incluso)
// non generano eventi mouseover su un controllo form disabilitato,
// il tooltip sparirebbe insieme al motivo per cui è disabilitato.
// Stesso identico testo già usato per lo stesso identico caso nella
// mappa di dettaglio traccia (loadTraceDetail()) — v. anche
// docs/ARCHITECTURE.md, sezione "Posizione SRC".
//
function updateNodeDistanceFilterAvailability() {

    const distanceSelect =
        document.getElementById(
            "nodeDistanceFilter"
        );

    const distanceCustomInput =
        document.getElementById(
            "nodeDistanceCustomInput"
        );

    const distanceLabel =
        document.querySelector(
            'label[for="nodeDistanceFilter"]'
        );

    if (
        !distanceSelect
    ) {

        return;
    }

    const available =
        !!srcCoordsCache;

    distanceSelect.disabled =
        !available;

    if (
        distanceCustomInput
    ) {

        distanceCustomInput.disabled =
            !available;
    }

    if (
        distanceLabel
    ) {

        if (
            available
        ) {

            distanceLabel.removeAttribute(
                "data-tooltip"
            );

        } else {

            distanceLabel.setAttribute(
                "data-tooltip",
                "Posizione del nodo locale (SRC) non disponibile: il Companion collegato non ha ancora fornito coordinate GPS."
            );
        }
    }
}

function applyNodesFilters() {

    const nameFilterInput =
        document.getElementById(
            "nodeNameFilterInput"
        );

    const filterInput =
        document.getElementById(
            "nodePathFilterInput"
        );

    const typeSelect =
        document.getElementById(
            "nodeTypeFilter"
        );

    const lengthSelect =
        document.getElementById(
            "nodePathLengthFilter"
        );

    const hopCountInput =
        document.getElementById(
            "nodeHopCountFilterInput"
        );

    const notObservedCheckbox =
        document.getElementById(
            "nodeNotObservedFilter"
        );

    const futureAdvertCheckbox =
        document.getElementById(
            "nodeFutureAdvertFilter"
        );

    const distanceSelect =
        document.getElementById(
            "nodeDistanceFilter"
        );

    const distanceCustomInput =
        document.getElementById(
            "nodeDistanceCustomInput"
        );

    const nameFilter =
        nameFilterInput
            ? nameFilterInput.value.trim()
            : "";

    const pathFilter =
        filterInput
            ? filterInput.value.trim()
            : "";

    const typeFilter =
        typeSelect
            ? typeSelect.value
            : "all";

    const lengthFilter =
        lengthSelect
            ? lengthSelect.value
            : "all";

    const hopCountFilterRaw =
        hopCountInput
            ? hopCountInput.value.trim()
            : "";

    const notObservedFilter =
        notObservedCheckbox
            ? notObservedCheckbox.checked
            : false;

    const futureAdvertFilter =
        futureAdvertCheckbox
            ? futureAdvertCheckbox.checked
            : false;

    const distanceFilterValue =
        distanceSelect
            ? distanceSelect.value
            : "all";

    const distanceCustomValue =
        distanceCustomInput
            ? distanceCustomInput.value
            : "";

    safeLocalStorageSet(
        "nodeNameFilter",
        nameFilter
    );

    safeLocalStorageSet(
        "nodePathFilter",
        pathFilter
    );

    safeLocalStorageSet(
        "nodeTypeFilter",
        typeFilter
    );

    safeLocalStorageSet(
        "nodePathLengthFilter",
        lengthFilter
    );

    safeLocalStorageSet(
        "nodeHopCountFilter",
        hopCountFilterRaw
    );

    safeLocalStorageSet(
        "nodeNotObservedFilter",
        notObservedFilter
    );

    safeLocalStorageSet(
        "nodeFutureAdvertFilter",
        futureAdvertFilter
    );

    safeLocalStorageSet(
        "nodeDistanceFilter",
        distanceFilterValue
    );

    safeLocalStorageSet(
        "nodeDistanceCustomValue",
        distanceCustomValue
    );

    const distanceThresholdKm =
        getNodeDistanceThresholdKm(
            distanceFilterValue,
            distanceCustomValue
        );

    const hopCountThreshold =
        getNodeHopCountThreshold(
            hopCountFilterRaw
        );

    //
    // name, path e type sono in OR tra loro (modi alternativi di
    // cercare/restringere lo stesso insieme di nodi, non condizioni
    // da soddisfare tutte insieme) — se più di uno è valorizzato, un
    // nodo compare se soddisfa ALMENO UNO. length, hop count,
    // distance, not-observed e future-advert restano invece un
    // affinamento in AND: non sono criteri di ricerca, sono vincoli
    // strutturali applicati sopra il risultato della ricerca.
    //
    const typeFilterActive =
        !!typeFilter &&
        typeFilter !== "all";

    const filtered =
        nodesDataCache.filter(
            n => {

                const searchMatch =
                    (
                        !nameFilter &&
                        !pathFilter &&
                        !typeFilterActive
                    )
                        ? true
                        : (
                            (
                                nameFilter &&
                                nodeMatchesNameFilter(
                                    n,
                                    nameFilter
                                )
                            ) ||
                            (
                                pathFilter &&
                                nodeMatchesPathFilter(
                                    n,
                                    pathFilter
                                )
                            ) ||
                            (
                                typeFilterActive &&
                                nodeMatchesTypeFilter(
                                    n,
                                    typeFilter
                                )
                            )
                        );

                return (
                    searchMatch &&
                    nodeMatchesLengthFilter(
                        n,
                        lengthFilter
                    ) &&
                    nodeMatchesHopCountFilter(
                        n,
                        hopCountThreshold
                    ) &&
                    nodeMatchesDistanceFilter(
                        n,
                        distanceThresholdKm
                    ) &&
                    (
                        !notObservedFilter ||
                        nodeIsNotObserved(
                            n
                        )
                    ) &&
                    (
                        !futureAdvertFilter ||
                        nodeHasFutureAdvert(
                            n
                        )
                    )
                );
            }
        );

    renderNodesTable(
        filtered
    );
}

function initNodesFilters() {

    const nameFilterInput =
        document.getElementById(
            "nodeNameFilterInput"
        );

    const nameClearBtn =
        document.getElementById(
            "nodeNameFilterClearBtn"
        );

    const filterInput =
        document.getElementById(
            "nodePathFilterInput"
        );

    const lengthSelect =
        document.getElementById(
            "nodePathLengthFilter"
        );

    const clearBtn =
        document.getElementById(
            "nodePathFilterClearBtn"
        );

    const hopCountInput =
        document.getElementById(
            "nodeHopCountFilterInput"
        );

    const hopCountClearBtn =
        document.getElementById(
            "nodeHopCountFilterClearBtn"
        );

    const notObservedCheckbox =
        document.getElementById(
            "nodeNotObservedFilter"
        );

    const futureAdvertCheckbox =
        document.getElementById(
            "nodeFutureAdvertFilter"
        );

    const distanceSelect =
        document.getElementById(
            "nodeDistanceFilter"
        );

    const distanceCustomInput =
        document.getElementById(
            "nodeDistanceCustomInput"
        );

    if (
        !filterInput ||
        !lengthSelect
    ) {

        return;
    }

    const savedNameFilter =
        safeLocalStorageGet(
            "nodeNameFilter"
        ) || "";

    const savedFilter =
        safeLocalStorageGet(
            "nodePathFilter"
        ) || "";

    const savedType =
        safeLocalStorageGet(
            "nodeTypeFilter"
        ) || "all";

    const savedLength =
        safeLocalStorageGet(
            "nodePathLengthFilter"
        ) || "all";

    const savedHopCount =
        safeLocalStorageGet(
            "nodeHopCountFilter"
        ) || "";

    const savedNotObserved =
        safeLocalStorageGet(
            "nodeNotObservedFilter"
        ) === "true";

    const savedFutureAdvert =
        safeLocalStorageGet(
            "nodeFutureAdvertFilter"
        ) === "true";

    const savedDistance =
        safeLocalStorageGet(
            "nodeDistanceFilter"
        ) || "all";

    const savedDistanceCustom =
        safeLocalStorageGet(
            "nodeDistanceCustomValue"
        ) || "";

    if (
        nameFilterInput
    ) {

        nameFilterInput.value =
            savedNameFilter;
    }

    filterInput.value =
        savedFilter;

    const typeSelect =
        document.getElementById(
            "nodeTypeFilter"
        );

    if (
        typeSelect
    ) {

        typeSelect.value =
            savedType;
    }

    lengthSelect.value =
        savedLength;

    if (
        hopCountInput
    ) {

        hopCountInput.value =
            savedHopCount;
    }

    if (
        notObservedCheckbox
    ) {

        notObservedCheckbox.checked =
            savedNotObserved;
    }

    if (
        futureAdvertCheckbox
    ) {

        futureAdvertCheckbox.checked =
            savedFutureAdvert;
    }

    if (
        distanceSelect
    ) {

        distanceSelect.value =
            savedDistance;
    }

    if (
        distanceCustomInput
    ) {

        distanceCustomInput.value =
            savedDistanceCustom;
    }

    //
    // Ricalcolate ad ogni chiamata (non solo al primo bind, come i
    // valori sopra): srcCoordsCache può diventare noto/cambiare tra
    // un refresh e l'altro della tab, la visibilità del campo custom
    // e lo stato abilitato/disabilitato del filtro devono restare
    // allineati anche quando initNodesFilters() gira di nuovo senza
    // che l'utente abbia toccato nulla. Stesso motivo per il tetto di
    // "Max hop count": il valore restaurato di "Path length" da
    // localStorage va riflesso subito, non solo al primo cambio manuale.
    //
    updateNodeDistanceCustomVisibility();

    updateNodeDistanceFilterAvailability();

    updateNodeHopCountMaxHint();

    if (
        filterInput.dataset.bound
    ) {

        return;
    }

    filterInput.dataset.bound =
        "true";

    if (
        nameFilterInput
    ) {

        nameFilterInput.addEventListener(
            "input",
            applyNodesFilters
        );
    }

    filterInput.addEventListener(
        "input",
        applyNodesFilters
    );

    if (
        typeSelect
    ) {

        typeSelect.addEventListener(
            "change",
            applyNodesFilters
        );
    }

    lengthSelect.addEventListener(
        "change",
        () => {

            updateNodeHopCountMaxHint();

            applyNodesFilters();
        }
    );

    if (
        hopCountInput
    ) {

        hopCountInput.addEventListener(
            "input",
            applyNodesFilters
        );
    }

    if (
        hopCountClearBtn &&
        hopCountInput
    ) {

        hopCountClearBtn.addEventListener(
            "click",
            () => {

                hopCountInput.value =
                    "";

                applyNodesFilters();
            }
        );
    }

    if (
        notObservedCheckbox
    ) {

        notObservedCheckbox.addEventListener(
            "change",
            applyNodesFilters
        );
    }

    if (
        futureAdvertCheckbox
    ) {

        futureAdvertCheckbox.addEventListener(
            "change",
            applyNodesFilters
        );
    }

    if (
        distanceSelect
    ) {

        distanceSelect.addEventListener(
            "change",
            () => {

                updateNodeDistanceCustomVisibility();

                applyNodesFilters();
            }
        );
    }

    if (
        distanceCustomInput
    ) {

        distanceCustomInput.addEventListener(
            "input",
            applyNodesFilters
        );
    }

    if (
        clearBtn
    ) {

        clearBtn.addEventListener(
            "click",
            () => {

                filterInput.value =
                    "";

                applyNodesFilters();
            }
        );
    }

    if (
        nameClearBtn &&
        nameFilterInput
    ) {

        nameClearBtn.addEventListener(
            "click",
            () => {

                nameFilterInput.value =
                    "";

                applyNodesFilters();
            }
        );
    }
}

async function loadDeviceStatus() {

    const table =
        document.getElementById(
            "deviceStatusTable"
        );

    if (
        !table
    ) {

        return;
    }

    const requestId =
        ++deviceStatusRequestId;

    try {

        const res =
            await fetch(
                "/api/device_status"
            );

        assertResOk(res);

        const status =
            await res.json();

        if (
            requestId !== deviceStatusRequestId
        ) {

            return;
        }

        renderDeviceStatusTable(
            status
        );

        //
        // Posizione di SRC per il filtro "Distance from SRC" (Known
        // Nodes) — stessa risposta già ricevuta qui sopra per la
        // tabella Device Status, nessuna fetch aggiuntiva. null
        // quando il Companion non ha ancora fornito coordinate GPS
        // (stesso controllo già usato in loadTraceDetail() per lo
        // stesso dato).
        //
        srcCoordsCache =
            (
                status &&
                status.adv_lat != null &&
                status.adv_lon != null
            )
                ? {
                    lat: status.adv_lat,
                    lon: status.adv_lon
                }
                : null;

        updateNodeDistanceFilterAvailability();

        //
        // Riapplica i filtri Nodes solo se /api/nodes ha già
        // risposto almeno una volta su questa tab (nodesDataReady) —
        // le due fetch partono insieme da loadNodesTab() senza
        // await, ordine di risposta non garantito. Se /api/nodes non
        // ha ancora risposto, il giro di applyNodesFilters() che lo
        // segue comunque dentro loadNodesTab() basta da solo; farlo
        // anche da qui con nodesDataCache ancora [] letterale
        // ridisegnerebbe la tabella su "No nodes data available" un
        // istante prima del render vero — lo stesso blink già
        // eliminato altrove in questa tab (docs/ARCHITECTURE.md
        // §65).
        //
        if (
            nodesDataReady
        ) {

            applyNodesFilters();
        }
    }

    catch (
        err
    ) {

        if (
            requestId !== deviceStatusRequestId
        ) {

            return;
        }

        console.error(
            "Error loading device status:",
            err
        );

        table.innerHTML =
            "<tr><td>Error loading device status.</td></tr>";
    }
}

function renderDeviceStatusTable(
    status
) {

    const table =
        document.getElementById(
            "deviceStatusTable"
        );

    if (
        !status
    ) {

        table.innerHTML =
            "<tr><td>No device status data available.</td></tr>";

        return;
    }

    const secsAgo =
        Math.floor(
            Date.now() / 1000
        ) - status.updated_at;

    //
    // Ogni campo è difensivo perché, a differenza della status
    // table dei Repeaters (dove un fallimento azzera l'intero
    // oggetto), qui i tre gruppi core/radio/packets possono fallire
    // indipendentemente da un giro all'altro — vedi COALESCE in
    // upsert_device_status() lato backend. != null (o ??) gestisce
    // anche 0 come valore legittimo (es. Error Flags: 0), a
    // differenza di ||.
    //
    // Stesso ordine e stile della tabella Status dei Repeaters per
    // gli elementi in comune (vedi docs/NEIGHBOR_MONITORING.md §18)
    // — Battery/Uptime/Noise Floor/Last RSSI/Last SNR/TX Queue/
    // Packets Received/Packets Sent/Sent/Received/Airtime, più le
    // stesse metriche derivate (CRC Error Rate, Airtime %, TX Duty
    // Cycle), riusando le stesse funzioni di formattazione. "Error
    // Flags (bitmask)" e "Device" restano dove erano prima — non
    // hanno un equivalente nella tabella Repeaters. "Error Flags" è
    // status.errors, dal frame CORE (bitmask di eventi del
    // dispatcher — coda piena, CAD timeout, start-RX timeout) — NON
    // lo stesso concetto di "Receive Errors (CRC Fail)" qui sotto,
    // che è status.recv_errors dal frame PACKETS ("Receive/CRC
    // errors (RadioLib)", stesso significato del recv_errors dei
    // Repeaters — vedi docs/RECEIVE_ERRORS_CRC.md). Verificato sulla
    // documentazione ufficiale (docs.meshcore.io/stats_binary_frames)
    // prima di assumere l'equivalenza — i due campi non sono la
    // stessa cosa nonostante il nome "Errors" di uno richiami l'altro.
    //
    // Finding 4, code review 2026-08-20 (review indipendente
    // successiva a Rev.6): fw_version/fw_build/model sotto sono
    // testo grezzo riportato da una query diretta al device
    // companion — a differenza di public_key (hex a formato fisso,
    // v. la distinzione già documentata in Rev.4/Rev5), non hanno
    // alcun vincolo di formato/lunghezza a monte (v.
    // contact_sync.py::_sync_device_status(), passthrough diretto di
    // device_info.get("model")/fw_build/fw_version) — stessa
    // categoria di adv_name/matched_names ("annuncio libero"), quindi
    // vanno sempre da escapeHtml() prima di iniettarli in innerHTML,
    // esattamente come quei due campi. Rev.5 aveva letto questo file
    // per intero senza notare il punto (nessuna decisione contraria
    // documentata trovata in un audit esplicito — v. ARCHITECTURE.md
    // §34).
    //
    table.innerHTML = `
        <tr><th data-tooltip="Tempo trascorso dall'ultimo aggiornamento dei dati del companion locale mostrati in questa tabella (letti a intervalli da trace-mon, non in tempo reale).">Updated</th><td>${formatSecsAgo(secsAgo)}</td></tr>
        <tr><th data-tooltip="Tensione della batteria, riportata dal device in millivolt e convertita qui in Volt.">Battery</th><td>${status.battery_mv != null ? (status.battery_mv / 1000).toFixed(2) + "V" : "n/a"}</td></tr>
        <tr><th data-tooltip="Tempo trascorso dall'ultimo avvio del device, nel formato giorni/ore/minuti.">Uptime</th><td>${formatDurationLong(status.uptime_secs)}</td></tr>
        <tr><th data-tooltip="Rumore di fondo del canale radio misurato dal chip, in dBm. Valori più negativi indicano un canale più silenzioso; un innalzamento persistente segnala interferenze o canale affollato.">Noise Floor</th><td>${status.noise_floor != null ? status.noise_floor + " dBm" : "n/a"}</td></tr>
        <tr><th data-tooltip="Potenza del segnale (RSSI, in dBm) dell'ultimo pacchetto ricevuto. Più vicino a 0 = segnale più forte.">Last RSSI</th><td>${status.last_rssi != null ? status.last_rssi + " dBm" : "n/a"}</td></tr>
        <tr><th data-tooltip="Rapporto segnale/rumore (SNR, in dB) dell'ultimo pacchetto ricevuto: quanto il segnale utile emerge sul rumore di fondo. Valori più alti indicano una ricezione più pulita.">Last SNR</th><td>${status.last_snr != null ? status.last_snr + " dB" : "n/a"}</td></tr>
        <tr><th data-tooltip="Numero di pacchetti attualmente in coda in attesa di trasmissione, sul totale della coda disponibile. Una coda spesso piena indica che il canale radio non riesce a smaltire il traffico alla velocità con cui viene generato.">TX Queue</th><td>${status.queue_len != null ? status.queue_len + " / 16" : "n/a"}</td></tr>
        <tr><th data-tooltip="Bitmask di eventi del dispatcher radio a basso livello (es. coda piena, timeout CAD, timeout di avvio ricezione) — NON un conteggio di pacchetti, né lo stesso dato di &quot;Receive Errors (CRC Fail)&quot; qui sotto nonostante il nome simile.">Error Flags (bitmask)</th><td>${status.errors ?? "n/a"}</td></tr>
        <tr><th data-tooltip="Totale dei pacchetti ricevuti dal boot che hanno superato il controllo CRC e sono arrivati al livello mesh (somma di flood + direct).">Packets Received</th><td>${status.recv != null ? status.recv + " pkts" : "n/a"}</td></tr>
        <tr><th data-tooltip="Totale dei pacchetti trasmessi dal boot (somma di flood + direct).">Packets Sent</th><td>${status.sent != null ? status.sent + " pkts" : "n/a"}</td></tr>
        <tr><th data-tooltip="Pacchetti trasmessi suddivisi per modalità di instradamento: in flood (rilanciati da tutti i nodi che li sentono) o diretti (instradati verso un percorso specifico).">Sent (Flood | Direct)</th><td>${status.flood_tx != null ? status.flood_tx + " pkts" : "n/a"} | ${status.direct_tx != null ? status.direct_tx + " pkts" : "n/a"}</td></tr>
        <tr><th data-tooltip="Pacchetti ricevuti suddivisi per la modalità di instradamento con cui sono arrivati: flood o diretti.">Received (Flood | Direct)</th><td>${status.flood_rx != null ? status.flood_rx + " pkts" : "n/a"} | ${status.direct_rx != null ? status.direct_rx + " pkts" : "n/a"}</td></tr>
        <tr><th data-tooltip="Pacchetti fisicamente ricevuti dal chip radio (preambolo/sync/header validi) il cui payload però ha fallito il controllo CRC in lettura. Non indica solo collisioni: anche segnale debole, interferenze o un pacchetto troncato producono lo stesso effetto.">Receive Errors (CRC Fail)</th><td>${status.recv_errors != null ? status.recv_errors + " pkts" : "n/a"}</td></tr>
        <tr><th data-tooltip="Percentuale di pacchetti fisicamente ricevuti persi per errore CRC: Receive Errors / (Packets Received + Receive Errors) × 100. Mostra n/a se non è stato fisicamente ricevuto alcun pacchetto.">CRC Error Rate (RX)</th><td>${formatCrcErrorRate(status.recv_errors, status.recv)}</td></tr>
        <tr><th data-tooltip="Tempo cumulativo, dall'avvio, passato rispettivamente a trasmettere e a ricevere pacchetti effettivi (non il tempo totale con la radio accesa).">Airtime (TX | RX)</th><td>${formatDurationLong(status.tx_air_secs)} | ${formatDurationLong(status.rx_air_secs)}</td></tr>
        <tr><th data-tooltip="Percentuale di uptime in cui il canale è stato occupato da traffico, proprio in TX più altrui rilevato in RX: (Airtime TX + Airtime RX) / Uptime × 100. Indica quanto è congestionata la mesh nei dintorni, non il rispetto di un limite normativo.">Airtime % (mesh, TX+RX/Uptime)</th><td>${formatAirtimePercent(status.tx_air_secs, status.rx_air_secs, status.uptime_secs)}</td></tr>
        <tr><th data-tooltip="Percentuale di uptime passata in trasmissione: Airtime TX / Uptime × 100. Solo TX: confrontabile direttamente con &quot;Duty Cycle&quot; nella tabella Config dei Repeaters (anch'esso solo TX) per vedere quanto ci si avvicina al limite impostato.">TX Duty Cycle (observed, TX/Uptime)</th><td>${formatTxDutyCyclePercent(status.tx_air_secs, status.uptime_secs)}</td></tr>
        <tr><th data-tooltip="Versione e build del firmware in esecuzione sul device companion collegato localmente a trace-mon, riportata da una query diretta al device (non un comando CLI come per i Repeaters).">Firmware Version</th><td>${escapeHtml(status.fw_version ?? "n/a")}${status.fw_build ? ` (${escapeHtml(status.fw_build)})` : ""}</td></tr>
        <tr><th data-tooltip="Modello hardware del device companion collegato localmente a trace-mon (es. la scheda su cui gira il firmware), riportato da una query diretta al device.">Hardware</th><td>${escapeHtml(status.model ?? "n/a")}</td></tr>
    `;
}

function updateNodesHeading(nodes) {

    const heading =
        document.getElementById(
            "nodesTabHeading"
        );

    if (
        !heading
    ) {

        return;
    }

    const total =
        nodes.length;

    const chatCount =
        nodes.filter(
            n => n.node_type === 1
        ).length;

    const repeaterCount =
        nodes.filter(
            n => n.node_type === 2
        ).length;

    const roomServerCount =
        nodes.filter(
            n => n.node_type === 3
        ).length;

    heading.textContent =
        `Known Nodes - ${total} (${chatCount} chat | ${repeaterCount} repeaters | ${roomServerCount} room server)`;
}

function renderNodesTable(
    nodes
) {

    updateNodesHeading(
        nodes
    );

    const table =
        document.getElementById(
            "nodesTable"
        );

    let html =
        "<tr><th>Name</th><th>Type</th><th>Advert Time</th><th>Path</th></tr>";

    nodes.forEach(
        n => {

            html += "<tr>";
            html += `<td><a href="#" class="nodeLink" data-key="${escapeHtml(n.public_key)}">${escapeHtml(n.adv_name) || "(unknown)"}</a></td>`;
            html += `<td>${formatNodeType(n.node_type)}</td>`;
            html += `<td>${formatUnixTime(n.last_advert)}</td>`;
            html += `<td>${buildAdvertPathHtml(n.hop_count, n.path_hex)}</td>`;
            html += "</tr>";
        }
    );

    //
    // Allineato allo stile Repeaters (renderNeighboursTable): header
    // sempre presente, riga esplicita con colspan quando la lista è
    // vuota, invece di lasciare silenziosamente solo l'header senza
    // righe (v. docs/ARCHITECTURE.md §65). Distingue i due casi
    // possibili guardando nodesDataCache (il totale non filtrato)
    // rispetto a "nodes" (il risultato dopo i filtri correnti).
    //
    if (
        nodes.length === 0
    ) {

        const message =
            nodesDataCache.length === 0
                ? "No nodes data available."
                : "No nodes match the current filters.";

        html += `<tr><td colspan="4">${message}</td></tr>`;
    }

    table.innerHTML = html;

    table.querySelectorAll(
        ".nodeLink"
    ).forEach(
        link => {

            link.addEventListener(
                "click",
                (e) => {

                    e.preventDefault();

                    goToNodeDetail(
                        link.dataset.key
                    );
                }
            );
        }
    );
}

/* =========================
   NODE DETAIL
========================= */

function goToNodeDetail(
    publicKey
) {

    //
    // Ferma l'auto-refresh di Nodes: restava attivo anche qui prima
    // (nessuna tab "nodeDetailPage" a sé nel click handler di
    // index.html che lo fermasse), ricaricando inutilmente la
    // tabella Nodes nascosta mentre si guarda il dettaglio di un
    // nodo. backToNodesLink lo riavvia esplicitamente al ritorno.
    //
    if (
        typeof stopNodesAutoRefresh === "function"
    ) {

        stopNodesAutoRefresh();
    }

    document.querySelectorAll(
        ".tabButton"
    ).forEach(
        b => b.classList.remove("active")
    );

    document.querySelectorAll(
        ".tabPage"
    ).forEach(
        p => p.style.display = "none"
    );

    document.getElementById(
        "nodeDetailPage"
    ).style.display = "block";

    loadNodeDetail(
        publicKey
    );
}

async function loadNodeDetail(
    publicKey
) {

    //
    // Token catturato ORA: se l'utente apre un altro nodo (o cambia
    // periodo via switchNodeDetailPeriod) prima che questa chiamata
    // finisca, requestId non sarà più quello corrente ai controlli
    // sotto e il risultato tardivo viene scartato invece di
    // sovrascrivere la vista del nodo aperto nel frattempo.
    //
    const requestId =
        ++nodeDetailRequestId;

    nodeDetailCurrentPublicKey =
        publicKey;

    document.getElementById(
        "nodeDetailName"
    ).textContent =
        "Loading...";

    document.getElementById(
        "nodeDetailInfoTable"
    ).innerHTML = "";

    document.getElementById(
        "nodeDetailObsTable"
    ).innerHTML = "";

    //
    // Ogni volta che si apre un nodo si riparte da Live — un mese
    // archiviato scelto per il nodo precedente non ha senso
    // riproposto qui, a differenza del selettore Trace (che è una
    // preferenza di pagina, non legata a un singolo elemento).
    //
    await loadNodeDetailArchiveList();

    if (
        requestId !== nodeDetailRequestId
    ) {

        return;
    }

    const selector =
        document.getElementById(
            "nodeDetailArchiveSelector"
        );

    if (
        selector
    ) {

        selector.value =
            "live";
    }

    try {

        const res =
            await fetch(
                `/api/nodes/${encodeURIComponent(publicKey)}`
            );

        if (
            requestId !== nodeDetailRequestId
        ) {

            return;
        }

        if (
            !res.ok
        ) {

            document.getElementById(
                "nodeDetailName"
            ).textContent =
                "Error loading node.";

            return;
        }

        const data =
            await res.json();

        if (
            requestId !== nodeDetailRequestId
        ) {

            return;
        }

        renderNodeDetail(
            data
        );

    }

    catch (
        err
    ) {

        if (
            requestId !== nodeDetailRequestId
        ) {

            return;
        }

        console.error(
            "Error loading node detail:",
            err
        );

        document.getElementById(
            "nodeDetailName"
        ).textContent =
            "Error loading node.";
    }
}

async function loadNodeDetailArchiveList() {

    const selector =
        document.getElementById(
            "nodeDetailArchiveSelector"
        );

    if (
        !selector
    ) {

        return;
    }

    const requestId =
        ++nodeDetailArchiveListRequestId;

    try {

        const res =
            await fetch(
                "/api/nodes/archive/list"
            );

        assertResOk(res);

        const sources =
            await res.json();

        if (
            requestId !== nodeDetailArchiveListRequestId
        ) {

            return;
        }

        selector.innerHTML =
            "";

        sources.forEach(
            source => {

                const opt =
                    document.createElement(
                        "option"
                    );

                opt.value =
                    source.id;

                opt.textContent =
                    source.label;

                selector.appendChild(
                    opt
                );
            }
        );

    }

    catch (
        err
    ) {

        if (
            requestId !== nodeDetailArchiveListRequestId
        ) {

            return;
        }

        console.error(
            "Error loading node archive list:",
            err
        );
    }
}

async function switchNodeDetailPeriod(
    source
) {

    if (
        !nodeDetailCurrentPublicKey
    ) {

        return;
    }

    const publicKey =
        nodeDetailCurrentPublicKey;

    //
    // Stesso token di correlazione di loadNodeDetail() — condiviso
    // tra le due funzioni perché scrivono sulla stessa vista: aprire
    // un nodo diverso (o cambiare periodo di nuovo) mentre questa
    // fetch è in volo deve scartarne il risultato, chiunque delle
    // due l'abbia avviata.
    //
    const requestId =
        ++nodeDetailRequestId;

    try {

        let observations;

        if (
            source === "live"
        ) {

            //
            // Riusa l'endpoint live esistente — mantiene anche le
            // info identità nodo allineate, non solo le
            // osservazioni (coerente col fatto che "Live" riflette
            // lo stato corrente del nodo, non solo il suo storico).
            //
            const res =
                await fetch(
                    `/api/nodes/${encodeURIComponent(publicKey)}`
                );

            if (
                requestId !== nodeDetailRequestId
            ) {

                return;
            }

            if (
                !res.ok
            ) {

                return;
            }

            const data =
                await res.json();

            if (
                requestId !== nodeDetailRequestId
            ) {

                return;
            }

            renderNodeDetail(
                data
            );

            return;
        }

        const res =
            await fetch(
                `/api/nodes/${encodeURIComponent(publicKey)}/archive/load?file=` +
                encodeURIComponent(
                    source
                )
            );

        if (
            requestId !== nodeDetailRequestId
        ) {

            return;
        }

        if (
            !res.ok
        ) {

            document.getElementById(
                "nodeDetailObsTable"
            ).innerHTML =
                "<tr><td>Error loading archive.</td></tr>";

            return;
        }

        const data =
            await res.json();

        if (
            requestId !== nodeDetailRequestId
        ) {

            return;
        }

        observations =
            data.observations ||
            [];

        //
        // Solo storico osservazioni (grafico+tabella) — le info
        // identità nodo in cima restano quelle live, un mese
        // archiviato non ha un suo "stato del nodo" a sé.
        //
        renderNodeDetailChart(
            observations
        );

        renderNodeDetailObsTable(
            observations
        );

        //
        // Guardia TypeError (code review 2026-08-20, §4) —
        // l'elemento #nodeDetailObsCount viene creato dentro
        // l'innerHTML di #nodeDetailInfoTable in renderNodeDetail():
        // se questa funzione viene chiamata prima che
        // renderNodeDetail() abbia mai fatto il render iniziale
        // (race sul cambio rapido di periodo/nodo), getElementById()
        // torna null e ".textContent = ..." lancerebbe un
        // TypeError non gestito, interrompendo silenziosamente lo
        // script per il resto della pagina.
        //
        const obsCountEl =
            document.getElementById(
                "nodeDetailObsCount"
            );

        if (
            obsCountEl
        ) {

            obsCountEl.textContent =
                observations.length;
        }
    }

    catch (
        err
    ) {

        if (
            requestId !== nodeDetailRequestId
        ) {

            return;
        }

        console.error(
            "Error switching node detail period:",
            err
        );
    }
}

function renderNodeDetail(
    data
) {

    const node =
        data.node;

    const observations =
        data.observations ||
        [];

    document.getElementById(
        "nodeDetailName"
    ).textContent =
        node.adv_name ||
        "(unknown)";

    const infoTable =
        document.getElementById(
            "nodeDetailInfoTable"
        );

    infoTable.innerHTML = `
        <tr><th>Type</th><td>${formatNodeType(node.node_type)}</td></tr>
        <tr><th>Public Key</th><td>${node.public_key}</td></tr>
        <tr><th>Position</th><td>${node.adv_lat ?? "-"}, ${node.adv_lon ?? "-"}</td></tr>
        <tr><th>Advert Time</th><td>${formatUnixTime(node.last_advert)}</td></tr>
        <tr><th>Last Activity</th><td>${formatUnixTime(node.last_seen)}</td></tr>
        <tr><th>Total Observations</th><td id="nodeDetailObsCount">${observations.length}</td></tr>
    `;

    renderNodeDetailChart(
        observations
    );

    renderNodeDetailObsTable(
        observations
    );
}

function renderNodeDetailObsTable(
    observations
) {

    const table =
        document.getElementById(
            "nodeDetailObsTable"
        );

    if (
        observations.length === 0
    ) {

        table.innerHTML =
            "<tr><td>No observations recorded.</td></tr>";

        return;
    }

    let html =
        "<tr><th>Received</th><th>Hops</th><th>Path</th><th>RSSI</th><th>SNR</th></tr>";

    //
    // Più recente in cima — stesso principio già usato in
    // tools/test_contacts_list.py lato Python.
    //
    [...observations]
        .reverse()
        .forEach(
            o => {

                html += "<tr>";
                html += `<td>${formatUnixTime(o.observed_at)}</td>`;
                html += `<td>${o.hop_count}</td>`;
                html += `<td>${buildAdvertPathHtml(o.hop_count, o.path_hex)}</td>`;
                html += `<td>${o.rssi ?? "-"}</td>`;
                html += `<td>${colorizeSnr(o.snr)}</td>`;
                html += "</tr>";
            }
        );

    table.innerHTML = html;
}

function renderNodeDetailChart(
    observations
) {

    if (
        nodeDetailChart
    ) {

        nodeDetailChart.destroy();

        nodeDetailChart = null;
    }

    const darkMode =
        document.body.classList.contains(
            "dark"
        );

    const tickColor =
        darkMode
            ? "#dddddd"
            : "#444444";

    const gridColor =
        darkMode
            ? "rgba(255,255,255,0.15)"
            : "rgba(0,0,0,0.10)";

    const rssiData =
        observations
            .filter(o => typeof o.rssi === "number")
            .map(o => ({ x: o.observed_at * 1000, y: o.rssi }));

    const snrData =
        observations
            .filter(o => typeof o.snr === "number")
            .map(o => ({ x: o.observed_at * 1000, y: o.snr }));

    const ctx =
        document.getElementById(
            "nodeDetailChart"
        );

    nodeDetailChart =
        new Chart(
            ctx,
            {
                type: "line",

                data: {
                    datasets: [
                        {
                            label: "RSSI (dBm)",
                            data: rssiData,
                            borderColor: "#4a90e2",
                            borderWidth: 2,
                            tension: 0.2,
                            pointRadius: 2,
                            yAxisID: "yRssi"
                        },
                        {
                            label: "SNR (dB)",
                            data: snrData,
                            borderColor: "#2e7d32",
                            borderWidth: 2,
                            tension: 0.2,
                            pointRadius: 2,
                            yAxisID: "ySnr"
                        }
                    ]
                },

                options: {

                    responsive: true,
                    maintainAspectRatio: false,
                    parsing: false,

                    scales: {

                        x: {
                            type: "linear",
                            ticks: {
                                color: tickColor,
                                callback: function (value) {

                                    return formatDateShort(new Date(value));
                                },
                                maxTicksLimit: 6
                            },
                            grid: { color: gridColor }
                        },

                        yRssi: {
                            type: "linear",
                            position: "left",
                            ticks: { color: tickColor },
                            grid: { color: gridColor },
                            title: { display: true, text: "RSSI (dBm)", color: tickColor }
                        },

                        ySnr: {
                            type: "linear",
                            position: "right",
                            ticks: { color: tickColor },
                            grid: { display: false },
                            title: { display: true, text: "SNR (dB)", color: tickColor }
                        }
                    },

                    plugins: {
                        legend: {
                            labels: { color: tickColor }
                        }
                    }
                }
            }
        );
}

/* =========================
   NEIGHBOURS TAB
========================= */

async function loadNeighborsRepeaterList() {

    const selector =
        document.getElementById(
            "neighborRepeaterSelector"
        );

    if (
        !selector
    ) {

        return;
    }

    const requestId =
        ++neighborsRepeaterListRequestId;

    try {

        const res =
            await fetch(
                "/api/neighbors/repeaters"
            );

        assertResOk(res);

        const repeaters =
            await res.json();

        if (
            requestId !== neighborsRepeaterListRequestId
        ) {

            return;
        }

        //
        // Preferisce restare sulla selezione corrente se ancora
        // valida (utile al refresh periodico), altrimenti recupera
        // l'ultima scelta salvata, altrimenti la prima disponibile —
        // stessa logica di preferenza già usata altrove nel
        // progetto.
        //
        const previousValue =
            selector.value;

        selector.innerHTML =
            "";

        repeaters.forEach(
            r => {

                const opt =
                    document.createElement(
                        "option"
                    );

                opt.value =
                    r.public_key;

                opt.textContent =
                    r.adv_name || "(unknown)";

                selector.appendChild(
                    opt
                );
            }
        );

        const saved =
            safeLocalStorageGet(
                "neighborRepeater"
            );

        if (
            previousValue &&
            repeaters.some(
                r => r.public_key === previousValue
            )
        ) {

            selector.value =
                previousValue;
        }

        else if (
            saved &&
            repeaters.some(
                r => r.public_key === saved
            )
        ) {

            selector.value =
                saved;
        }
    }

    catch (
        err
    ) {

        if (
            requestId !== neighborsRepeaterListRequestId
        ) {

            return;
        }

        console.error(
            "Error loading neighbor repeaters:",
            err
        );

        //
        // Prima di questa modifica un fallimento qui restava
        // invisibile all'utente (solo console.error): la tab
        // Repeaters sembrava semplicemente "senza repeater" invece di
        // segnalare un errore di rete/server. false segnala al
        // chiamante (loadNeighborsTab) di mostrare un messaggio
        // esplicito invece del generico "No repeater data available
        // yet." (v. docs/ARCHITECTURE.md §65).
        //
        return false;
    }
}

//
// Auto-refresh della tab Neighbours — legato alla visibilità della
// tab come per Nodes (nessuna preferenza on/off qui, a differenza di
// Trace). Prima questa tab non aveva alcun auto-refresh; il repeater
// aggiornato è sempre quello corrente (currentRepeaterPublicKey,
// impostato da renderNeighborData), non quello selezionato al
// momento dell'avvio del timer — così un cambio di repeater durante
// il periodo di refresh viene rispettato.
//
function startNeighborsAutoRefresh() {

    startAutoRefresh(
        async () => {

            if (
                currentRepeaterPublicKey
            ) {

                await loadNeighborData(
                    currentRepeaterPublicKey
                );
            }
        }
    );
}

function stopNeighborsAutoRefresh() {

    stopAutoRefresh();
}

//
// Estratto da loadNeighborsTab(): azzera lo stato della tab Repeaters
// mostrando un messaggio esplicito sul perché non c'è un repeater
// selezionato — "nessun repeater ancora" e "errore nel caricare la
// lista repeater" sono due situazioni diverse per l'utente (la
// seconda è un problema di rete/server, non l'assenza di dati) e
// prima di questa modifica venivano confuse nello stesso testo
// generico (v. docs/ARCHITECTURE.md §65).
//
function clearNeighborsView(
    message
) {

    document.getElementById(
        "neighborRepeaterName"
    ).textContent =
        message;

    document.getElementById(
        "neighborStatusTable"
    ).innerHTML = "";

    document.getElementById(
        "neighborTelemetryTable"
    ).innerHTML = "";

    document.getElementById(
        "neighborConfigTable"
    ).innerHTML = "";

    document.getElementById(
        "neighborRegionDump"
    ).textContent = "";

    document.getElementById(
        "neighborsTable"
    ).innerHTML = "";

    currentRepeaterPublicKey = null;

    const archiveSelector =
        document.getElementById(
            "neighborsArchiveSelector"
        );

    if (
        archiveSelector
    ) {

        archiveSelector.innerHTML = "";
    }

    const snapshotSelector =
        document.getElementById(
            "neighborsSnapshotSelector"
        );

    if (
        snapshotSelector
    ) {

        snapshotSelector.innerHTML = "";
        snapshotSelector.style.display = "none";
    }
}

async function loadNeighborsTab() {

    const repeaterListOk =
        await loadNeighborsRepeaterList();

    if (
        repeaterListOk === false
    ) {

        clearNeighborsView(
            "Error loading repeater list."
        );

        return;
    }

    const selector =
        document.getElementById(
            "neighborRepeaterSelector"
        );

    if (
        !selector ||
        !selector.value
    ) {

        clearNeighborsView(
            "No repeater data available yet."
        );

        return;
    }

    await loadNeighborData(
        selector.value
    );
}

async function loadNeighborData(
    publicKey
) {

    //
    // Token catturato ORA: se l'utente seleziona un altro repeater
    // prima che questa fetch finisca, requestId non sarà più quello
    // corrente ai controlli sotto e il risultato tardivo (che
    // altrimenti sovrascriverebbe anche currentRepeaterPublicKey via
    // renderNeighborData) viene scartato.
    //
    const requestId =
        ++neighborRequestId;

    //
    // Niente azzeramento di nome/tabelle qui: come loadData()/
    // loadDeviceStatus()/loadNodesTab(), il contenuto del repeater
    // precedente resta visibile finché i nuovi dati non sono pronti,
    // poi renderNeighborData() sostituisce tutto atomicamente. Prima
    // di questa modifica questo era il blink più marcato dei due
    // segnalati (v. docs/ARCHITECTURE.md §65).
    //

    try {

        const res =
            await fetch(
                `/api/neighbors/${encodeURIComponent(publicKey)}`
            );

        assertResOk(
            res
        );

        const data =
            await res.json();

        if (
            requestId !== neighborRequestId
        ) {

            return;
        }

        renderNeighborData(
            data
        );
    }

    catch (
        err
    ) {

        if (
            requestId !== neighborRequestId
        ) {

            return;
        }

        console.error(
            "Error loading neighbor data:",
            err
        );

        document.getElementById(
            "neighborRepeaterName"
        ).textContent =
            "Error loading data.";
    }
}

function formatSecsAgo(
    secs
) {

    if (
        secs === null ||
        secs === undefined
    ) {

        return "n/a";
    }

    if (
        secs < 60
    ) {

        return `${secs}s ago`;
    }

    if (
        secs < 3600
    ) {

        return `${Math.floor(secs / 60)}m ago`;
    }

    if (
        secs < 86400
    ) {

        return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m ago`;
    }

    return `${Math.floor(secs / 86400)}d ago`;
}

//
// Soglia sotto la quale lo scarto è rumore di misura, non un
// problema reale di RTC del repeater — stessa soglia suggerita
// nell'analisi firmware che ha originato questa funzionalità.
//
const CLOCK_SKEW_SYNC_THRESHOLD_SECS = 60;

function formatClockSkew(
    skewSeconds
) {

    if (
        skewSeconds === null ||
        skewSeconds === undefined
    ) {

        return "n/a";
    }

    if (
        Math.abs(skewSeconds) < CLOCK_SKEW_SYNC_THRESHOLD_SECS
    ) {

        return "in sync";
    }

    //
    // formatDurationLong() lavora su valori non negativi (il modulo
    // JS su numeri negativi non si comporta come ci si aspetta) —
    // il segno lo aggiungiamo qui, separatamente.
    //
    const sign =
        skewSeconds > 0 ? "+" : "-";

    return `${sign}${formatDurationLong(Math.abs(skewSeconds))}`;
}

function formatDurationLong(
    secs
) {

    if (
        secs === null ||
        secs === undefined
    ) {

        return "n/a";
    }

    const days =
        Math.floor(secs / 86400);

    const hours =
        Math.floor((secs % 86400) / 3600);

    const minutes =
        Math.floor((secs % 3600) / 60);

    return `${days}d ${hours}h ${minutes}m`;
}

//
// Percentuale di canale occupato dal traffico di QUESTO repeater
// (TX+RX) sul totale del suo uptime — metrica di "channel
// utilization" locale, concettualmente diversa dal Duty Cycle
// normativo mostrato in Config (quello è TX-only e riguarda i
// vincoli regolamentari sulla trasmissione, non quanto canale è
// stato occupato in totale). rx_airtime conta solo il tempo speso a
// ricevere pacchetti effettivi (preamble/payload rilevati), non
// tutto il tempo in ascolto — quindi TX+RX qui è un proxy ragionevole
// di "quanto era carico il canale", non un doppio conteggio del
// tempo di ascolto passivo. Guardia su uptime nullo/zero: nessuna
// divisione per zero, "n/a" come per gli altri campi mancanti.
//
function formatAirtimePercent(
    tx_secs,
    rx_secs,
    uptime_secs
) {

    if (
        tx_secs === null || tx_secs === undefined ||
        rx_secs === null || rx_secs === undefined ||
        !uptime_secs
    ) {

        return "n/a";
    }

    const pct =
        ((tx_secs + rx_secs) / uptime_secs) * 100;

    return `${pct.toFixed(2)}%`;
}

//
// TX Duty Cycle OSSERVATO — a differenza di Airtime % (mesh), qui
// conta solo il TX, esattamente come il meccanismo di autolimitazione
// del firmware (docs.meshcore.io/cli_commands: dopo ogni TX il
// repeater impone un silenzio forzato proporzionale al tempo di
// trasmissione appena fatto — un tetto, non una media forzata).
// Confrontabile mela-con-mela con "Duty Cycle" in Config
// (get dutycycle, stesso TX-only) per vedere quanto il traffico
// reale si avvicina al tetto impostato — a differenza di Airtime %
// (mesh), che include anche RX e non è mai stato pensato per questo
// confronto (RX non è soggetto ad alcun limite normativo). Stessa
// guardia su uptime nullo/zero di formatAirtimePercent().
//
function formatTxDutyCyclePercent(
    tx_secs,
    uptime_secs
) {

    if (
        tx_secs === null || tx_secs === undefined ||
        !uptime_secs
    ) {

        return "n/a";
    }

    const pct =
        (tx_secs / uptime_secs) * 100;

    return `${pct.toFixed(2)}%`;
}

//
// Tasso di errore CRC in ricezione — vedi
// docs/RECEIVE_ERRORS_CRC.md per la ricostruzione completa dal
// sorgente del firmware (RadioLibWrappers.cpp, recvRaw()).
// nb_recv (pacchetti che hanno superato il CRC, arrivati al livello
// mesh) e recv_errors (quelli che l'hanno fallito, scartati prima di
// arrivare al livello mesh) sono mutuamente esclusivi per
// costruzione — insieme coprono tutti i pacchetti per cui il chip
// radio ha generato un interrupt RX_DONE (preambolo/sync/header
// validi). Stessa guardia sulle altre percentuali: nessun pacchetto
// fisicamente ricevuto (nb_recv+recv_errors=0) → "n/a", non 0.00%
// (0% implicherebbe "zero errori su un campione", non "nessun
// campione").
//
function formatCrcErrorRate(
    recv_errors,
    nb_recv
) {

    if (
        recv_errors === null || recv_errors === undefined ||
        nb_recv === null || nb_recv === undefined
    ) {

        return "n/a";
    }

    const total =
        nb_recv + recv_errors;

    if (
        !total
    ) {

        return "n/a";
    }

    const pct =
        (recv_errors / total) * 100;

    return `${pct.toFixed(2)}%`;
}

function formatTelemetryType(
    type
) {

    if (
        !type
    ) {

        return "Unknown";
    }

    //
    // Nome canale LPP già risolto in stringa dalla libreria
    // meshcore_py (es. "voltage", "temperature") — qui solo
    // capitalizzato per la UI, nessuna traduzione/mappatura propria.
    //
    return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatTelemetryValue(
    type,
    value
) {

    if (
        type === "voltage"
    ) {

        return `${value} V`;
    }

    if (
        type === "temperature"
    ) {

        return `${value} °C`;
    }

    //
    // Unità note solo per i due canali attualmente riportati da
    // IK2XYP-RPT (vedi docs/NEIGHBOR_MONITORING.md). Per qualunque
    // altro tipo LPP, valore grezzo senza unità — meglio un dato
    // spoglio ma corretto che un'unità inventata.
    //
    return `${value}`;
}

function renderNeighborData(
    data
) {

    currentRepeaterPublicKey =
        data.public_key;

    resetNeighboursArchiveSelectors();

    document.getElementById(
        "neighborRepeaterName"
    ).textContent =
        data.adv_name || "(unknown)";

    const statusTable =
        document.getElementById(
            "neighborStatusTable"
        );

    const status =
        data.status;

    const clock =
        data.clock;

    if (
        !status
    ) {

        statusTable.innerHTML =
            "<tr><td>No status data available.</td></tr>" +
            `<tr><th data-tooltip="Differenza tra l'orologio dichiarato dal repeater e quello di questo host, in secondi. Positivo = orologio del repeater avanti. Uno scarto di giorni segnala tipicamente un repeater senza RTC esterno mai risincronizzato.">Clock Skew</th><td>${formatClockSkew(clock ? clock.skew_seconds : null)}</td></tr>`;
    }

    else {

        statusTable.innerHTML = `
            <tr><th data-tooltip="Data e ora dell'ultima interrogazione riuscita a questo repeater. Le richieste con esito negativo (timeout, permesso ACL mancante o rimosso) non producono una nuova riga: qui resta sempre visibile l'ultimo dato disponibile, con la sua età.">Queried At</th><td>${formatUnixTime(status.queried_at)}</td></tr>
            <tr><th data-tooltip="Tensione della batteria, riportata dal device in millivolt e convertita qui in Volt.">Battery</th><td>${(status.bat / 1000).toFixed(2)}V</td></tr>
            <tr><th data-tooltip="Tempo trascorso dall'ultimo avvio del device, nel formato giorni/ore/minuti.">Uptime</th><td>${formatDurationLong(status.uptime)}</td></tr>
            <tr><th data-tooltip="Rumore di fondo del canale radio misurato dal chip, in dBm. Valori più negativi indicano un canale più silenzioso; un innalzamento persistente segnala interferenze o canale affollato.">Noise Floor</th><td>${status.noise_floor} dBm</td></tr>
            <tr><th data-tooltip="Potenza del segnale (RSSI, in dBm) dell'ultimo pacchetto ricevuto. Più vicino a 0 = segnale più forte.">Last RSSI</th><td>${status.last_rssi} dBm</td></tr>
            <tr><th data-tooltip="Rapporto segnale/rumore (SNR, in dB) dell'ultimo pacchetto ricevuto: quanto il segnale utile emerge sul rumore di fondo. Valori più alti indicano una ricezione più pulita.">Last SNR</th><td>${status.last_snr} dB</td></tr>
            <tr><th data-tooltip="Numero di pacchetti attualmente in coda sul repeater in attesa di trasmissione. Una coda spesso piena indica che il canale radio non riesce a smaltire il traffico alla velocità con cui viene generato.">TX Queue Length</th><td>${status.tx_queue_len}</td></tr>
            <tr><th data-tooltip="Totale dei pacchetti ricevuti dal boot che hanno superato il controllo CRC e sono arrivati al livello mesh (somma di flood + direct).">Packets Received</th><td>${status.nb_recv} pkts</td></tr>
            <tr><th data-tooltip="Totale dei pacchetti trasmessi dal boot (somma di flood + direct).">Packets Sent</th><td>${status.nb_sent} pkts</td></tr>
            <tr><th data-tooltip="Pacchetti trasmessi suddivisi per modalità di instradamento: in flood (rilanciati da tutti i nodi che li sentono) o diretti (instradati verso un percorso specifico).">Sent (Flood | Direct)</th><td>${status.sent_flood} pkts | ${status.sent_direct} pkts</td></tr>
            <tr><th data-tooltip="Pacchetti ricevuti suddivisi per la modalità di instradamento con cui sono arrivati: flood o diretti.">Received (Flood | Direct)</th><td>${status.recv_flood} pkts | ${status.recv_direct} pkts</td></tr>
            <tr><th data-tooltip="Pacchetti ricevuti CORRETTAMENTE (CRC valido) ma già visti in precedenza — deduplica a livello mesh, non un errore radio. Mutuamente esclusivo da &quot;Receive Errors (CRC Fail)&quot;: un pacchetto o fallisce il CRC (non può mai risultare duplicato) o lo supera (dove può risultare nuovo o duplicato).">Duplicates (Direct | Flood)</th><td>${status.direct_dups} pkts | ${status.flood_dups} pkts</td></tr>
            <tr><th data-tooltip="Pacchetti fisicamente ricevuti dal chip radio (preambolo/sync/header validi) il cui payload però ha fallito il controllo CRC in lettura. Non indica solo collisioni: anche segnale debole, interferenze o un pacchetto troncato producono lo stesso effetto.">Receive Errors (CRC Fail)</th><td>${status.recv_errors != null ? status.recv_errors + " pkts" : "n/a"}</td></tr>
            <tr><th data-tooltip="Percentuale di pacchetti fisicamente ricevuti persi per errore CRC: Receive Errors / (Packets Received + Receive Errors) × 100. Mostra n/a se non è stato fisicamente ricevuto alcun pacchetto.">CRC Error Rate (RX)</th><td>${formatCrcErrorRate(status.recv_errors, status.nb_recv)}</td></tr>
            <tr><th data-tooltip="Numero di volte in cui la coda di trasmissione del repeater era piena e un pacchetto non ha potuto essere accodato — indicatore di saturazione sotto carico.">Full Events</th><td>${status.full_evts}</td></tr>
            <tr><th data-tooltip="Tempo cumulativo, dall'avvio, passato rispettivamente a trasmettere e a ricevere pacchetti effettivi (non il tempo totale con la radio accesa).">Airtime (TX | RX)</th><td>${formatDurationLong(status.airtime)} | ${formatDurationLong(status.rx_airtime)}</td></tr>
            <tr><th data-tooltip="Percentuale di uptime in cui il canale è stato occupato da traffico, proprio in TX più altrui rilevato in RX: (Airtime TX + Airtime RX) / Uptime × 100. Indica quanto è congestionata la mesh nei dintorni, non il rispetto di un limite normativo.">Airtime % (mesh, TX+RX/Uptime)</th><td>${formatAirtimePercent(status.airtime, status.rx_airtime, status.uptime)}</td></tr>
            <tr><th data-tooltip="Percentuale di uptime passata in trasmissione: Airtime TX / Uptime × 100. Solo TX: confrontabile direttamente con &quot;Duty Cycle&quot; nella tabella Config dei Repeaters (anch'esso solo TX) per vedere quanto ci si avvicina al limite impostato.">TX Duty Cycle (observed, TX/Uptime)</th><td>${formatTxDutyCyclePercent(status.airtime, status.uptime)}</td></tr>
            <tr><th data-tooltip="Differenza tra l'orologio dichiarato dal repeater e quello di questo host, in secondi. Positivo = orologio del repeater avanti. Uno scarto di giorni segnala tipicamente un repeater senza RTC esterno mai risincronizzato.">Clock Skew</th><td>${formatClockSkew(clock ? clock.skew_seconds : null)}</td></tr>
        `;
    }

    const telemetryTable =
        document.getElementById(
            "neighborTelemetryTable"
        );

    const telemetry =
        data.telemetry || [];

    let telemetryHtml =
        "<tr><th>Channel</th><th>Type</th><th>Value</th></tr>";

    telemetry.forEach(
        t => {

            telemetryHtml += "<tr>";
            telemetryHtml += `<td>${t.channel}</td>`;
            telemetryHtml += `<td>${formatTelemetryType(t.type)}</td>`;
            telemetryHtml += `<td>${formatTelemetryValue(t.type, t.value)}</td>`;
            telemetryHtml += "</tr>";
        }
    );

    if (
        telemetry.length === 0
    ) {

        telemetryHtml +=
            "<tr><td colspan=\"3\">No telemetry data available.</td></tr>";
    }

    telemetryTable.innerHTML =
        telemetryHtml;

    const configTable =
        document.getElementById(
            "neighborConfigTable"
        );

    const config =
        data.config;

    if (
        !config
    ) {

        configTable.innerHTML =
            "<tr><td>No config data available.</td></tr>";
    }

    else {

        //
        // Finding 4, code review 2026-08-20 (review indipendente
        // successiva a Rev.6): firmware_version/hardware/
        // region_default sotto sono testo grezzo restituito dai
        // comandi CLI "ver"/"board"/"region default" su un repeater
        // REMOTO — a differenza di public_key (hex a formato fisso,
        // v. distinzione già documentata in Rev.4/Rev5), nessun
        // vincolo di formato/lunghezza a monte
        // (mesh_modules/neighbor_monitor/neighbor_monitor.py,
        // CLI_QUERIES: value_type=str, passthrough diretto). Stessa
        // categoria di adv_name/matched_names ("annuncio libero"),
        // quindi sempre da escapeHtml() prima di iniettarli in
        // innerHTML, esattamente come quei due campi. Gli altri
        // valori di questa tabella (path_hash_mode/txdelay/
        // direct_txdelay/rxdelay/flood_max*/dutycycle) sono tutti
        // numerici (value_type=int/float/_parse_percent in
        // CLI_QUERIES) — nessun rischio di injection, non toccati.
        //
        configTable.innerHTML = `
            <tr><th data-tooltip="Versione e build del firmware in esecuzione sul repeater, riportata dal comando CLI &quot;ver&quot; (richiede login con permesso admin nell'ACL).">Firmware Version</th><td>${escapeHtml(config.firmware_version ?? "n/a")}</td></tr>
            <tr><th data-tooltip="Nome/modello dell'hardware del repeater (es. la scheda o il modulo su cui gira il firmware), riportato dal comando CLI &quot;board&quot; (richiede login con permesso admin nell'ACL).">Hardware</th><td>${escapeHtml(config.hardware ?? "n/a")}</td></tr>
            <tr><th data-tooltip="Dimensione in byte dell'hash usato per identificare i pacchetti in flood (0 = 1 byte/256 ID unici, 1 = 2 byte/65.536 ID, 2 = 3 byte). Un hash più corto pesa meno nel pacchetto ma satura prima lo spazio di ID unici su reti con molto traffico flood.">Path Hash Mode</th><td>${config.path_hash_mode ?? "n/a"}</td></tr>
            <tr><th data-tooltip="Fattore che scala il ritardo casuale prima di ritrasmettere un pacchetto flood: quando più repeater vicini sentono lo stesso pacchetto, ciascuno attende un tempo casuale prima di rilanciarlo, per evitare che ritrasmettano tutti insieme collidendo. 0 disabilita il ritardo.">TX Delay (Flood)</th><td>${config.txdelay ?? "n/a"}</td></tr>
            <tr><th data-tooltip="Come &quot;TX Delay (Flood)&quot; ma per i pacchetti instradati direttamente verso un hop specifico: valore tipicamente più basso perché meno nodi competono per ritrasmettere lo stesso pacchetto.">TX Delay (Direct)</th><td>${config.direct_txdelay ?? "n/a"}</td></tr>
            <tr><th data-tooltip="Funzione sperimentale: i pacchetti flood ricevuti con segnale debole vengono trattenuti brevemente in una coda di ritardo, dando la precedenza ai repeater che li hanno ricevuti con segnale forte, per ridurre ritrasmissioni ridondanti.">RX Delay</th><td>${config.rxdelay ?? "n/a"}</td></tr>
            <tr><th data-tooltip="Numero massimo di salti (hop) che un pacchetto instradato in flood può percorrere prima di essere scartato.">Flood Max Hops</th><td>${config.flood_max ?? "n/a"}</td></tr>
            <tr><th data-tooltip="Come &quot;Flood Max Hops&quot;, ma applicato ai pacchetti flood privi di un ambito/regione (transport code) specifico.">Flood Max Hops (Unscoped)</th><td>${config.flood_max_unscoped ?? "n/a"}</td></tr>
            <tr><th data-tooltip="Numero massimo di salti per i soli pacchetti di advert (annuncio di presenza del nodo) in flood — di norma un limite più basso rispetto al traffico flood generico.">Flood Max Hops (Advert)</th><td>${config.flood_max_advert ?? "n/a"}</td></tr>
            <tr><th data-tooltip="Regione radio predefinita usata dal repeater quando un pacchetto non ne specifica una esplicitamente.">Default Region</th><td>${escapeHtml(config.region_default ?? "n/a")}</td></tr>
            <tr><th data-tooltip="Autolimitazione imposta dal firmware stesso: dopo ogni trasmissione, il repeater si impone un silenzio proporzionale al tempo appena trasmesso, per rispettare i limiti normativi di banda (es. 10% sotto 868MHz in Europa). Riguarda solo il TX, mai la ricezione — non è una media misurata: confrontalo con &quot;TX Duty Cycle (observed)&quot; in Status, non con &quot;Airtime % (mesh)&quot; che include anche l'RX.">Duty Cycle</th><td>${config.dutycycle != null ? `${config.dutycycle}%` : "n/a"}</td></tr>
        `;
    }

    document.getElementById(
        "neighborRegionDump"
    ).textContent =
        data.region || "No region data available.";

    renderNeighboursTable(
        data.neighbours || []
    );
}

function renderNeighboursTable(
    neighbours
) {

    const heading =
        document.getElementById(
            "neighborsTabHeading"
        );

    if (
        heading
    ) {

        heading.textContent =
            `Neighbours - ${neighbours.length}`;
    }

    const neighborsTable =
        document.getElementById(
            "neighborsTable"
        );

    let html =
        "<tr><th>Name</th><th>Prefix</th><th>SNR</th><th>Last Seen</th></tr>";

    neighbours.forEach(
        n => {

            let nameCell;

            if (
                n.match_count === 0
            ) {

                nameCell =
                    "(unknown)";
            }

            else if (
                n.match_count === 1
            ) {

                nameCell =
                    escapeHtml(n.matched_names);
            }

            else {

                nameCell =
                    `${escapeHtml(n.matched_names)} (ambiguous)`;
            }

            html += "<tr>";
            html += `<td>${nameCell}</td>`;
            html += `<td>${escapeHtml(n.neighbour_prefix)}</td>`;
            html += `<td>${n.snr}</td>`;
            html += `<td>${formatSecsAgo(n.secs_ago)}</td>`;
            html += "</tr>";
        }
    );

    if (
        neighbours.length === 0
    ) {

        html += "<tr><td colspan=\"4\">No neighbours data available.</td></tr>";
    }

    neighborsTable.innerHTML =
        html;
}

/* =========================
   NEIGHBOURS ARCHIVE (mese + scatto)

   A differenza dello storico dei Nodi (flusso continuo), un mese
   archiviato di neighbours contiene più "scatti" distinti — uno per
   ogni giro di cron. Due selettori: mese (o Live) e, quando non è
   Live, lo scatto specifico all'interno di quel mese. Vedi
   docs/NEIGHBOR_MONITORING.md §13.
========================= */

function resetNeighboursArchiveSelectors() {

    const snapshotSelector =
        document.getElementById(
            "neighborsSnapshotSelector"
        );

    if (
        snapshotSelector
    ) {

        snapshotSelector.innerHTML = "";
        snapshotSelector.style.display = "none";
    }

    loadNeighboursArchiveList();
}

async function loadNeighboursArchiveList() {

    const selector =
        document.getElementById(
            "neighborsArchiveSelector"
        );

    if (
        !selector
    ) {

        return;
    }

    const requestId =
        ++neighboursArchiveListRequestId;

    try {

        const res =
            await fetch(
                "/api/neighbors/archive/list"
            );

        assertResOk(res);

        const months =
            await res.json();

        if (
            requestId !== neighboursArchiveListRequestId
        ) {

            return;
        }

        selector.innerHTML = "";

        months.forEach(
            m => {

                const opt =
                    document.createElement(
                        "option"
                    );

                opt.value = m.id;
                opt.textContent = m.label;

                selector.appendChild(
                    opt
                );
            }
        );

        selector.value = "live";
    }

    catch (
        err
    ) {

        if (
            requestId !== neighboursArchiveListRequestId
        ) {

            return;
        }

        console.error(
            "Error loading neighbours archive list:",
            err
        );
    }
}

//
// onNeighboursArchiveChange()/onNeighboursSnapshotChange()/
// loadNeighboursSnapshot() condividono neighborRequestId con
// loadNeighborData() invece di avere un contatore proprio: scrivono
// tutte nella stessa area (tabella Neighbours / stato del repeater
// corrente), quindi un cambio di repeater mentre una di queste è in
// volo deve scartarne il risultato esattamente come già avviene tra
// loadNodeDetail()/switchNodeDetailPeriod() sullo stesso
// nodeDetailRequestId.
//
async function onNeighboursArchiveChange() {

    const archiveSelector =
        document.getElementById(
            "neighborsArchiveSelector"
        );

    const snapshotSelector =
        document.getElementById(
            "neighborsSnapshotSelector"
        );

    if (
        !archiveSelector ||
        !currentRepeaterPublicKey
    ) {

        return;
    }

    const requestId =
        ++neighborRequestId;

    const selectedFile =
        archiveSelector.value;

    if (
        selectedFile === "live" ||
        !selectedFile
    ) {

        snapshotSelector.innerHTML = "";
        snapshotSelector.style.display = "none";

        //
        // Ricarica tutto il repeater (Status/Telemetry/Config/Region
        // inclusi) — più semplice e sempre corretto che tenere una
        // cache separata dei soli dati live, a costo di una
        // richiesta in più su un'interazione poco frequente.
        // loadNeighborData() incrementa neighborRequestId una
        // seconda volta al suo interno: corretto, resta l'ultima
        // fetch avviata a vincere.
        //
        await loadNeighborData(
            currentRepeaterPublicKey
        );

        return;
    }

    try {

        const url =
            `/api/neighbors/${encodeURIComponent(currentRepeaterPublicKey)}` +
            `/archive/snapshots?file=${encodeURIComponent(selectedFile)}`;

        const res =
            await fetch(
                url
            );

        assertResOk(res);

        const snapshots =
            await res.json();

        if (
            requestId !== neighborRequestId
        ) {

            return;
        }

        snapshotSelector.innerHTML = "";

        snapshots.forEach(
            s => {

                const opt =
                    document.createElement(
                        "option"
                    );

                opt.value = s.queried_at;
                opt.textContent = s.label;

                snapshotSelector.appendChild(
                    opt
                );
            }
        );

        if (
            snapshots.length > 0
        ) {

            snapshotSelector.style.display = "";
            snapshotSelector.value = snapshots[0].queried_at;

            await loadNeighboursSnapshot(
                selectedFile,
                snapshots[0].queried_at
            );
        }

        else {

            snapshotSelector.style.display = "none";

            renderNeighboursTable(
                []
            );
        }
    }

    catch (
        err
    ) {

        if (
            requestId !== neighborRequestId
        ) {

            return;
        }

        console.error(
            "Error loading neighbours snapshots:",
            err
        );
    }
}

async function onNeighboursSnapshotChange() {

    const archiveSelector =
        document.getElementById(
            "neighborsArchiveSelector"
        );

    const snapshotSelector =
        document.getElementById(
            "neighborsSnapshotSelector"
        );

    if (
        !archiveSelector ||
        !snapshotSelector ||
        !currentRepeaterPublicKey
    ) {

        return;
    }

    const selectedFile =
        archiveSelector.value;

    const queriedAt =
        snapshotSelector.value;

    if (
        !selectedFile ||
        selectedFile === "live" ||
        !queriedAt
    ) {

        return;
    }

    await loadNeighboursSnapshot(
        selectedFile,
        queriedAt
    );
}

async function loadNeighboursSnapshot(
    file,
    queriedAt
) {

    const requestId =
        ++neighborRequestId;

    try {

        const url =
            `/api/neighbors/${encodeURIComponent(currentRepeaterPublicKey)}` +
            `/archive/load?file=${encodeURIComponent(file)}` +
            `&queried_at=${encodeURIComponent(queriedAt)}`;

        const res =
            await fetch(
                url
            );

        assertResOk(res);

        const neighbours =
            await res.json();

        if (
            requestId !== neighborRequestId
        ) {

            return;
        }

        renderNeighboursTable(
            neighbours
        );
    }

    catch (
        err
    ) {

        if (
            requestId !== neighborRequestId
        ) {

            return;
        }

        console.error(
            "Error loading neighbours archive snapshot:",
            err
        );

        renderNeighboursTable(
            []
        );
    }
}
