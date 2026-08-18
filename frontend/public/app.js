let dataCache = null;
let chart = null;
let autoRefreshTimer = null;
let meshNodes = {};
let currentRepeaterPublicKey = null;
let nodeDetailChart = null;
let nodesDataCache = [];

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
            localStorage.getItem(
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
        localStorage.getItem(
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

        if (
            !res.ok
        ) {

            throw new Error(
                `HTTP ${res.status}`
            );
        }

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

    if (
        meshNodes[nodeId]
    ) {

        return meshNodes[nodeId];
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
        ];
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
        `<span data-tooltip="${resolveNodeName(parts[0])}">${parts[0]}</span>` +
        "→" +
        `<span data-tooltip="${resolveNodeName(parts[1])}">${parts[1]}</span>`
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
function initTooltips() {

    let bubble = null;
    let activeTarget = null;

    function positionTooltip(x, y) {

        if (!bubble) {
            return;
        }

        const offset = 12;
        const rect = bubble.getBoundingClientRect();

        let left = x + offset;
        let top = y + offset;

        if (left + rect.width > window.innerWidth) {
            left = x - rect.width - offset;
        }

        if (top + rect.height > window.innerHeight) {
            top = y - rect.height - offset;
        }

        bubble.style.left = left + "px";
        bubble.style.top = top + "px";
    }

    function showTooltip(target, x, y) {

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

        positionTooltip(x, y);

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
    // Desktop — mouseover/mouseout invece di mouseenter/mouseleave:
    // questi ultimi non risalgono dai figli (niente bubbling),
    // indispensabile qui perché il listener è su document, non
    // sul singolo span.
    //
    document.addEventListener(
        "mouseover",
        e => {

            const target =
                e.target.closest("[data-tooltip]");

            if (target) {
                showTooltip(target, e.clientX, e.clientY);
            }
        }
    );

    document.addEventListener(
        "mousemove",
        e => {

            if (
                bubble &&
                activeTarget &&
                activeTarget.contains(e.target)
            ) {

                positionTooltip(e.clientX, e.clientY);
            }
        }
    );

    document.addEventListener(
        "mouseout",
        e => {

            if (e.target.closest("[data-tooltip]")) {
                hideTooltip();
            }
        }
    );

    //
    // Mobile — tap per aprire/chiudere, tap altrove per chiudere.
    // click copre sia il touch reale (i browser mobile emettono
    // click dopo un tap) sia il click del mouse su desktop, qui
    // innocuo dato che lì il tooltip è già aperto da mouseover.
    //
    document.addEventListener(
        "click",
        e => {

            const target =
                e.target.closest("[data-tooltip]");

            if (!target) {
                hideTooltip();
                return;
            }

            if (activeTarget === target) {
                hideTooltip();
            }
            else {
                const rect =
                    target.getBoundingClientRect();

                showTooltip(
                    target,
                    rect.left,
                    rect.bottom
                );
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
    localStorage.getItem(
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

localStorage.setItem(
    "selectedPath",
    selector.value
);

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
        data.pathObservations
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

function renderTable(rows) {

    const table =
        document.getElementById(
            "pathTable"
        );

    if (
        !rows ||
        rows.length === 0
    ) {

        table.innerHTML = "";
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
        r => {

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

    if (
        !stats
    ) {

        table.innerHTML =
            "";
        return;
    }

    let html =
        "<tr><th>Path Element</th><th>Avg</th><th>Min</th><th>Max</th></tr>";

    Object.entries(
        stats
    ).forEach(
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
        localStorage.getItem(
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
        localStorage.getItem(
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

            localStorage.setItem(
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

        localStorage.setItem(
            "dataSource",
            dataSourceSelector.value
        );

        const refreshBar =
            document.getElementById(
                "autoRefreshSelect"
            );

        if (
            refreshBar
        ) {

            if (
                dataSourceSelector.value ===
                "live"
            ) {

                refreshBar.disabled =
                    false;

                configureAutoRefresh();
            }

            else {

                refreshBar.value = "off";

                refreshBar.disabled =
                    true;

                stopAutoRefresh();
            }
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

            localStorage.setItem(
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
                localStorage.getItem(
                    "autoRefresh"
                ) ||
                "off";

const source =
    localStorage.getItem(
        "dataSource"
    ) || "live";

if (
    source !==
    "live"
) {

    refreshSelector.value =
        "off";

    refreshSelector.disabled =
        true;
}

            refreshSelector.addEventListener(
                "change",
                () => {

                    localStorage.setItem(
                        "autoRefresh",
                        refreshSelector.value
                    );

                    configureAutoRefresh();
                }
            );

            configureAutoRefresh();
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
                            localStorage.getItem(
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

                            localStorage.setItem(
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
        .map(hop => `<span data-tooltip="${resolveNodeName(hop)}">${hop}</span>`)
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

    table.innerHTML =
        "<tr><td>Loading...</td></tr>";

    const requestId =
        ++nodesTabRequestId;

    try {

        const res =
            await fetch(
                "/api/nodes"
            );

        const nodes =
            await res.json();

        if (
            requestId !== nodesTabRequestId
        ) {

            return;
        }

        nodesDataCache =
            nodes;

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

    const notObservedCheckbox =
        document.getElementById(
            "nodeNotObservedFilter"
        );

    const futureAdvertCheckbox =
        document.getElementById(
            "nodeFutureAdvertFilter"
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

    const notObservedFilter =
        notObservedCheckbox
            ? notObservedCheckbox.checked
            : false;

    const futureAdvertFilter =
        futureAdvertCheckbox
            ? futureAdvertCheckbox.checked
            : false;

    localStorage.setItem(
        "nodeNameFilter",
        nameFilter
    );

    localStorage.setItem(
        "nodePathFilter",
        pathFilter
    );

    localStorage.setItem(
        "nodeTypeFilter",
        typeFilter
    );

    localStorage.setItem(
        "nodePathLengthFilter",
        lengthFilter
    );

    localStorage.setItem(
        "nodeNotObservedFilter",
        notObservedFilter
    );

    localStorage.setItem(
        "nodeFutureAdvertFilter",
        futureAdvertFilter
    );

    //
    // name, path e type sono in OR tra loro (modi alternativi di
    // cercare/restringere lo stesso insieme di nodi, non condizioni
    // da soddisfare tutte insieme) — se più di uno è valorizzato, un
    // nodo compare se soddisfa ALMENO UNO. length, not-observed e
    // future-advert restano invece un affinamento in AND: non sono
    // criteri di ricerca, sono vincoli strutturali applicati sopra
    // il risultato della ricerca.
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

    const notObservedCheckbox =
        document.getElementById(
            "nodeNotObservedFilter"
        );

    const futureAdvertCheckbox =
        document.getElementById(
            "nodeFutureAdvertFilter"
        );

    if (
        !filterInput ||
        !lengthSelect
    ) {

        return;
    }

    const savedNameFilter =
        localStorage.getItem(
            "nodeNameFilter"
        ) || "";

    const savedFilter =
        localStorage.getItem(
            "nodePathFilter"
        ) || "";

    const savedType =
        localStorage.getItem(
            "nodeTypeFilter"
        ) || "all";

    const savedLength =
        localStorage.getItem(
            "nodePathLengthFilter"
        ) || "all";

    const savedNotObserved =
        localStorage.getItem(
            "nodeNotObservedFilter"
        ) === "true";

    const savedFutureAdvert =
        localStorage.getItem(
            "nodeFutureAdvertFilter"
        ) === "true";

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
        applyNodesFilters
    );

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
    // upsert_device_status() lato backend. ?? gestisce anche 0 come
    // valore legittimo (es. Errors: 0), a differenza di ||.
    //
    table.innerHTML = `
        <tr><th>Updated</th><td>${formatSecsAgo(secsAgo)}</td></tr>
        <tr><th>Uptime</th><td>${formatDurationLong(status.uptime_secs)}</td></tr>
        <tr><th>Battery</th><td>${status.battery_mv != null ? (status.battery_mv / 1000).toFixed(2) + "V" : "n/a"}</td></tr>
        <tr><th>TX Queue</th><td>${status.queue_len != null ? status.queue_len + " / 16" : "n/a"}</td></tr>
        <tr><th>Errors</th><td>${status.errors ?? "n/a"}</td></tr>
        <tr><th>Noise Floor</th><td>${status.noise_floor != null ? status.noise_floor + " dBm" : "n/a"}</td></tr>
        <tr><th>Last RSSI</th><td>${status.last_rssi != null ? status.last_rssi + " dBm" : "n/a"}</td></tr>
        <tr><th>Last SNR</th><td>${status.last_snr != null ? status.last_snr + " dB" : "n/a"}</td></tr>
        <tr><th>TX Airtime</th><td>${status.tx_air_secs != null ? status.tx_air_secs + "s" : "n/a"}</td></tr>
        <tr><th>RX Airtime</th><td>${status.rx_air_secs != null ? status.rx_air_secs + "s" : "n/a"}</td></tr>
        <tr><th>Packets Received</th><td>${status.recv ?? "n/a"}</td></tr>
        <tr><th>Packets Sent</th><td>${status.sent ?? "n/a"}</td></tr>
        <tr><th>Flood TX</th><td>${status.flood_tx ?? "n/a"}</td></tr>
        <tr><th>Flood RX</th><td>${status.flood_rx ?? "n/a"}</td></tr>
        <tr><th>Direct TX</th><td>${status.direct_tx ?? "n/a"}</td></tr>
        <tr><th>Direct RX</th><td>${status.direct_rx ?? "n/a"}</td></tr>
        <tr><th>Device</th><td>${status.model ?? "n/a"} running ${status.fw_build ?? "n/a"}/${status.fw_version ?? "n/a"}</td></tr>
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
            html += `<td><a href="#" class="nodeLink" data-key="${n.public_key}">${n.adv_name || "(unknown)"}</a></td>`;
            html += `<td>${formatNodeType(n.node_type)}</td>`;
            html += `<td>${formatUnixTime(n.last_advert)}</td>`;
            html += `<td>${buildAdvertPathHtml(n.hop_count, n.path_hex)}</td>`;
            html += "</tr>";
        }
    );

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

        document.getElementById(
            "nodeDetailObsCount"
        ).textContent =
            observations.length;
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
            localStorage.getItem(
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

async function loadNeighborsTab() {

    await loadNeighborsRepeaterList();

    const selector =
        document.getElementById(
            "neighborRepeaterSelector"
        );

    if (
        !selector ||
        !selector.value
    ) {

        document.getElementById(
            "neighborRepeaterName"
        ).textContent =
            "No repeater data available yet.";

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

    document.getElementById(
        "neighborRepeaterName"
    ).textContent =
        "Loading...";

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

    try {

        const res =
            await fetch(
                `/api/neighbors/${encodeURIComponent(publicKey)}`
            );

        if (
            requestId !== neighborRequestId
        ) {

            return;
        }

        if (
            !res.ok
        ) {

            document.getElementById(
                "neighborRepeaterName"
            ).textContent =
                "Error loading data.";

            return;
        }

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
            `<tr><th>Clock Skew</th><td>${formatClockSkew(clock ? clock.skew_seconds : null)}</td></tr>`;
    }

    else {

        statusTable.innerHTML = `
            <tr><th>Queried At</th><td>${formatUnixTime(status.queried_at)}</td></tr>
            <tr><th>Battery</th><td>${(status.bat / 1000).toFixed(2)}V</td></tr>
            <tr><th>Uptime</th><td>${formatDurationLong(status.uptime)}</td></tr>
            <tr><th>Noise Floor</th><td>${status.noise_floor} dBm</td></tr>
            <tr><th>Last RSSI</th><td>${status.last_rssi} dBm</td></tr>
            <tr><th>Last SNR</th><td>${status.last_snr} dB</td></tr>
            <tr><th>TX Queue Length</th><td>${status.tx_queue_len}</td></tr>
            <tr><th>Packets Received</th><td>${status.nb_recv}</td></tr>
            <tr><th>Packets Sent</th><td>${status.nb_sent}</td></tr>
            <tr><th>Sent (Flood / Direct)</th><td>${status.sent_flood} / ${status.sent_direct}</td></tr>
            <tr><th>Received (Flood / Direct)</th><td>${status.recv_flood} / ${status.recv_direct}</td></tr>
            <tr><th>Duplicates (Direct / Flood)</th><td>${status.direct_dups} / ${status.flood_dups}</td></tr>
            <tr><th>Receive Errors</th><td>${status.recv_errors ?? "n/a"}</td></tr>
            <tr><th>Full Events</th><td>${status.full_evts}</td></tr>
            <tr><th>Airtime (TX / RX)</th><td>${status.airtime} / ${status.rx_airtime}</td></tr>
            <tr><th>Clock Skew</th><td>${formatClockSkew(clock ? clock.skew_seconds : null)}</td></tr>
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

        configTable.innerHTML = `
            <tr><th>Firmware Version</th><td>${config.firmware_version ?? "n/a"}</td></tr>
            <tr><th>Path Hash Mode</th><td>${config.path_hash_mode ?? "n/a"}</td></tr>
            <tr><th>TX Delay (Flood)</th><td>${config.txdelay ?? "n/a"}</td></tr>
            <tr><th>TX Delay (Direct)</th><td>${config.direct_txdelay ?? "n/a"}</td></tr>
            <tr><th>RX Delay</th><td>${config.rxdelay ?? "n/a"}</td></tr>
            <tr><th>Flood Max Hops</th><td>${config.flood_max ?? "n/a"}</td></tr>
            <tr><th>Flood Max Hops (Unscoped)</th><td>${config.flood_max_unscoped ?? "n/a"}</td></tr>
            <tr><th>Flood Max Hops (Advert)</th><td>${config.flood_max_advert ?? "n/a"}</td></tr>
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
                    n.matched_names;
            }

            else {

                nameCell =
                    `${n.matched_names} (ambiguous)`;
            }

            html += "<tr>";
            html += `<td>${nameCell}</td>`;
            html += `<td>${n.neighbour_prefix}</td>`;
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
