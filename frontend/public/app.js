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
// Period scelto per l'intera pagina Nodes (2026-09-10) — "live" o un
// nome di file archivio (es. "path_observations-2026-08.json.gz").
// Spostato qui dal dettaglio nodo (che non ha più un proprio
// selettore, v. loadNodeDetail()): guida sia quale endpoint
// interroga loadNodesTab() sia, per il nodo che si apre in
// dettaglio, quale mese di osservazioni mostrare — a differenza dei
// filtri sotto, che sono un affinamento CLIENT-SIDE su dati già
// caricati, questo determina QUALI dati vengono caricati. Persistito
// in localStorage (scelta utente, v. analisi 2026-09-10): a
// differenza del vecchio selettore per-nodo (che ripartiva sempre da
// "live" ad ogni apertura), qui la selezione sopravvive alla
// chiusura/riapertura della tab.
//
let nodesArchivePeriod =
    safeLocalStorageGet(
        "nodesArchivePeriod"
    ) ||
    "live";

//
// Posizione di SRC per il filtro "Distance from SRC" (Known Nodes) —
// popolata da loadDeviceStatus(), stessa fetch già usata per la
// tabella Device Status qui sopra nella tab, nessuna chiamata di rete
// aggiuntiva. null finché non nota o se il Companion non ha ancora
// fornito coordinate GPS: getNodeDistanceThresholdKm() tratta questo
// caso disattivando il filtro (nessun nodo escluso), mai come "nessun
// nodo entro il raggio". Dal §86 «non ha fornito coordinate» include anche
// (0,0) e i valori fuori range: un Companion senza GPS annuncia (0,0) e
// quel valore non è una posizione (v. loadDeviceStatus()).
//
let srcCoordsCache = null;

//
// Mappa Leaflet della pagina di dettaglio traccia — creata una sola
// volta (v. ensureTraceDetailMap() più sotto) e riutilizzata ad ogni
// apertura, a differenza dei grafici Chart.js (renderChart(), tab Trace)
// che vengono distrutti e ricreati ogni volta. traceDetailLayerGroup è lo strato
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
// Mappa Leaflet del path di un advert nel dettaglio nodo (tab Nodes,
// v. sezione "NODE DETAIL — MAPPA PATH ADVERT" più sotto, che ha preso
// il posto del vecchio grafico Observation History RSSI/SNR). Stessa
// struttura di quella di Trace sopra — mappa creata UNA volta sola
// (ensureNodeDetailPathMap()) e riutilizzata, uno strato per i marker,
// uno per segmenti+frecce (ridisegnato ad ogni zoom), lista "grezza"
// dei segmenti indipendente dallo zoom — ma istanza e stato SEPARATI:
// le due mappe vivono su pagine diverse e non devono mai condividere
// layer o definizioni (una traccia aperta non deve poter sporcare il
// path di un advert né viceversa).
//
// nodeDetailObservations/nodeDetailNodeInfo: l'array di osservazioni
// attualmente in tabella e l'identità LIVE del nodo aperto (stesso
// oggetto data.node di renderNodeDetail()) — il click su un link
// "Received" porta con sé solo l'indice della riga (data-obs-index),
// il resto lo legge da qui.
//
let nodePathMap = null;
let nodePathMarkerLayerGroup = null;
let nodePathSegmentLayerGroup = null;
let nodePathSegmentDefs = [];
let nodePathInfoControl = null;
let nodeDetailObservations = [];
let nodeDetailNodeInfo = null;

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
let nodesArchiveListRequestId = 0;
let neighboursArchiveListRequestId = 0;
let traceDetailRequestId = 0;

//
// Correlazione della fetch di /api/device_status (posizione di SRC)
// lanciata dal click su un link "Received" nel dettaglio nodo — v.
// showNodeDetailAdvertPath(). Contatore SEPARATO da
// nodeDetailRequestId: quello protegge il caricamento del nodo/Period,
// questo la sola mappa path (cambiare riga selezionata non deve
// invalidare la tabella, né ricaricare il nodo deve lasciare in volo
// un disegno di mappa del nodo precedente — resetNodeDetailPathMap()
// lo incrementa per questo).
//
let nodePathRequestId = 0;

//
// Messaggi Sonar nella pagina Nodes: elenco per mittente, pagina di dettaglio
// del mittente e mappa del path (v. sezione "NODES — MESSAGGI SONAR" più
// sotto, docs/ARCHITECTURE.md §96 e §97). Mappa e strati sono SEPARATI da
// quelli del path advert (nodePath*): stesse ragioni dell'ultimo blocco sopra.
//
// sonarMessagesState: ultima risposta di /api/sonar/messages (le ricezioni
// fisiche; l'elenco ne ricava una riga per mittente).
// Dettaglio del mittente aperto — copia presa al momento del click, come
// nodeDetailObservations: sonarDetailPrefix (prefisso del mittente),
// sonarDetailSender (la sua voce di `senders`), sonarDetailRows (le SUE
// ricezioni in ordine cronologico; l'indice data-sonar-index dei link punta a
// questo array). sonarSelectedKey: chiave (sonarMessageKey()) della ricezione
// la cui mappa è aperta, o null.
//
let sonarMessagesState = { available: true, reason: null, messages: [], senders: {} };
let sonarDetailPrefix = null;
let sonarDetailSender = null;
let sonarDetailRows = [];
let sonarSelectedKey = null;
let sonarMessagesRequestId = 0;
let sonarPathRequestId = 0;
let sonarPathMap = null;
let sonarPathMarkerLayerGroup = null;
let sonarPathSegmentLayerGroup = null;
let sonarPathSegmentDefs = [];
let sonarPathInfoControl = null;

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

//
// Etichette dei selettori «archivio» (Data Source di Trace, Period di Nodes
// e di Repeaters): il server manda {id, label} con la label in inglese
// ("Live", "October 2026"), ma la selezione dipende solo dall'id (nome del
// file di backup): la label è soltanto testo, quindi qui la si ricostruisce
// nella lingua scelta (v. i18n.js). Se l'id non ha la forma attesa si usa la
// label del server così com'è.
//
function localizeArchiveLabel(source) {

    if (
        source.id === "live"
    ) {

        return tl("common.live");
    }

    const m =
        /-(\d{4})-(\d{2})\.json\.gz$/.exec(
            String(source.id)
        );

    const months =
        tl("common.monthNames").split(",");

    const month =
        m ? parseInt(m[2], 10) : 0;

    if (
        m &&
        month >= 1 &&
        month <= 12 &&
        months.length === 12
    ) {

        return `${months[month - 1]} ${m[1]}`;
    }

    return source.label;
}

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
                    localizeArchiveLabel(source);

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
                `<tr><td>${tle("common.errorLoadingData")}</td></tr>`;
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

        return tl("common.ambiguous");
    }

    return tl("common.unknown");
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
// Info Path (tab Trace, box sotto il selettore del path): legenda che
// elenca in chiaro, senza tooltip, ogni hash del path selezionato con il
// nome del repeater. Gli hash sono quelli UNICI del path (andata e
// ritorno ripetono gli stessi: ciascuno compare una volta, nell'ordine
// della prima occorrenza); "SRC" non è un hash e non compare. Il nome
// viene da resolveNodeName(), la stessa funzione dei tooltip di Trace:
// stessi criteri per prefisso ambiguo ("Ambiguous") e nodo sconosciuto
// ("Unknown"). Box aggiuntivo: non sostituisce nessun tooltip. Il nome
// arriva dalla rete: sempre escapeHtml().
//
function pathInfoHashes(pathKey) {

    const seen =
        new Set();

    const hashes =
        [];

    String(
        pathKey ||
        ""
    )
        .split("→")
        .map(
            p =>
                p.trim()
        )
        .forEach(
            p => {

                if (
                    p === "" ||
                    p === "SRC"
                ) {

                    return;
                }

                const id =
                    p.toLowerCase();

                if (
                    seen.has(id)
                ) {

                    return;
                }

                seen.add(id);

                hashes.push(p);
            }
        );

    return hashes;
}

function renderPathInfo(pathKey) {

    const box =
        document.getElementById(
            "pathInfoBox"
        );

    if (
        !box
    ) {

        return;
    }

    const hashes =
        pathInfoHashes(
            pathKey
        );

    if (
        hashes.length === 0
    ) {

        box.innerHTML = "";

        box.style.display = "none";

        return;
    }

    const items =
        hashes
            .map(
                h =>
                    `<li>${escapeHtml(h)} - ${escapeHtml(resolveNodeName(h))}</li>`
            )
            .join("");

    box.innerHTML =
        `<div class="pathInfoTitle">${tle("trace.pathInfoTitle")}</div>` +
        `<p>${tle("trace.pathInfoText")}</p>` +
        `<ul>${items}</ul>`;

    box.style.display = "";
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

    renderPathInfo(key);

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

//
// Etichetta di una colonna della tabella Scheduled Trace-Path: le chiavi delle
// righe (parser.js) sono dati, non testo ("timestamp", "status" e gli elementi
// di path "X→Y"). Solo le prime due hanno un'etichetta tradotta; gli elementi
// di path restano come sono.
//
function traceColumnLabel(column) {

    if (
        column === "timestamp"
    ) {

        return tle("trace.colTimestamp");
    }

    if (
        column === "status"
    ) {

        return tle("trace.colStatus");
    }

    return column;
}

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
            `<tr><td>${tle("trace.noData")}</td></tr>`;
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
                    `<th>${traceColumnLabel(c)}</th>`;
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
        `<tr><th>${tle("trace.statsPathElement")}</th><th>Avg</th><th>Min</th><th>Max</th></tr>`;

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

        html += `<tr><td colspan="4">${tle("trace.noStats")}</td></tr>`;
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
        tln("trace.showingObservations", observations);

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

   Posizioni NON disegnabili (correzione 2026-10-18, v.
   docs/ARCHITECTURE.md §85): un nodo senza GPS annuncia in MeshCore la
   coppia (0,0) — nel contacts.db reale 366 nodi sono a (0,0), uno ha
   lat/lon fuori range — e resolveNodePosition() la restituisce come
   "ok" (non è stata modificata: la usa anche il path advert del
   dettaglio nodo). Prima di questa correzione quei nodi (e SRC, se il
   Companion annunciava (0,0)) venivano disegnati nel Golfo di Guinea,
   con segmenti di migliaia di km e una vista zoomata sull'intero
   globo. Ora loadTraceDetail() applica isUsableMapCoordinate() (sezione
   PATH ADVERT, più sotto) sia a SRC sia ai repeater: una coppia non
   disegnabile segue lo STESSO ramo di "posizione non disponibile" già
   previsto per i nodi senza coordinate — avviso sotto la mappa,
   nessun marker, segmenti che lo toccano saltati — con il motivo
   specifico ("coordinate 0,0 (nodo senza GPS)").

   Vista con un solo punto (correzione 2026-10-18, v. §86): se dopo il
   filtro resta UN solo punto disegnabile, o tutti i punti hanno le stesse
   coordinate, fitBounds() su un'estensione nulla andrebbe al zoom massimo
   delle tile (19); loadTraceDetail() usa invece setView() a zoom 13 (lo
   stesso valore della mappa del path advert, §84). Con due o più punti
   distinti fitBounds() è invariato.
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
//                   entrambi non nulli. NON implica "disegnabile":
//                   (0,0) e valori fuori range sono "ok" anche qui, e
//                   i chiamanti che disegnano devono applicare
//                   isUsableMapCoordinate() (loadTraceDetail() e
//                   buildAdvertPathModel() lo fanno).
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
// "layerGroup" (opzionale, aggiunto con la mappa path del dettaglio
// nodo — v. renderNodeDetailPathSegmentsAtCurrentZoom()): strato in cui
// aggiungere la freccia. Omesso, vale traceSegmentLayerGroup come
// prima di questa aggiunta, quindi i due chiamanti di
// renderTraceSegmentsAtCurrentZoom() restano byte per byte invariati
// nel comportamento. Il pane "traceArrowPane" resta lo stesso nome: i
// pane sono per-istanza di mappa (L.Map.createPane()), ognuna delle
// due mappe ha il proprio con questo nome.
//
function addTraceArrowMarker(
    offset,
    bearing,
    color,
    t,
    layerGroup
) {

    const targetGroup =
        layerGroup ||
        traceSegmentLayerGroup;

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
        targetGroup
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
// Marker dei room server (node_type 3) — aggiunto con la mappa path del
// dettaglio nodo (2026-10-18): la mappa di Trace non ne ha bisogno
// (nei percorsi di una traccia compaiono solo SRC e repeater), il path
// di un advert invece può avere come ORIGINE anche un room server.
// Grafica generata dall'esempio fornito dall'utente (icona verde con
// due figure, ritagliata su un cerchio trasparente come src/repeater;
// stesse dimensioni 32x32 + variante -2x, stesso ancoraggio al centro
// del cerchio).
//
const TRACE_ROOM_SERVER_ICON =
    L.icon(
        {
            iconUrl: "images/markers/room.png",
            iconRetinaUrl: "images/markers/room-2x.png",
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            popupAnchor: [0, -16]
        }
    );

//
// Tile layer OpenStreetMap condiviso dalle due mappe Leaflet del file
// (dettaglio traccia e path advert del dettaglio nodo): un'unica
// definizione di URL/attribuzione/maxZoom invece di due copie che
// potrebbero divergere (la Tile Usage Policy di OSM impone
// l'attribuzione, e la decisione "tile dinamiche via Internet, nessuna
// pre-scaricata" del 2026-08-25 — v. commento in
// ensureTraceDetailMap() — vale identica per entrambe). Estratta da
// ensureTraceDetailMap() senza alcun cambiamento di valori.
//
function createOsmTileLayer() {

    return L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            maxZoom: 19,
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
        }
    );
}

//
// Mappa Leaflet creata UNA VOLTA sola e riutilizzata ad ogni apertura
// del dettaglio (clearLayers() su traceDetailLayerGroup invece di
// distruggere/ricreare la mappa) — a differenza dei grafici Chart.js
// della tab Trace (renderChart(): "chart.destroy()" seguito da
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
    createOsmTileLayer().addTo(
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

                //
                // (0,0) o fuori range = Companion senza GPS (v. il
                // commento in cima a questa sezione): non è una
                // posizione da disegnare, stesso trattamento di "nessuna
                // coordinata" qui sotto, ma con il motivo specifico.
                //
                if (
                    isUsableMapCoordinate(
                        status.adv_lat,
                        status.adv_lon
                    )
                ) {

                    srcPosition = {
                        lat: status.adv_lat,
                        lon: status.adv_lon
                    };

                } else {

                    notices.push(
                        tl("trace.srcPositionUnavailable", { reason: describeUnusableCoordinates(status.adv_lat, status.adv_lon) })
                    );
                }

            } else {

                notices.push(
                    tl("common.srcPositionNoGps")
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
                tl("trace.srcPositionReadError")
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

                //
                // "ok" di resolveNodePosition() = coordinate presenti in
                // contacts.db, NON necessariamente disegnabili: un
                // repeater senza GPS annuncia (0,0) (v. il commento in
                // cima a questa sezione). Una coppia non disegnabile non
                // entra in positions: nessun marker, e i segmenti che lo
                // toccano vengono saltati dal ciclo sui segmenti più
                // sotto, esattamente come per "no-position".
                //
                if (
                    isUsableMapCoordinate(
                        resolved.lat,
                        resolved.lon
                    )
                ) {

                    positions[id] = {
                        lat: resolved.lat,
                        lon: resolved.lon
                    };

                } else {

                    notices.push(
                        tl("trace.nodePositionUnusable", { name: resolveNodeName(id), id: id, reason: describeUnusableCoordinates(resolved.lat, resolved.lon) })
                    );
                }

            } else if (
                resolved.status === "no-position"
            ) {

                notices.push(
                    tl("trace.nodePositionMissing", { name: resolveNodeName(id), id: id })
                );

            } else if (
                resolved.status === "ambiguous"
            ) {

                notices.push(
                    tl("trace.prefixAmbiguous", { id: id })
                );

            } else {

                notices.push(
                    tl("trace.nodeNotFound", { id: id })
                );
            }
        }
    );

    if (
        row.status === "TIMEOUT"
    ) {

        notices.push(
            tl("trace.timeoutNotice")
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
                    tl("common.srcLocalNode") :
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
                // Uno dei due estremi non ha una posizione risolta e
                // disegnabile (già segnalato sopra in notices, anche per
                // (0,0)/fuori range): il segmento viene saltato invece
                // di disegnare una linea verso [0,0]/un punto
                // arbitrario.
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
        const allPointsCoincide =
            bounds.every(
                b =>
                    b[0] === bounds[0][0] &&
                    b[1] === bounds[0][1]
            );

        if (
            allPointsCoincide
        ) {

            //
            // Un solo punto disegnabile (o più punti con le stesse
            // coordinate): fitBounds() su un'estensione nulla va al
            // zoom massimo delle tile (19), inutilmente ravvicinato
            // — v. docs/ARCHITECTURE.md §86. Stesso zoom (13) che la
            // mappa del path advert (§84) usa per un punto solo.
            //
            map.setView(
                bounds[0],
                13,
                { animate: false }
            );

        } else {

            map.fitBounds(
                bounds,
                { padding: [30, 30], animate: false }
            );
        }

    } else {

        notices.push(
            tl("trace.noMapPositions")
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
// Selettore periodo (Live/mese archiviato) della pagina Nodes —
// spostato qui dal dettaglio nodo il 2026-09-10 (v. commento su
// nodesArchivePeriod in cima al file). A differenza del vecchio
// selettore per-nodo, le opzioni vengono (ri)popolate da
// populateNodesArchiveSelector() ogni volta che si apre la tab
// Nodes (click sul tab, "Back to list", cambio nodo fisico sul
// Collettore) — qui si registra solo il listener "change", una sola
// volta, con lo stesso guard "dataset.bound" già in uso altrove
// (es. initNodesFilters()) per non registrarlo più volte ad ogni
// ripopolamento.
//
const nodesArchiveSelector =
    document.getElementById(
        "nodesArchiveSelector"
    );

if (
    nodesArchiveSelector &&
    !nodesArchiveSelector.dataset.bound
) {

    nodesArchiveSelector.dataset.bound =
        "true";

    nodesArchiveSelector.addEventListener(
        "change",
        () => {

            nodesArchivePeriod =
                nodesArchiveSelector.value;

            safeLocalStorageSet(
                "nodesArchivePeriod",
                nodesArchivePeriod
            );

            //
            // Riavvia (o ferma, se non più "live") l'auto-refresh
            // in base al nuovo Period — startNodesAutoRefresh() fa
            // già lei stessa questa scelta, v. la sua definizione.
            //
            if (
                typeof startNodesAutoRefresh === "function"
            ) {

                startNodesAutoRefresh();
            }

            loadNodesTab();
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

    return NODE_TYPE_NAMES[t] || tl("nodes.typeUnknown", { t: t });
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

    if (!ts) return tl("common.never");

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
        return tle("nodes.notObserved");
    }

    const hops = splitAdvertPathHops(hopCount, pathHex);

    if (hops.length === 0) {
        return "DIRECT (0 hop)";
    }

    return hops
        .map(hop => `<span data-tooltip="${escapeHtml(resolveNodeName(hop))}">${hop}</span>`)
        .join(" > ");
}

//
// L'auto-refresh di Nodes ha senso solo sul Period "live" — un mese
// archiviato è uno snapshot statico, ricaricarlo ogni 5 minuti
// rifarebbe la stessa fetch per lo stesso identico risultato (stesso
// principio già applicato alle pagine di dettaglio storico, v.
// analisi-fattibilita-refresh-sse-frontend-2026-08-25.md, tabella
// §1.1: "Node Detail / Trace Detail: Nessuno... viste statiche su
// uno snapshot storico"). Centralizzato qui invece che in ciascuno
// dei chiamanti (click sul tab, "Back to list", listener del
// selettore Period) — stesso motivo per cui syncAutoRefreshToDataSource
// esiste per Trace sul Collettore: un solo punto che decide se il
// timer va acceso o no in base allo stato corrente.
//
function startNodesAutoRefresh() {

    if (
        nodesArchivePeriod !== "live"
    ) {

        stopAutoRefresh();

        return;
    }

    startAutoRefresh(
        loadNodesTab
    );
}

function stopNodesAutoRefresh() {

    stopAutoRefresh();
}

async function loadNodesTab() {

    loadDeviceStatus();

    //
    // Tabella Sonar Messages (§96): richiesta e token propri, indipendente
    // da Known Nodes — un errore o un ritardo dell'una non tocca l'altra.
    //
    loadSonarMessages();

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

        //
        // Period "live" invariato (stesso endpoint di sempre); un
        // Period archiviato legge invece l'aggregato dell'intero
        // mese via /api/nodes/archive/load (introdotto 2026-09-10,
        // v. server.js) — stessa forma di riga di /api/nodes, quindi
        // nessuna modifica richiesta a initNodesFilters()/
        // applyNodesFilters()/renderNodesTable() per il rendering
        // della tabella in sé.
        //
        const url =
            nodesArchivePeriod === "live"
                ? "/api/nodes"
                : "/api/nodes/archive/load?file=" +
                  encodeURIComponent(
                      nodesArchivePeriod
                  );

        const res =
            await fetch(
                url
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
            `<tr><td>${tle("common.errorLoadingData")}</td></tr>`;
    }
}

//
// Popola il selettore Period della pagina Nodes — stesso elenco mesi
// già esposto da /api/nodes/archive/list (introdotto per il vecchio
// selettore del dettaglio nodo, riusato qui invariato: l'elenco dei
// mesi disponibili non dipende da quale nodo si guarda). Richiamata
// ad ogni apertura della tab Nodes (click sul tab, "Back to list"),
// non da loadNodesTab() stessa — che gira anche ad ogni tick di
// auto-refresh — per non ricostruire le <option> (e perdere lo stato
// di focus/apertura del menu) ogni 5 minuti mentre l'utente la sta
// eventualmente usando.
//
async function populateNodesArchiveSelector() {

    const selector =
        document.getElementById(
            "nodesArchiveSelector"
        );

    if (
        !selector
    ) {

        return;
    }

    const requestId =
        ++nodesArchiveListRequestId;

    try {

        const res =
            await fetch(
                "/api/nodes/archive/list"
            );

        assertResOk(res);

        const sources =
            await res.json();

        if (
            requestId !== nodesArchiveListRequestId
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
                    localizeArchiveLabel(source);

                selector.appendChild(
                    opt
                );
            }
        );

        //
        // Ripristina la scelta persistita solo se il mese esiste
        // ancora nell'elenco appena caricato (difesa contro un
        // localStorage rimasto puntato a un file che nel frattempo
        // non c'è più — non dovrebbe succedere, gli archivi non
        // vengono mai cancellati, ma un valore corrotto/manuale in
        // localStorage non deve poter mandare in errore il resto
        // della tab): altrimenti si ricade silenziosamente su
        // "live", stesso comportamento di initNodesFilters() per gli
        // altri filtri quando il valore salvato non è più valido.
        //
        const stillAvailable =
            sources.some(
                source =>
                    source.id === nodesArchivePeriod
            );

        if (
            !stillAvailable
        ) {

            nodesArchivePeriod =
                "live";

            safeLocalStorageSet(
                "nodesArchivePeriod",
                "live"
            );
        }

        selector.value =
            nodesArchivePeriod;

    }

    catch (
        err
    ) {

        if (
            requestId !== nodesArchiveListRequestId
        ) {

            return;
        }

        console.error(
            "Error loading nodes archive list:",
            err
        );
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
            tl("nodes.hopCountMaxHint", { length: lengthSelect.value, max: maxHops, buffer: OUT_PATH_BUFFER_BYTES })
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
// Dal §86 «senza posizione» comprende anche (0,0) e i valori fuori range
// (isUsableMapCoordinate()): (0,0) è ciò che un nodo senza GPS annuncia
// (366 nodi nel contacts.db reale), non una posizione — prima risultava a
// circa 5.000 km da un SRC italiano e rientrava in una soglia Custom
// abbastanza alta. Stesso trattamento dei nodi con adv_lat/adv_lon nulli:
// escluso quando il filtro è attivo.
//
function nodeDistanceFromSrcKm(
    n
) {

    if (
        !srcCoordsCache ||
        !isUsableMapCoordinate(
            n.adv_lat,
            n.adv_lon
        )
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
                tl("common.srcPositionNoGps")
            );
        }
    }
}

//
// "Not observed only" e "Future advert only" hanno senso solo sul
// Period "live" (2026-09-10, scelta esplicita dell'utente in
// quella sessione): un mese archiviato, per come /api/nodes/
// archive/load è costruito, elenca solo i nodi con almeno un
// ascolto in quel mese — "not observed" non ha mai un solo risultato
// da mostrare, e "future advert" confronta un last_advert storico
// con l'orologio DI OGGI, un confronto senza senso. Stesso schema
// disabled+tooltip di updateNodeDistanceFilterAvailability() sopra,
// tooltip sulla <label> per lo stesso motivo (mouseover non affidabile
// su un controllo disabilitato in alcuni browser).
//
function updateNodesPeriodFilterAvailability() {

    const available =
        nodesArchivePeriod === "live";

    [
        {
            checkboxId: "nodeNotObservedFilter",
            tooltip:
                tl("nodes.liveOnlyNotObserved")
        },
        {
            checkboxId: "nodeFutureAdvertFilter",
            tooltip:
                tl("nodes.liveOnlyFutureAdvert")
        }
    ].forEach(
        ({ checkboxId, tooltip }) => {

            const checkbox =
                document.getElementById(
                    checkboxId
                );

            const label =
                document.querySelector(
                    `label[for="${checkboxId}"]`
                );

            if (
                checkbox
            ) {

                checkbox.disabled =
                    !available;
            }

            if (
                label
            ) {

                if (
                    available
                ) {

                    label.removeAttribute(
                        "data-tooltip"
                    );

                } else {

                    label.setAttribute(
                        "data-tooltip",
                        tooltip
                    );
                }
            }
        }
    );
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
                        //
                        // Disattivati fuori da "live" (2026-09-10) —
                        // v. updateNodesPeriodFilterAvailability():
                        // ignorati qui a prescindere dallo stato
                        // (persistito) della checkbox, non solo
                        // disabilitati in UI, altrimenti una
                        // checkbox rimasta spuntata da una sessione
                        // Live precedente svuoterebbe silenziosamente
                        // ogni vista storica (che per costruzione non
                        // ha mai righe "not observed").
                        //
                        nodesArchivePeriod !== "live" ||
                        !notObservedFilter ||
                        nodeIsNotObserved(
                            n
                        )
                    ) &&
                    (
                        nodesArchivePeriod !== "live" ||
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

    updateNodesPeriodFilterAvailability();

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
        // Dal §86 anche (0,0) e i valori fuori range contano come «non
        // fornite» (isUsableMapCoordinate()): un Companion senza GPS
        // annuncia (0,0), e misurare da lì sarebbe misurare dal Golfo di
        // Guinea — il filtro resta disabilitato, come per null.
        //
        srcCoordsCache =
            (
                status &&
                isUsableMapCoordinate(
                    status.adv_lat,
                    status.adv_lon
                )
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
            `<tr><td>${tle("nodes.deviceStatusError")}</td></tr>`;

        //
        // Stesso motivo del ramo "!status" di renderDeviceStatusTable():
        // con la tabella in errore, un nome device rimasto dal giro
        // precedente sarebbe una attribuzione non più verificata (sul
        // Collettore potrebbe essere quello del nodo fisico
        // precedentemente selezionato).
        //
        renderNodesDeviceName(
            null
        );
    }
}

//
// Indicatore di connessione del device (§94), accanto al nome nel tab
// Nodes: «<nome>: ✓ Connesso» / «✗ Disconnesso» / «? Sconosciuto».
//
// Il dato arriva da /api/device_status (campo `connection`, calcolato dal
// server: {state, changed_at, checked_at}); lo stato «unknown» è quello a
// cui il server riduce un valore non più fresco (daemon fermo, copia del
// database vecchia sul Collettore) — v. device_connection.js. Senza campo
// (`connection` null: nodo con il daemon non ancora aggiornato) nessun
// indicatore.
//
// Il modello è separato dal rendering per poterlo provare senza DOM. Solo
// i tre stati noti producono un modello; qualunque altro valore → null.
// Il testo viene dal dizionario, i tempi da formatUnixTime(): nessun dato
// del database finisce nell'HTML come testo libero (e il tooltip passa
// comunque da escapeHtml()).
//
function deviceConnectionBadgeModel(
    connection
) {

    if (
        !connection ||
        typeof connection !== "object"
    ) {

        return null;
    }

    const params = {
        checked: formatUnixTime(connection.checked_at),
        since: formatUnixTime(connection.changed_at)
    };

    if (
        connection.state === "connected"
    ) {

        return {
            cls: "deviceConnOn",
            icon: "\u2713",
            label: tl("nodes.connConnected"),
            tip: tl("nodes.connTipConnected", params)
        };
    }

    if (
        connection.state === "disconnected"
    ) {

        return {
            cls: "deviceConnOff",
            icon: "\u2717",
            label: tl("nodes.connDisconnected"),
            tip: tl("nodes.connTipDisconnected", params)
        };
    }

    if (
        connection.state === "unknown"
    ) {

        return {
            cls: "deviceConnUnknown",
            icon: "?",
            label: tl("nodes.connUnknown"),
            tip: tl("nodes.connTipUnknown", params)
        };
    }

    return null;
}

function renderNodesDeviceConnection(
    connection
) {

    const box =
        document.getElementById(
            "nodesDeviceConnection"
        );

    if (
        !box
    ) {

        return;
    }

    const model =
        deviceConnectionBadgeModel(
            connection
        );

    box.innerHTML =
        model
            ? `<span class="deviceConnColon">:</span>` +
              `<span class="deviceConnBadge ${model.cls}" data-tooltip="${escapeHtml(model.tip)}">` +
              `<span class="deviceConnIcon" aria-hidden="true">${model.icon}</span>` +
              `${escapeHtml(model.label)}</span>`
            : "";
}

//
// Intestazione del tab Nodes con il nome del device companion a cui si
// riferiscono Device Status e Known Nodes — docs/ARCHITECTURE.md §77.
// Stesso ruolo e stesso stile di #neighborRepeaterName nel tab
// Repeaters (nome in h3 in cima, sezioni h4 sotto, "(unknown)" quando
// il nome non c'è), così l'attribuzione vale per tutto il tab senza
// ripeterla nelle label delle singole tabelle.
//
// Il nome arriva da status.device_name (colonna di device_status,
// dallo stesso /api/device_status già usato dalla tabella Device
// Status — nessuna fetch aggiuntiva, e nessun accoppiamento con
// /api/nodes: le due fetch partono insieme senza await, v. commento su
// nodesDataReady). Dato da un device esterno: scritto con textContent,
// mai innerHTML (stessa scelta di neighborRepeaterName). Tre stati:
//   - status assente (nessun dato / errore di caricamento): vuoto —
//     nessun nome da attribuire, e uno stantio sarebbe fuorviante;
//   - status presente ma senza nome (colonna non ancora migrata,
//     daemon Python non ancora aggiornato, nome mai ottenuto):
//     "(unknown)", come per un repeater senza adv_name;
//   - nome presente: il nome.
//
function renderNodesDeviceName(
    status
) {

    //
    // Indicatore di connessione accanto al nome (§94): segue lo stesso
    // ciclo del nome — senza dati (status null: nessuna risposta, errore
    // di caricamento, sul Collettore cambio di nodo) sparisce, mai un
    // «Connesso» rimasto da un giro o da un nodo precedente.
    //
    renderNodesDeviceConnection(
        status
            ? status.connection
            : null
    );

    const heading =
        document.getElementById(
            "nodesDeviceName"
        );

    if (
        !heading
    ) {

        return;
    }

    if (
        !status
    ) {

        heading.textContent =
            "";

        return;
    }

    heading.textContent =
        (
            typeof status.device_name === "string" &&
            status.device_name !== ""
        )
            ? status.device_name
            : tl("common.unknownParen");
}

function renderDeviceStatusTable(
    status
) {

    const table =
        document.getElementById(
            "deviceStatusTable"
        );

    renderNodesDeviceName(
        status
    );

    if (
        !status
    ) {

        table.innerHTML =
            `<tr><td>${tle("nodes.deviceStatusNone")}</td></tr>`;

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
        <tr><th data-tooltip="${tle("tip.updated")}">Updated</th><td>${formatSecsAgo(secsAgo)}</td></tr>
        <tr><th data-tooltip="${tle("tip.battery")}">Battery</th><td>${status.battery_mv != null ? (status.battery_mv / 1000).toFixed(2) + "V" : tl("common.na")}</td></tr>
        <tr><th data-tooltip="${tle("tip.uptime")}">Uptime</th><td>${formatDurationLong(status.uptime_secs)}</td></tr>
        <tr><th data-tooltip="${tle("tip.noiseFloor")}">Noise Floor</th><td>${status.noise_floor != null ? status.noise_floor + " dBm" : tl("common.na")}</td></tr>
        <tr><th data-tooltip="${tle("tip.lastRssi")}">Last RSSI</th><td>${status.last_rssi != null ? status.last_rssi + " dBm" : tl("common.na")}</td></tr>
        <tr><th data-tooltip="${tle("tip.lastSnr")}">Last SNR</th><td>${status.last_snr != null ? status.last_snr + " dB" : tl("common.na")}</td></tr>
        <tr><th data-tooltip="${tle("tip.txQueue")}">TX Queue</th><td>${status.queue_len != null ? status.queue_len + " / 16" : tl("common.na")}</td></tr>
        <tr><th data-tooltip="${tle("tip.errorFlags")}">Error Flags (bitmask)</th><td>${status.errors ?? tl("common.na")}</td></tr>
        <tr><th data-tooltip="${tle("tip.packetsReceived")}">Packets Received</th><td>${status.recv != null ? status.recv + " pkts" : tl("common.na")}</td></tr>
        <tr><th data-tooltip="${tle("tip.packetsSent")}">Packets Sent</th><td>${status.sent != null ? status.sent + " pkts" : tl("common.na")}</td></tr>
        <tr><th data-tooltip="${tle("tip.sent")}">Sent (Flood | Direct)</th><td>${status.flood_tx != null ? status.flood_tx + " pkts" : tl("common.na")} | ${status.direct_tx != null ? status.direct_tx + " pkts" : tl("common.na")}</td></tr>
        <tr><th data-tooltip="${tle("tip.received")}">Received (Flood | Direct)</th><td>${status.flood_rx != null ? status.flood_rx + " pkts" : tl("common.na")} | ${status.direct_rx != null ? status.direct_rx + " pkts" : tl("common.na")}</td></tr>
        <tr><th data-tooltip="${tle("tip.receiveErrors")}">Receive Errors (CRC Fail)</th><td>${status.recv_errors != null ? status.recv_errors + " pkts" : tl("common.na")}</td></tr>
        <tr><th data-tooltip="${tle("tip.crcErrorRate")}">CRC Error Rate (RX)</th><td>${formatCrcErrorRate(status.recv_errors, status.recv)}</td></tr>
        <tr><th data-tooltip="${tle("tip.airtime")}">Airtime (TX | RX)</th><td>${formatDurationLong(status.tx_air_secs)} | ${formatDurationLong(status.rx_air_secs)}</td></tr>
        <tr><th data-tooltip="${tle("tip.airtimePercent")}">Airtime % (mesh, TX+RX/Uptime)</th><td>${formatAirtimePercent(status.tx_air_secs, status.rx_air_secs, status.uptime_secs)}</td></tr>
        <tr><th data-tooltip="${tle("tip.txDutyCycle")}">TX Duty Cycle (observed, TX/Uptime)</th><td>${formatTxDutyCyclePercent(status.tx_air_secs, status.uptime_secs)}</td></tr>
        <tr><th data-tooltip="${tle("tip.firmwareVersion")}">Firmware Version</th><td>${escapeHtml(status.fw_version ?? tl("common.na"))}${status.fw_build ? ` (${escapeHtml(status.fw_build)})` : ""}</td></tr>
        <tr><th data-tooltip="${tle("tip.hardware")}">Hardware</th><td>${escapeHtml(status.model ?? tl("common.na"))}</td></tr>
        <tr><th data-tooltip="${tle("tip.radioSettings")}">Radio settings (Freq | SF | BW | CR)</th><td>${status.radio_freq != null ? status.radio_freq + " MHz" : tl("common.na")} | ${status.radio_sf ?? tl("common.na")} | ${status.radio_bw != null ? status.radio_bw + " kHz" : tl("common.na")} | ${status.radio_cr ?? tl("common.na")}</td></tr>
        ${buildDeviceTelemetryRowsHtml(status.telemetry)}
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
        tl("nodes.heading", { total: total, chat: chatCount, repeaters: repeaterCount, rooms: roomServerCount });
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
        `<tr><th>${tle("nodes.colName")}</th><th>${tle("nodes.colType")}</th><th>${tle("nodes.colAdvertTime")}</th><th>Path</th></tr>`;

    nodes.forEach(
        n => {

            html += "<tr>";
            html += `<td><a href="#" class="nodeLink" data-key="${escapeHtml(n.public_key)}">${escapeHtml(n.adv_name) || tl("common.unknownParen")}</a></td>`;
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
                ? tle("nodes.noData")
                : tle("nodes.noMatch");

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
    // periodo via switchNodeDetailPeriod, richiamata più sotto)
    // prima che questa chiamata finisca, requestId non sarà più
    // quello corrente ai controlli sotto e il risultato tardivo
    // viene scartato invece di sovrascrivere la vista del nodo
    // aperto nel frattempo.
    //
    const requestId =
        ++nodeDetailRequestId;

    nodeDetailCurrentPublicKey =
        publicKey;

    document.getElementById(
        "nodeDetailName"
    ).textContent =
        tl("common.loading");

    document.getElementById(
        "nodeDetailInfoTable"
    ).innerHTML = "";

    document.getElementById(
        "nodeDetailObsTable"
    ).innerHTML = "";

    //
    // Stesso azzeramento per la mappa path e per lo stato che la
    // alimenta: il nodo precedente non deve restare visibile (né
    // cliccabile, via nodeDetailObservations/nodeDetailNodeInfo) mentre
    // quello nuovo carica — e resetNodeDetailPathMap() invalida anche
    // un'eventuale fetch di SRC ancora in volo per un click precedente.
    //
    nodeDetailNodeInfo = null;
    nodeDetailObservations = [];

    resetNodeDetailPathMap();

    //
    // Non c'è più un selettore Period locale al dettaglio nodo
    // (rimosso 2026-09-10, v. commento su nodesArchivePeriod in cima
    // al file): il nodo si apre sempre sul Period scelto a monte
    // nella pagina Nodes, non più forzato a "Live" ad ogni apertura.
    //
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
                tl("ndet.errorNode");

            return;
        }

        const data =
            await res.json();

        if (
            requestId !== nodeDetailRequestId
        ) {

            return;
        }

        //
        // L'identità del nodo (nome/tipo/posizione) viene SEMPRE da
        // qui, live — un mese archiviato non ne ha una propria (v.
        // switchNodeDetailPeriod più sotto). Se il Period scelto a
        // monte non è "live", questo render viene subito dopo
        // sovrascritto solo nella parte osservazioni (tabella +
        // mappa path) da switchNodeDetailPeriod(), che lascia intatta
        // l'intestazione appena disegnata qui.
        //
        renderNodeDetail(
            data
        );

        if (
            nodesArchivePeriod !== "live"
        ) {

            await switchNodeDetailPeriod(
                nodesArchivePeriod
            );
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
            "Error loading node detail:",
            err
        );

        document.getElementById(
            "nodeDetailName"
        ).textContent =
            tl("ndet.errorNode");
    }
}

//
// Cambia la sorgente delle osservazioni mostrate nel dettaglio nodo
// (tabella + mappa path), lasciando invariata l'intestazione identità.
// Fino al 2026-09-05 era richiamata dal listener "change" di un
// selettore Period locale al dettaglio; da quando quel selettore è
// stato rimosso (2026-09-10, spostato a livello di pagina Nodes) è
// chiamata solo da loadNodeDetail(), una volta, subito dopo il
// render "live" iniziale, quando il Period scelto a monte non è
// "live" — la firma e la logica restano invariate, cambia solo chi
// la richiama.
//
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
                `<tr><td>${tle("ndet.errorArchive")}</td></tr>`;

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
        // Solo storico osservazioni (tabella; la mappa path riparte dal
        // messaggio guida, v. renderNodeDetailObsTable()) — le info
        // identità nodo in cima restano quelle live, un mese
        // archiviato non ha un suo "stato del nodo" a sé: è anche per
        // questo che la mappa path usa la posizione CORRENTE
        // dell'origine, di SRC e degli hop (v. sezione "NODE DETAIL —
        // MAPPA PATH ADVERT"), come già Trace per le tracce archiviate.
        //
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
        tl("common.unknownParen");

    const infoTable =
        document.getElementById(
            "nodeDetailInfoTable"
        );

    infoTable.innerHTML = `
        <tr><th>${tle("ndet.infoType")}</th><td>${formatNodeType(node.node_type)}</td></tr>
        <tr><th>${tle("ndet.infoPublicKey")}</th><td>${node.public_key}</td></tr>
        <tr><th>${tle("ndet.infoPosition")}</th><td>${formatNodePosition(node.adv_lat, node.adv_lon)}</td></tr>
        <tr><th>${tle("nodes.colAdvertTime")}</th><td>${formatUnixTime(node.last_advert)}</td></tr>
        <tr><th>${tle("ndet.infoLastActivity")}</th><td>${formatUnixTime(node.last_seen)}</td></tr>
        <tr><th>${tle("ndet.infoTotalObservations")}</th><td id="nodeDetailObsCount">${observations.length}</td></tr>
    `;

    //
    // Identità LIVE del nodo, conservata per la mappa path (origine
    // dell'advert = questo nodo, con la sua posizione corrente) — sia
    // che le osservazioni vengano da qui sia che le sostituisca poi
    // switchNodeDetailPeriod() con quelle di un mese archiviato.
    //
    nodeDetailNodeInfo =
        node;

    renderNodeDetailObsTable(
        observations
    );
}

function renderNodeDetailObsTable(
    observations
) {

    //
    // Ogni (ri)disegno della tabella osservazioni riporta la mappa path
    // al messaggio guida e ne azzera lo stato: la riga che era
    // selezionata potrebbe non esistere più (cambio di Period, nuovo
    // nodo) e un path "orfano" accanto a una tabella diversa sarebbe
    // fuorviante. nodeDetailObservations viene riassegnato qui — unico
    // punto in cui la tabella nasce, chiamato sia dal render live
    // (renderNodeDetail()) sia da quello di un mese archiviato
    // (switchNodeDetailPeriod()) — così l'indice data-obs-index dei
    // link "Received" punta sempre all'array realmente in tabella.
    //
    nodeDetailObservations =
        observations;

    resetNodeDetailPathMap();

    const table =
        document.getElementById(
            "nodeDetailObsTable"
        );

    if (
        observations.length === 0
    ) {

        table.innerHTML =
            `<tr><td>${tle("ndet.noObservations")}</td></tr>`;

        return;
    }

    let html =
        `<tr><th>${tle("ndet.colReceived")}</th><th>${tle("ndet.colHops")}</th><th>Path</th><th>RSSI</th><th>SNR</th></tr>`;

    //
    // Più recente in cima — stesso principio già usato in
    // tools/test_contacts_list.py lato Python. L'indice originale
    // (posizione in "observations", non in ordine inverso) viaggia con
    // ogni riga in data-obs-index: è quello che il click handler
    // sotto usa per ritrovare l'osservazione in nodeDetailObservations.
    //
    observations
        .map(
            (o, i) => ({ o: o, i: i })
        )
        .reverse()
        .forEach(
            ({ o, i }) => {

                //
                // Colonna Received -> link cliccabile verso la mappa
                // path di QUESTA osservazione (stesso schema del
                // timestamp in Scheduled Trace-Path, v. renderTable():
                // <a class="traceLink"> + listener agganciato dopo
                // l'innerHTML). formatUnixTime() produce solo cifre e
                // separatori (o "never"), nessun dato esterno passa
                // attraverso innerHTML senza escape.
                //
                // Nessun link quando hop_count è null/undefined
                // ("not observed", v. buildAdvertPathHtml()): senza
                // sapere se l'advert era DIRECT o passato per dei
                // ripetitori, un segmento origine→SRC disegnato in
                // linea retta sarebbe un'affermazione falsa.
                //
                const receivedHtml =
                    (
                        o.hop_count === null ||
                        o.hop_count === undefined
                    ) ?
                        formatUnixTime(o.observed_at) :
                        `<a href="#" class="traceLink nodePathLink" data-obs-index="${i}">${formatUnixTime(o.observed_at)}</a>`;

                html += "<tr>";
                html += `<td>${receivedHtml}</td>`;
                html += `<td>${o.hop_count}</td>`;
                html += `<td>${buildAdvertPathHtml(o.hop_count, o.path_hex)}</td>`;
                html += `<td>${o.rssi ?? "-"}</td>`;
                html += `<td>${colorizeSnr(o.snr)}</td>`;
                html += "</tr>";
            }
        );

    table.innerHTML = html;

    table.querySelectorAll(
        ".nodePathLink"
    ).forEach(
        link => {

            link.addEventListener(
                "click",
                (e) => {

                    e.preventDefault();

                    showNodeDetailAdvertPath(
                        Number(
                            link.dataset.obsIndex
                        )
                    );
                }
            );
        }
    );
}

/* =========================
   NODE DETAIL — MAPPA PATH ADVERT

   Vedi docs/ARCHITECTURE.md §84 e CHANGES_nodes_advert_path_map.md.
   Sostituisce (2026-10-18, richiesta utente) il grafico Chart.js
   "Observation History (RSSI / SNR)" del dettaglio nodo: cliccando il
   valore della colonna Received di una riga di Observations, la
   stessa pagina mostra su una mappa Leaflet il percorso seguito
   dall'advert di QUELLA osservazione. RSSI/SNR restano consultabili
   nella tabella (colonne omonime), non più nel grafico.

   Ordine del percorso (verificato su dati reali, non assunto —
   28.954 osservazioni di path_observations): path_hex contiene gli
   hop NELL'ORDINE DI PROPAGAZIONE, dal più vicino al nodo che ha
   emesso l'advert al più vicino al ricevitore. Il percorso completo
   disegnato è quindi
       ORIGINE (il nodo di cui si apre il dettaglio)
         -> hop 1 -> ... -> hop N (da path_hex)
         -> SRC (il Companion locale che ha ricevuto l'advert)
   cioè hop_count + 2 punti. hop_count = 0 (DIRECT): solo
   ORIGINE -> SRC.

   Regole decise dall'utente (2026-10-18):
     1. un punto senza coordinate geografiche viene OMESSO dalla
        mappa e la linea interpola direttamente al primo punto
        successivo che le ha (qui: segmento ambra tratteggiato, v.
        sotto);
     2. un hash ambiguo (più repeater con quel prefisso) è trattato
        come il caso 1;
     3. in entrambi i casi, e in generale ogni volta che un elemento
        del path non può essere mostrato, la mappa lo dichiara
        (riquadro sulla mappa, con motivo: dato mancante o dato
        duplicato);
     4. marker: companion (chat) = icona SRC esistente, repeater =
        icona repeater esistente, room server = icona nuova.

   "Senza coordinate" comprende anche (0,0) e valori fuori range
   (|lat|>90, |lon|>180, non numerici): in MeshCore (0,0) è il valore
   con cui un nodo senza GPS annuncia la propria posizione (nel
   contacts.db reale 366 nodi sono esattamente a 0,0, e uno ha
   lat/lon fuori range) — disegnarli vorrebbe dire piazzare un
   marker nel Golfo di Guinea e una linea di migliaia di km verso
   di esso. Controllo SOVRAPPOSTO a resolveNodePosition() (che
   restituisce "ok" anche per 0,0 e NON è stata modificata: la usa
   anche il dettaglio traccia, che dal §85 applica lo stesso controllo
   in loadTraceDetail(), v. ARCHITECTURE.md §84 e §85) —
   isUsableMapCoordinate() qui sotto (usata dal §86 anche dal filtro
   Distance from SRC e dalla cella Position, v. il suo commento).

   Posizioni sempre CORRENTI (contacts.db non ha storico posizioni),
   anche per le osservazioni di un mese archiviato — stessa
   limitazione, già documentata, della mappa di dettaglio traccia.
   Osservazioni multiple dello stesso advert NON vengono mai
   deduplicate: ogni riga è un percorso distinto (decisione di
   progetto, v. ARCHITECTURE.md sui percorsi multipli).
========================= */

//
// Colori dei tratti: grigio per i collegamenti tra punti consecutivi
// (come nell'esempio fornito dall'utente, l'app MeshCore "View Advert
// Path"), blu per le frecce di direzione (idem), ambra per il tratto
// che SALTA uno o più punti omessi — il colore diverso è ciò che
// distingue visivamente "collegamento reale tra due nodi adiacenti
// nel path" da "interpolazione sopra un buco di dati".
//
const NODE_PATH_LINE_COLOR = "#7a7a7a";
const NODE_PATH_ARROW_COLOR = "#1e6fd9";
const NODE_PATH_BRIDGE_COLOR = "#e69500";

//
// Marker per i node_type che non hanno un'icona dedicata (10 = sensore
// /sconosciuto, o valori mai visti): pin standard di Leaflet, già
// presente in vendor/leaflet/images/. Esplicito invece di
// L.Icon.Default per non dipendere dall'autodetect del percorso
// immagini di Leaflet (che legge il CSS e può sbagliare se i file sono
// serviti da un sottopercorso).
//
const NODE_PATH_DEFAULT_ICON =
    L.icon(
        {
            iconUrl: "vendor/leaflet/images/marker-icon.png",
            iconRetinaUrl: "vendor/leaflet/images/marker-icon-2x.png",
            shadowUrl: "vendor/leaflet/images/marker-shadow.png",
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            popupAnchor: [1, -34],
            shadowSize: [41, 41]
        }
    );

//
// true solo per una coppia lat/lon che si può davvero disegnare:
// entrambe numeri finiti, nei range geografici validi, e NON la
// coppia esatta (0,0) — v. il commento della sezione sopra. Nessuna
// coercizione di tipo: una stringa (es. "45.1") non è un numero qui,
// i valori arrivano da JSON e sono già numerici o null.
//
// CONDIVISA (§85, §86) — chiamanti: buildAdvertPathModel() (§84) e
// loadTraceDetail() (§85) per i punti da disegnare; loadDeviceStatus() e
// nodeDistanceFromSrcKm() (§86) per il filtro Distance from SRC (SRC e
// nodi a (0,0) o fuori range sono «non misurabili»); formatNodePosition()
// (§86) per la cella Position. describeUnusableCoordinates() qui sotto
// serve buildAdvertPathModel(), loadTraceDetail() e formatNodePosition().
// Sono dichiarazioni di funzione di primo livello (hoisting) e restano
// qui, dove sono nate: chi le modifica deve controllare TUTTI i chiamanti.
//
function isUsableMapCoordinate(
    lat,
    lon
) {

    return (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        !(lat === 0 && lon === 0)
    );
}

//
// Motivo (testo per il riquadro sulla mappa) per cui una coppia lat/lon
// NON è disegnabile, da chiamare solo quando isUsableMapCoordinate()
// ha già risposto false. "noPositionText" è il testo per il caso
// "posizione non nota" (null), che cambia a seconda del punto
// (nodo in contacts.db / Companion senza GPS).
//
function describeUnusableCoordinates(
    lat,
    lon,
    noPositionText
) {

    if (
        lat === null ||
        lat === undefined ||
        lon === null ||
        lon === undefined
    ) {

        return noPositionText;
    }

    if (
        lat === 0 &&
        lon === 0
    ) {

        return tl("common.coordNoGps");
    }

    return tl("common.coordInvalid", { lat: lat, lon: lon });
}

//
// Testo della cella «Position» del dettaglio nodo (tab Nodes) — v.
// docs/ARCHITECTURE.md §86. Restituisce HTML già escapato, da inserire
// nel template di renderNodeDetail():
//   - lat o lon assenti (null/undefined): invariato rispetto a prima,
//     «-» al posto del valore mancante («-, -» se mancano entrambi);
//   - coordinate disegnabili (isUsableMapCoordinate()): «lat, lon»
//     come prima, invariato;
//   - (0,0) o fuori range: NON il dato grezzo «0, 0» — in MeshCore è il
//     valore con cui un nodo senza GPS annuncia la propria posizione,
//     non una posizione — ma «Non disponibile: <motivo>», con lo stesso
//     motivo che la mappa del path advert (§84) e il dettaglio traccia
//     (§85) scrivono per lo stesso nodo.
// Il dato grezzo resta in contacts.db: cambia solo come viene mostrato.
//
function formatNodePosition(
    lat,
    lon
) {

    if (
        lat === null ||
        lat === undefined ||
        lon === null ||
        lon === undefined
    ) {

        return escapeHtml(
            `${lat ?? "-"}, ${lon ?? "-"}`
        );
    }

    if (
        isUsableMapCoordinate(
            lat,
            lon
        )
    ) {

        return escapeHtml(
            `${lat}, ${lon}`
        );
    }

    return escapeHtml(
        tl("pmap.positionUnavailable", { reason: describeUnusableCoordinates(lat, lon) })
    );
}

//
// Costruisce un punto del path a partire da una posizione grezza.
// Struttura comune a origine/hop/SRC:
//   role     "origin" | "hop" | "src"
//   step     etichetta della posizione nel path ("Origine", "Hop 2",
//            "SRC") — per il riquadro dei punti mancanti
//   name     nome risolto, o null
//   hash     prefisso hex dell'hop (solo per role "hop"), o null
//   nodeType node_type (solo per role "origin"), o null
//   shown    true se ha coordinate disegnabili
//   lat/lon  solo se shown
//   reason   null se shown, altrimenti { kind: "missing"|"duplicate",
//            text } — "missing" = dato mancante/non valido,
//            "duplicate" = hash ambiguo (v. buildAdvertPathModel())
//
function buildPathPoint(
    spec
) {

    const usable =
        isUsableMapCoordinate(
            spec.lat,
            spec.lon
        );

    return {
        role: spec.role,
        step: spec.step,
        name: spec.name === undefined ? null : spec.name,
        hash: spec.hash === undefined ? null : spec.hash,
        nodeType: spec.nodeType === undefined ? null : spec.nodeType,
        shown: usable,
        lat: usable ? spec.lat : null,
        lon: usable ? spec.lon : null,
        reason:
            usable ?
                null :
                {
                    kind: "missing",
                    text:
                        describeUnusableCoordinates(
                            spec.lat,
                            spec.lon,
                            spec.noPositionText
                        )
                }
    };
}

//
// Modello PURO (nessun DOM, nessuna fetch) del path di una singola
// osservazione — separato dal disegno perché la logica delle regole
// utente (punti omessi, ambiguità, tratti che saltano) sia testabile
// da sola (sandbox_tests/test_node_detail_advert_path_map_2026_10_18.js).
// Legge solo resolveNodePosition()/resolveNodeName() (meshNodes) e
// splitAdvertPathHops(): nessuna delle tre è modificata.
//
// node      identità LIVE del nodo aperto (data.node di
//           /api/nodes/:publicKey) = ORIGINE dell'advert
// observation  riga di path_observations ({hop_count, path_hex, ...})
// srcInfo   { fetchFailed: bool, lat, lon } — posizione di SRC da
//           /api/device_status (lat/lon null se il Companion non ha
//           GPS), oppure fetchFailed:true se la fetch è fallita
//
// Ritorna:
//   points    tutti i punti nell'ordine del path (origine, hop, SRC),
//             mostrati o no
//   missing   i punti con shown=false (stesso ordine)
//   segments  { from, to, bridged } fra punti MOSTRATI consecutivi;
//             bridged=true se fra i due c'è almeno un punto omesso
//   notes     avvisi generali (incoerenze nei dati dell'osservazione)
//
function buildAdvertPathModel(
    node,
    observation,
    srcInfo
) {

    const points = [];
    const notes = [];

    points.push(
        buildPathPoint(
            {
                role: "origin",
                step: tl("pmap.stepOrigin"),
                name: node.adv_name || tl("common.unknownParen"),
                nodeType: node.node_type,
                lat: node.adv_lat,
                lon: node.adv_lon,
                noPositionText:
                    tl("pmap.noPositionOrigin")
            }
        )
    );

    const hopCount =
        observation.hop_count;

    const hops =
        splitAdvertPathHops(
            hopCount,
            observation.path_hex
        );

    if (
        hopCount > 0 &&
        hops.length === 0
    ) {

        //
        // hop_count dichiara degli hop ma path_hex è vuoto/assente: gli
        // hop intermedi esistono ma non sono noti — un unico punto
        // "mancante" che rappresenta tutti (non ha senso inventarne N
        // senza hash), così il tratto origine->SRC risulta "ambra" e
        // il riquadro lo dichiara.
        //
        points.push(
            {
                role: "hop",
                step: tl("pmap.stepIntermediateHops", { n: hopCount }),
                name: null,
                hash: null,
                nodeType: null,
                shown: false,
                lat: null,
                lon: null,
                reason: {
                    kind: "missing",
                    text:
                        tl("pmap.reasonPathHexMissing")
                }
            }
        );

    } else {

        if (
            hops.length !== hopCount
        ) {

            notes.push(
                tl("pmap.noteInconsistent", { hopCount: hopCount, elements: hops.length })
            );
        }

        hops.forEach(
            (hash, i) => {

                const step =
                    `Hop ${i + 1}`;

                const resolved =
                    resolveNodePosition(
                        hash
                    );

                if (
                    resolved.status === "ok" ||
                    resolved.status === "no-position"
                ) {

                    //
                    // "no-position" ha lat/lon undefined: finisce nel
                    // ramo "posizione non nota" di buildPathPoint();
                    // "ok" con (0,0)/fuori range finisce in quello
                    // "coordinate non valide" — stesso controllo
                    // sovrapposto per entrambi.
                    //
                    points.push(
                        buildPathPoint(
                            {
                                role: "hop",
                                step: step,
                                name: resolveNodeName(hash),
                                hash: hash,
                                lat: resolved.lat,
                                lon: resolved.lon,
                                noPositionText:
                                    tl("pmap.noPositionHop")
                            }
                        )
                    );

                    return;
                }

                points.push(
                    {
                        role: "hop",
                        step: step,
                        name: null,
                        hash: hash,
                        nodeType: null,
                        shown: false,
                        lat: null,
                        lon: null,
                        reason:
                            resolved.status === "ambiguous" ?
                                {
                                    kind: "duplicate",
                                    text:
                                        tl("pmap.reasonAmbiguousHash")
                                } :
                                {
                                    kind: "missing",
                                    text:
                                        tl("pmap.reasonUnknownHash")
                                }
                    }
                );
            }
        );
    }

    if (
        srcInfo &&
        srcInfo.fetchFailed
    ) {

        points.push(
            {
                role: "src",
                step: "SRC",
                name: tl("common.srcLocalNode"),
                hash: null,
                nodeType: null,
                shown: false,
                lat: null,
                lon: null,
                reason: {
                    kind: "missing",
                    text:
                        tl("pmap.reasonSrcUnreadable")
                }
            }
        );

    } else {

        points.push(
            buildPathPoint(
                {
                    role: "src",
                    step: "SRC",
                    name: tl("common.srcLocalNode"),
                    lat: srcInfo ? srcInfo.lat : null,
                    lon: srcInfo ? srcInfo.lon : null,
                    noPositionText:
                        tl("pmap.noPositionSrc")
                }
            )
        );
    }

    const segments = [];

    let previous = null;
    let previousIndex = -1;

    points.forEach(
        (p, index) => {

            if (
                !p.shown
            ) {

                return;
            }

            if (
                previous
            ) {

                segments.push(
                    {
                        from: previous,
                        to: p,
                        bridged: index - previousIndex > 1
                    }
                );
            }

            previous = p;
            previousIndex = index;
        }
    );

    return {
        points: points,
        missing: points.filter(p => !p.shown),
        segments: segments,
        notes: notes
    };
}

//
// HTML del riquadro "punti mancanti" sovrapposto alla mappa (richiesta
// utente: la mappa deve dichiarare quali punti non sono mostrati e
// perché). Stringa vuota se non c'è nulla da dichiarare (tutti i
// punti mostrati, nessuna nota): il chiamante nasconde allora il
// riquadro. Ogni testo variabile (nomi di nodo, hash) passa da
// escapeHtml(): i nomi arrivano da contacts.db, cioè da advert
// radio ricevuti dalla rete.
//
function buildNodePathInfoHtml(
    model
) {

    const parts = [];

    if (
        model.missing.length > 0
    ) {

        parts.push(
            `<div class="nodePathInfoTitle">${tle("pmap.missingTitle", { n: model.missing.length, total: model.points.length })}</div>`
        );

        parts.push(
            `<div class="nodePathInfoSub">${tle("pmap.missingSub")}</div>`
        );

        parts.push(
            "<ul>" +
            model.missing
                .map(
                    p => {

                        const who =
                            [
                                p.name &&
                                p.role !== "src" ?
                                    p.name :
                                    null,
                                p.hash ?
                                    `(${p.hash})` :
                                    null
                            ]
                                .filter(Boolean)
                                .join(" ");

                        const kindLabel =
                            p.reason.kind === "duplicate" ?
                                tl("pmap.kindDuplicate") :
                                tl("pmap.kindMissing");

                        return (
                            "<li>" +
                            `<b>${escapeHtml(p.step)}</b>` +
                            (who ? ` ${escapeHtml(who)}` : "") +
                            ` — ${kindLabel}: ${escapeHtml(p.reason.text)}` +
                            "</li>"
                        );
                    }
                )
                .join("") +
            "</ul>"
        );
    }

    if (
        model.segments.some(
            s => s.bridged
        )
    ) {

        parts.push(
            `<div class="nodePathInfoLegend"><span class="nodePathInfoSwatch"></span>${tle("pmap.legendBridged")}</div>`
        );
    }

    model.notes.forEach(
        n => {

            parts.push(
                `<div class="nodePathInfoNote">${escapeHtml(n)}</div>`
            );
        }
    );

    return parts.join("");
}

//
// Icona del marker per un punto del path (v. regola 4 in cima alla
// sezione): SRC e repeater hanno icona fissa per ruolo; l'ORIGINE
// dipende dal node_type del nodo aperto — 1 companion/chat = icona SRC,
// 2 repeater = icona repeater, 3 room server = icona room server,
// altro = pin standard.
//
function nodePathIconForPoint(
    p
) {

    if (
        p.role === "src"
    ) {

        return TRACE_SRC_ICON;
    }

    if (
        p.role === "hop"
    ) {

        return TRACE_REPEATER_ICON;
    }

    if (
        p.nodeType === 1
    ) {

        return TRACE_SRC_ICON;
    }

    if (
        p.nodeType === 2
    ) {

        return TRACE_REPEATER_ICON;
    }

    if (
        p.nodeType === 3
    ) {

        return TRACE_ROOM_SERVER_ICON;
    }

    return NODE_PATH_DEFAULT_ICON;
}

//
// Mappa creata UNA volta sola, al primo click su un link Received
// (non all'apertura del dettaglio: il contenitore è display:none
// finché non c'è un path da mostrare, e Leaflet calcola le proprie
// dimensioni alla creazione — v. loadTraceDetail() per lo stesso
// motivo dell'invalidateSize()). Riutilizzata poi per ogni click su
// qualunque nodo; stessa struttura di ensureTraceDetailMap().
//
function ensureNodeDetailPathMap() {

    if (
        nodePathMap
    ) {

        return nodePathMap;
    }

    nodePathMap =
        L.map(
            "nodeDetailPathMap"
        ).setView(
            [0, 0],
            2
        );

    createOsmTileLayer().addTo(
        nodePathMap
    );

    nodePathMarkerLayerGroup =
        L.layerGroup().addTo(
            nodePathMap
        );

    nodePathSegmentLayerGroup =
        L.layerGroup().addTo(
            nodePathMap
        );

    //
    // Stesso pane per le frecce di Trace (v. ensureTraceDetailMap(): z-index
    // sopra marker e tooltip nativi), creato su QUESTA istanza di mappa —
    // i pane sono per-mappa, il nome identico non collide.
    //
    const arrowPane =
        nodePathMap.createPane(
            "traceArrowPane"
        );

    arrowPane.style.zIndex = 660;
    arrowPane.style.pointerEvents = "none";

    //
    // Riquadro "punti mancanti": controllo Leaflet in alto a destra
    // (il controllo zoom resta in alto a sinistra), contenuto scritto
    // da updateNodePathInfo(). click/scroll non devono arrivare alla
    // mappa sottostante (altrimenti scorrere la lista farebbe zoom).
    //
    nodePathInfoControl =
        L.control(
            { position: "topright" }
        );

    nodePathInfoControl.onAdd =
        function () {

            const div =
                L.DomUtil.create(
                    "div",
                    "nodePathInfo"
                );

            L.DomEvent.disableClickPropagation(
                div
            );

            L.DomEvent.disableScrollPropagation(
                div
            );

            div.style.display = "none";

            return div;
        };

    nodePathInfoControl.addTo(
        nodePathMap
    );

    nodePathMap.on(
        "zoomend",
        renderNodeDetailPathSegmentsAtCurrentZoom
    );

    return nodePathMap;
}

function updateNodePathInfo(
    html
) {

    if (
        !nodePathInfoControl
    ) {

        return;
    }

    const container =
        nodePathInfoControl.getContainer();

    if (
        !container
    ) {

        return;
    }

    container.innerHTML =
        html;

    container.style.display =
        html ?
            "block" :
            "none";
}

//
// Riporta la sezione al suo stato iniziale: messaggio guida visibile,
// mappa nascosta e svuotata, nessun link selezionato. Chiamata ad ogni
// (ri)disegno della tabella osservazioni e all'apertura di un nuovo
// nodo. Incrementa nodePathRequestId: una fetch di SRC lanciata da un
// click precedente e ancora in volo, quando risponde, trova il token
// cambiato e scarta il proprio risultato invece di disegnare su una
// pagina che nel frattempo non mostra più quella osservazione.
// Tollera elementi DOM assenti (test con DOM minimale).
//
function resetNodeDetailPathMap() {

    ++nodePathRequestId;

    nodePathSegmentDefs = [];

    if (
        nodePathMarkerLayerGroup
    ) {

        nodePathMarkerLayerGroup.clearLayers();
    }

    if (
        nodePathSegmentLayerGroup
    ) {

        nodePathSegmentLayerGroup.clearLayers();
    }

    updateNodePathInfo(
        ""
    );

    const guide =
        document.getElementById(
            "nodeDetailPathGuide"
        );

    const caption =
        document.getElementById(
            "nodeDetailPathCaption"
        );

    const mapEl =
        document.getElementById(
            "nodeDetailPathMap"
        );

    if (
        guide
    ) {

        guide.style.display = "";
    }

    if (
        caption
    ) {

        caption.textContent = "";
    }

    if (
        mapEl
    ) {

        mapEl.style.display = "none";
    }
}

//
// Evidenzia il link Received della riga selezionata (e la sua riga),
// togliendo l'evidenziazione dalla precedente.
//
function markSelectedAdvertPathLink(
    index
) {

    document.querySelectorAll(
        "#nodeDetailObsTable .nodePathLink"
    ).forEach(
        link => {

            const selected =
                Number(
                    link.dataset.obsIndex
                ) === index;

            link.classList.toggle(
                "selected",
                selected
            );

            const row =
                link.closest(
                    "tr"
                );

            if (
                row
            ) {

                row.classList.toggle(
                    "nodePathSelectedRow",
                    selected
                );
            }
        }
    );
}

//
// Click su un link Received: legge la posizione LIVE di SRC (stessa
// fonte e stesso motivo di loadTraceDetail(): /api/device_status, mai
// in cache dell'osservazione — né in contacts.db come nodo —, vale
// anche per un mese archiviato), costruisce il modello del path e lo
// disegna. L'unica richiesta di rete di tutta la funzionalità: origine
// e hop sono già in nodeDetailNodeInfo/meshNodes.
//
async function showNodeDetailAdvertPath(
    index
) {

    const observation =
        nodeDetailObservations[index];

    const node =
        nodeDetailNodeInfo;

    if (
        !observation ||
        !node
    ) {

        return;
    }

    //
    // Token catturato DOPO il controllo sopra e PRIMA di qualunque
    // await: due click ravvicinati su righe diverse devono far vincere
    // l'ultimo, non il più lento a rispondere.
    //
    const requestId =
        ++nodePathRequestId;

    markSelectedAdvertPathLink(
        index
    );

    const srcInfo = {
        fetchFailed: false,
        lat: null,
        lon: null
    };

    try {

        const res =
            await fetch(
                "/api/device_status"
            );

        assertResOk(res);

        const status =
            await res.json();

        if (
            requestId !== nodePathRequestId
        ) {

            return;
        }

        if (
            status
        ) {

            srcInfo.lat =
                status.adv_lat;

            srcInfo.lon =
                status.adv_lon;
        }

    } catch (
        err
    ) {

        if (
            requestId !== nodePathRequestId
        ) {

            return;
        }

        console.error(
            "Error loading device status for advert path:",
            err
        );

        srcInfo.fetchFailed = true;
    }

    renderNodeDetailAdvertPath(
        buildAdvertPathModel(
            node,
            observation,
            srcInfo
        ),
        observation
    );
}

//
// Disegna il modello sulla mappa: marker dei punti mostrati, vista
// adattata ai loro limiti, segmenti+frecce (via
// renderNodeDetailPathSegmentsAtCurrentZoom()), riquadro dei punti
// mancanti e didascalia sopra la mappa.
//
function renderNodeDetailAdvertPath(
    model,
    observation
) {

    const guide =
        document.getElementById(
            "nodeDetailPathGuide"
        );

    const mapEl =
        document.getElementById(
            "nodeDetailPathMap"
        );

    const caption =
        document.getElementById(
            "nodeDetailPathCaption"
        );

    if (
        guide
    ) {

        guide.style.display = "none";
    }

    //
    // Il contenitore va reso visibile PRIMA di creare la mappa o di
    // chiamare invalidateSize() (v. ensureNodeDetailPathMap()).
    //
    mapEl.style.display = "block";

    const map =
        ensureNodeDetailPathMap();

    map.invalidateSize();

    nodePathMarkerLayerGroup.clearLayers();
    nodePathSegmentLayerGroup.clearLayers();

    const bounds = [];

    model.points.forEach(
        p => {

            if (
                !p.shown
            ) {

                return;
            }

            const label =
                p.role === "origin" ?
                    tl("pmap.markerOrigin", { name: p.name }) :
                    p.role === "src" ?
                        p.name :
                        `${p.name} (${p.hash})`;

            L.marker(
                [p.lat, p.lon],
                { icon: nodePathIconForPoint(p) }
            ).bindTooltip(
                escapeHtml(label),
                {
                    permanent: true,
                    direction: "top"
                }
            ).addTo(
                nodePathMarkerLayerGroup
            );

            bounds.push(
                [p.lat, p.lon]
            );
        }
    );

    //
    // Dati "grezzi" dei segmenti, indipendenti dallo zoom — il disegno
    // vero lo fa renderNodeDetailPathSegmentsAtCurrentZoom() dopo che
    // la vista ha lo zoom definitivo (stessa divisione di Trace).
    //
    nodePathSegmentDefs =
        model.segments.map(
            s => ({
                latlngFrom: { lat: s.from.lat, lng: s.from.lon },
                latlngTo: { lat: s.to.lat, lng: s.to.lon },
                bridged: s.bridged,
                isDegenerate:
                    s.from.lat === s.to.lat &&
                    s.from.lon === s.to.lon
            })
        );

    if (
        bounds.length >= 2
    ) {

        //
        // maxZoom 16: se tutti i punti coincidono (o quasi) fitBounds()
        // andrebbe al massimo zoom delle tile (19), inutilmente
        // ravvicinato per un path.
        //
        map.fitBounds(
            bounds,
            {
                padding: [30, 30],
                animate: false,
                maxZoom: 16
            }
        );

    } else if (
        bounds.length === 1
    ) {

        map.setView(
            bounds[0],
            13,
            { animate: false }
        );
    }

    renderNodeDetailPathSegmentsAtCurrentZoom();

    updateNodePathInfo(
        buildNodePathInfoHtml(
            model
        )
    );

    if (
        caption
    ) {

        const hopCount =
            observation.hop_count;

        caption.textContent =
            tl("pmap.caption", {
                time: formatUnixTime(observation.observed_at),
                hops:
                    hopCount === 0 ?
                        "DIRECT (0 hop)" :
                        `${hopCount} hop`,
                shown: bounds.length,
                total: model.points.length
            });
    }

    //
    // La mappa sta SOPRA la tabella, che può essere lunga: dopo un
    // click su una riga lontana dalla cima la mappa potrebbe essere
    // fuori dallo schermo. block:"nearest" scorre solo se la sezione
    // non è già interamente visibile.
    //
    const section =
        document.getElementById(
            "nodeDetailPathSection"
        );

    if (
        section &&
        typeof section.scrollIntoView === "function"
    ) {

        section.scrollIntoView(
            { block: "nearest", behavior: "smooth" }
        );
    }
}

//
// Ridisegna segmenti+frecce con lo zoom corrente — stessa ragione di
// renderTraceSegmentsAtCurrentZoom() (le frecce "di arrivo" sono a
// distanza fissa in pixel schermo dal marker di destinazione, quindi
// la loro posizione lungo il segmento dipende dallo zoom). Riusa
// offsetSegmentPixels()/bearingDegrees()/addTraceArrowMarker() di
// Trace e le sue costanti; NON ne riusa il ciclo, perché qui i segmenti
// non hanno etichette SNR, non hanno andata/ritorno da separare (sign
// sempre 0: in un percorso di propagazione un repeater non compare due
// volte) e il colore dipende da "bridged" invece che dal valore SNR.
//
function renderNodeDetailPathSegmentsAtCurrentZoom() {

    if (
        !nodePathMap ||
        !nodePathSegmentLayerGroup
    ) {

        return;
    }

    nodePathSegmentLayerGroup.clearLayers();

    const zoom =
        nodePathMap.getZoom();

    nodePathSegmentDefs.forEach(
        def => {

            const offsetResult =
                offsetSegmentPixels(
                    nodePathMap,
                    zoom,
                    def.latlngFrom,
                    def.latlngTo,
                    0
                );

            const offset =
                offsetResult.latlngs;

            const lineColor =
                def.bridged ?
                    NODE_PATH_BRIDGE_COLOR :
                    NODE_PATH_LINE_COLOR;

            const arrowColor =
                def.bridged ?
                    NODE_PATH_BRIDGE_COLOR :
                    NODE_PATH_ARROW_COLOR;

            const line =
                L.polyline(
                    offset,
                    {
                        color: lineColor,
                        weight: 3,
                        dashArray:
                            def.bridged ?
                                "8 6" :
                                "4 6"
                    }
                );

            if (
                def.bridged
            ) {

                line.bindTooltip(
                    tle("pmap.bridgedTooltip"),
                    { sticky: true }
                );
            }

            line.addTo(
                nodePathSegmentLayerGroup
            );

            //
            // Segmento degenere (due punti alla stessa posizione):
            // nessuna freccia, il bearing non è definito.
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
            // Due frecce per segmento, stessa logica e stesse costanti
            // di renderTraceSegmentsAtCurrentZoom() ("a metà" al 70% +
            // "di arrivo" a TRACE_ARROW_END_BACKOFF_PIXELS dal marker
            // di destinazione, mai più vicina di
            // TRACE_ARROW_MIN_SEPARATION_PIXELS alla prima): permette
            // di leggere la direzione guardando il marker di un nodo.
            //
            const ARROW_MID_T = 0.7;

            addTraceArrowMarker(
                offset,
                bearing,
                arrowColor,
                ARROW_MID_T,
                nodePathSegmentLayerGroup
            );

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
                arrowColor,
                ARROW_END_T,
                nodePathSegmentLayerGroup
            );
        }
    );
}

/* =========================
   NODES — MESSAGGI SONAR (elenco per mittente, dettaglio del mittente e mappa del path)

   Vedi docs/ARCHITECTURE.md §96 e §97 e CHANGES_sonar_sender_detail.md.
   Richiesta dell'utente (2026-10-22): vedere dalla dashboard i messaggi
   del canale Sonar che il nodo ha ricevuto — chi li ha mandati, quando e
   con quale path — con lo STESSO meccanismo dei Nodi conosciuti:

     pagina Nodes  l'elenco ha una riga per MITTENTE, il cui nome è il link,
                   con il suo ultimo messaggio: data di ricezione e path
                   della PRIMA copia arrivata. Sta sotto Known Nodes; sul
                   Collettore dipende dal selettore Node come il resto.
     dettaglio     il link apre una pagina dedicata (#sonarDetailPage, come
                   #nodeDetailPage) che nasconde l'elenco: «Back to list»,
                   tabella info del mittente, mappa del path e tabella di
                   TUTTE le sue ricezioni (Msg, Received, Hops, Path, RSSI,
                   SNR), le più recenti in cima. Le copie dello stesso
                   messaggio arrivate per path diversi sono righe vicine,
                   come le osservazioni di uno stesso advert.

   Dati: /api/sonar/messages (sonar_messages.js), una riga per ricezione
   fisica. Il Period della pagina (nodesArchivePeriod, §75) vale anche qui:
   Live = tabella sonar_rx; un mese = archivio sonar_rx dello stesso mese.
   Un «messaggio» è l'insieme delle ricezioni con lo stesso mittente,
   pkt_hash e seq (lo stesso pacchetto sentito per percorsi diversi, D2/D43
   del §87); senza pkt_hash ogni ricezione è un messaggio a sé.

   Il dettaglio non fa richieste: lavora su una COPIA delle righe del
   mittente prese dall'ultimo elenco caricato, così un ricaricamento
   dell'elenco non sposta gli indici dei link. Con il dettaglio aperto
   l'aggiornamento automatico di Nodes è fermo (come in goToNodeDetail()):
   il dettaglio è un'istantanea dell'elenco da cui si è partiti.

   Ogni «Received» del dettaglio è un link: seleziona la ricezione e mostra,
   nella stessa pagina, la mappa del suo path, come per un advert (§84):
       MITTENTE -> hop 1 -> ... -> hop N -> SRC (il Companion locale)
   Il modello del path è quello degli advert, buildAdvertPathModel(), usato
   senza modificarlo: qui cambia solo l'origine, che è il mittente del
   messaggio e non un nodo aperto in dettaglio. Il mittente si risolve dal
   suo prefisso di 8 caratteri (non è una chiave intera) in /api/sonar/
   messages, che lo cerca in `nodes`: se il prefisso non corrisponde a
   nessun nodo (sconosciuto) o a più di uno (ambiguo) il mittente NON viene
   disegnato e il riquadro sulla mappa dichiara il motivo — gli stessi
   criteri di hop sconosciuti/ambigui e di punti senza posizione (§84).
   Gli hop sono repeater, risolti come sempre da meshNodes.

   Le funzioni della mappa (ensure/reset/render/segmenti) sono PARALLELE a
   quelle di NODE DETAIL — MAPPA PATH ADVERT, con stato proprio (mappa,
   strati, segmenti, token di richiesta): le due mappe stanno su schermate
   diverse e non devono poter sporcare l'una il disegno dell'altra, e le
   funzioni dell'advert non sono state toccate. Condivise, invariate:
   buildAdvertPathModel(), buildNodePathInfoHtml(), nodePathIconForPoint(),
   createOsmTileLayer(), offsetSegmentPixels(), bearingDegrees(),
   addTraceArrowMarker() e le costanti NODE_PATH_*.
========================= */

// ==== DIFFERENZA STRUTTURALE Nodo/Collettore: INIZIO ====
// Tutto il resto di questa sezione è identico nei due repository (verificato
// da sandbox_tests/test_sonar_messages_table_2026_10_22.js).

// Parametro ?node= delle fetch: il Nodo ha un solo database.
function sonarNodeQuery() {

    return "";
}

// ==== DIFFERENZA STRUTTURALE Nodo/Collettore: FINE ====

function sonarMessagesUrl() {

    const query =
        sonarNodeQuery();

    return (
        "/api/sonar/messages?file=" +
        encodeURIComponent(
            nodesArchivePeriod
        ) +
        (
            query ?
                "&" + query :
                ""
        )
    );
}

function sonarDeviceStatusUrl() {

    const query =
        sonarNodeQuery();

    return (
        "/api/device_status" +
        (
            query ?
                "?" + query :
                ""
        )
    );
}

//
// Chiave stabile di una RICEZIONE fra un ricaricamento e l'altro: l'id di
// sonar_rx (presente anche negli archivi); senza id, i campi che la
// individuano. L'indice nell'array no: arrivano ricezioni nuove in fondo.
//
function sonarMessageKey(
    message
) {

    if (
        message.id !== null &&
        message.id !== undefined
    ) {

        return "id:" + message.id;
    }

    return (
        "t:" +
        message.observed_at + ":" +
        message.src_prefix + ":" +
        message.seq
    );
}

//
// Chiave del MESSAGGIO a cui appartiene una ricezione: le copie dello stesso
// pacchetto arrivate per path diversi hanno lo stesso mittente, pkt_hash e
// seq (§87, D2: «le copie si raggruppano per pkt_hash»). Senza pkt_hash non
// si può dire che due ricezioni siano lo stesso messaggio: ognuna è a sé.
//
function sonarMessageGroupKey(
    message
) {

    if (
        message.pkt_hash === null ||
        message.pkt_hash === undefined
    ) {

        return "r:" + sonarMessageKey(message);
    }

    return (
        "p:" +
        message.src_prefix + ":" +
        message.pkt_hash + ":" +
        message.seq
    );
}

//
// true se la ricezione `a` è arrivata prima di `b` (a parità di secondo, id
// minore). Non si fa affidamento sull'ordine dell'array: lo garantisce il
// server, ma qui basta un confronto.
//
function sonarReceivedBefore(
    a,
    b
) {

    if (
        a.observed_at !== b.observed_at
    ) {

        return a.observed_at < b.observed_at;
    }

    return (
        (a.id === null || a.id === undefined ? 0 : a.id) <
        (b.id === null || b.id === undefined ? 0 : b.id)
    );
}

//
// Riepilogo di UN mittente. entries: le sue ricezioni come
// { message, index } (index = posizione nell'array d'origine), in qualunque
// ordine. Restituisce il suo ULTIMO messaggio — quello la cui prima copia è
// arrivata per ultima — rappresentato dalla PRIMA copia, più il numero di
// ricezioni totali: { message, index, receptions }.
//
function summarizeSonarSender(
    entries
) {

    const groups =
        new Map();

    entries.forEach(
        entry => {

            const key =
                sonarMessageGroupKey(
                    entry.message
                );

            const known =
                groups.get(key);

            if (
                !known ||
                sonarReceivedBefore(
                    entry.message,
                    known.message
                )
            ) {

                groups.set(
                    key,
                    entry
                );
            }
        }
    );

    let last = null;

    groups.forEach(
        entry => {

            if (
                last === null ||
                sonarReceivedBefore(
                    last.message,
                    entry.message
                )
            ) {

                last = entry;
            }
        }
    );

    return {
        message: last.message,
        index: last.index,
        receptions: entries.length
    };
}

//
// Le righe dell'elenco: una per mittente, più recente in cima (per l'arrivo
// della prima copia del suo ultimo messaggio; a parità, quello arrivato dopo
// nell'array). messages: l'array di /api/sonar/messages.
// Ritorna [{ prefix, message, index, receptions }].
//
function buildSonarSenderRows(
    messages
) {

    const bySender =
        new Map();

    messages.forEach(
        (message, index) => {

            let list =
                bySender.get(
                    message.src_prefix
                );

            if (
                !list
            ) {

                list = [];

                bySender.set(
                    message.src_prefix,
                    list
                );
            }

            list.push(
                { message: message, index: index }
            );
        }
    );

    const rows = [];

    bySender.forEach(
        (entries, prefix) => {

            const summary =
                summarizeSonarSender(
                    entries
                );

            rows.push(
                {
                    prefix: prefix,
                    message: summary.message,
                    index: summary.index,
                    receptions: summary.receptions
                }
            );
        }
    );

    rows.sort(
        (a, b) =>
            b.message.observed_at - a.message.observed_at ||
            b.index - a.index
    );

    return rows;
}

//
// Filtro «solo mittenti trace-mon» (solo Collettore: nel Nodo il checkbox
// non esiste e la funzione risponde false). Dalle righe del server arriva
// `trace_mon` (true/false); una risposta senza il campo non filtra niente.
//
function sonarTraceMonOnlyEnabled() {

    const checkbox =
        document.getElementById(
            "sonarTraceMonOnlyFilter"
        );

    return Boolean(
        checkbox &&
        checkbox.checked
    );
}

//
// Stato iniziale del filtro e listener, una volta sola (guard
// dataset.bound come initNodesFilters()). Spento di default (scelta
// dell'utente): si vede tutto ciò che è arrivato sul canale; la scelta
// successiva resta nel browser come per gli altri filtri della pagina.
//
function initSonarFilter() {

    const checkbox =
        document.getElementById(
            "sonarTraceMonOnlyFilter"
        );

    if (
        !checkbox ||
        checkbox.dataset.bound
    ) {

        return;
    }

    checkbox.dataset.bound =
        "true";

    checkbox.checked =
        safeLocalStorageGet(
            "sonarTraceMonOnly"
        ) === "true";

    checkbox.addEventListener(
        "change",
        () => {

            safeLocalStorageSet(
                "sonarTraceMonOnly",
                checkbox.checked
            );

            renderSonarMessagesTable();
        }
    );
}

function updateSonarMessagesHeading(
    shown,
    total
) {

    const heading =
        document.getElementById(
            "sonarMessagesHeading"
        );

    if (
        !heading
    ) {

        return;
    }

    //
    // Si contano i MITTENTI (le righe dell'elenco), non le ricezioni.
    //
    heading.textContent =
        shown === null ?
            tl("idx.sonarMessages") :
            shown === total ?
                tln("sonar.heading", total) :
                tln("sonar.headingFiltered", total, { shown: shown });
}

async function loadSonarMessages() {

    const table =
        document.getElementById(
            "sonarMessagesTable"
        );

    if (
        !table
    ) {

        return;
    }

    initSonarFilter();

    const requestId =
        ++sonarMessagesRequestId;

    try {

        const res =
            await fetch(
                sonarMessagesUrl()
            );

        assertResOk(res);

        const data =
            await res.json();

        if (
            requestId !== sonarMessagesRequestId
        ) {

            return;
        }

        if (
            !data ||
            !Array.isArray(data.messages) ||
            typeof data.senders !== "object" ||
            data.senders === null
        ) {

            throw new Error(
                "invalid sonar messages response"
            );
        }

        sonarMessagesState = {
            available: data.available !== false,
            reason: data.reason || null,
            messages: data.messages,
            senders: data.senders
        };

        renderSonarMessagesTable();
    }

    catch (
        err
    ) {

        if (
            requestId !== sonarMessagesRequestId
        ) {

            return;
        }

        console.error(
            "Error loading Sonar messages:",
            err
        );

        updateSonarMessagesHeading(
            null,
            0
        );

        table.innerHTML =
            `<tr><td>${tle("common.errorLoadingData")}</td></tr>`;
    }
}

//
// Testo (non HTML) con cui si indica un mittente: titolo del dettaglio.
// Il nome viene da `nodes`, cioè da advert ricevuti dalla rete: chi lo
// inserisce in innerHTML deve escaparlo.
//
function sonarSenderLabel(
    prefix,
    sender
) {

    const status =
        sender && sender.status ?
            sender.status :
            "unknown";

    if (
        status === "ok"
    ) {

        return (
            sender.adv_name ||
            prefix
        );
    }

    if (
        status === "ambiguous"
    ) {

        return `${tl("sonar.senderAmbiguous")} ${prefix}`;
    }

    return `${tl("common.unknownParen")} ${prefix}`;
}

//
// Cella «Sender» dell'elenco: il nome (se noto) è il LINK al dettaglio, con
// accanto il prefisso di 8 caratteri, che è l'unica cosa certa del mittente.
// Un mittente senza nome ha il prefisso come testo del link; sconosciuto o
// ambiguo ha «(unknown)» / «(ambiguous)» come in Known Nodes un nodo senza
// nome. Tutto passa da escapeHtml(): il nome viene dalla rete.
//
function buildSonarSenderHtml(
    prefix,
    sender
) {

    const link =
        text =>
            `<a href="#" class="nodeLink sonarSenderLink" data-prefix="${escapeHtml(prefix)}">${escapeHtml(text)}</a>`;

    const prefixHtml =
        `<span class="sonarSenderPrefix">${escapeHtml(prefix)}</span>`;

    const status =
        sender && sender.status ?
            sender.status :
            "unknown";

    if (
        status === "ok" &&
        sender.adv_name
    ) {

        return `${link(sender.adv_name)} ${prefixHtml}`;
    }

    if (
        status === "ok"
    ) {

        return link(prefix);
    }

    if (
        status === "ambiguous"
    ) {

        return `${link(tl("sonar.senderAmbiguous"))} ${prefixHtml}`;
    }

    return `${link(tl("common.unknownParen"))} ${prefixHtml}`;
}

//
// Cella «Path»: come in Known Nodes. Unica differenza: hop_count > 0 senza
// path_hex (riga con path non esadecimale, svuotato dal server) non deve
// leggersi «DIRECT», che è ciò che buildAdvertPathHtml() scriverebbe.
//
// hopSpans (Map, facoltativa): memoria dei <span> già costruiti per ogni
// hop, valida per UN ridisegno della tabella. Serve solo a non rifare per
// ogni riga la risoluzione del nome (resolveNodeName() scorre tutti i
// repeater noti): con migliaia di messaggi la tabella altrimenti impiega
// secondi. L'HTML prodotto è identico a quello di buildAdvertPathHtml()
// (lo verifica il test).
//
function buildSonarPathCellHtml(
    message,
    hopSpans
) {

    if (
        message.hop_count > 0 &&
        !message.path_hex
    ) {

        return tle("sonar.pathUnknown", { n: message.hop_count });
    }

    const hops =
        splitAdvertPathHops(
            message.hop_count,
            message.path_hex
        );

    if (
        !hopSpans ||
        hops.length === 0
    ) {

        return buildAdvertPathHtml(
            message.hop_count,
            message.path_hex
        );
    }

    return hops
        .map(
            hop => {

                let span =
                    hopSpans.get(hop);

                if (
                    span === undefined
                ) {

                    span =
                        `<span data-tooltip="${escapeHtml(resolveNodeName(hop))}">${hop}</span>`;

                    hopSpans.set(
                        hop,
                        span
                    );
                }

                return span;
            }
        )
        .join(" > ");
}

function renderSonarMessagesTable() {

    const table =
        document.getElementById(
            "sonarMessagesTable"
        );

    if (
        !table
    ) {

        return;
    }

    const state =
        sonarMessagesState;

    //
    // Tabella non presente nel database (nodo non aggiornato): lo stesso
    // messaggio «dati non presenti» di Known Nodes sul Collettore.
    //
    if (
        !state.available
    ) {

        updateSonarMessagesHeading(
            null,
            0
        );

        table.innerHTML =
            `<tr><td>${tle("nodes.noDataForNode")}</td></tr>`;

        return;
    }

    //
    // Una riga per mittente (D112): il suo ultimo messaggio, con la data e il
    // path della prima copia arrivata. Il filtro «solo trace-mon» (solo
    // Collettore) toglie i mittenti, non le ricezioni.
    //
    const senderRows =
        buildSonarSenderRows(
            state.messages
        );

    const onlyTraceMon =
        sonarTraceMonOnlyEnabled();

    const rows =
        onlyTraceMon ?
            senderRows.filter(
                r => r.message.trace_mon === true
            ) :
            senderRows;

    updateSonarMessagesHeading(
        rows.length,
        senderRows.length
    );

    if (
        rows.length === 0
    ) {

        const text =
            senderRows.length > 0 ?
                tle("sonar.noMatch") :
                state.reason === "no_archive" ?
                    tle("sonar.noArchive") :
                    tle("sonar.noMessages");

        table.innerHTML =
            `<tr><td>${text}</td></tr>`;

        return;
    }

    let html =
        `<tr><th>${tle("sonar.colSender")}</th><th>${tle("ndet.colReceived")}</th><th>Path</th></tr>`;

    const hopSpans =
        new Map();

    rows.forEach(
        row => {

            html += "<tr>";
            html += `<td>${buildSonarSenderHtml(row.prefix, state.senders[row.prefix])}</td>`;
            html += `<td>${formatUnixTime(row.message.observed_at)}</td>`;
            html += `<td>${buildSonarPathCellHtml(row.message, hopSpans)}</td>`;
            html += "</tr>";
        }
    );

    table.innerHTML = html;

    table.querySelectorAll(
        ".sonarSenderLink"
    ).forEach(
        link => {

            link.addEventListener(
                "click",
                (e) => {

                    e.preventDefault();

                    goToSonarSenderDetail(
                        link.dataset.prefix
                    );
                }
            );
        }
    );
}

/* ---- pagina di dettaglio del mittente ---- */

//
// Apre la pagina di dettaglio (stesso schema di goToNodeDetail()): ferma
// l'aggiornamento automatico di Nodes, nasconde ogni pagina e mostra
// #sonarDetailPage. «Back to list» (index.html) fa il percorso inverso.
//
function goToSonarSenderDetail(
    prefix
) {

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
        "sonarDetailPage"
    ).style.display = "block";

    loadSonarSenderDetail(
        prefix
    );
}

//
// Prende dall'ultimo elenco caricato le ricezioni del mittente (copia, in
// ordine cronologico) e disegna intestazione, tabella info e tabella delle
// ricezioni. Nessuna richiesta di rete: lo stesso elenco da cui si è partiti.
//
function loadSonarSenderDetail(
    prefix
) {

    sonarDetailPrefix =
        prefix;

    sonarDetailSender =
        sonarMessagesState.senders[prefix] ||
        null;

    sonarDetailRows =
        sonarMessagesState.messages.filter(
            m => m.src_prefix === prefix
        );

    document.getElementById(
        "sonarDetailName"
    ).textContent =
        sonarSenderLabel(
            prefix,
            sonarDetailSender
        );

    renderSonarDetailInfo();

    renderSonarDetailTable();
}

//
// Tabella info (come #nodeDetailInfoTable): tipo, chiave, posizione dal
// mittente risolto; ultimo messaggio e ricezioni totali dalle ricezioni.
// Un mittente sconosciuto o ambiguo ha solo la riga del prefisso.
//
function renderSonarDetailInfo() {

    const infoTable =
        document.getElementById(
            "sonarDetailInfoTable"
        );

    if (
        !infoTable
    ) {

        return;
    }

    const sender =
        sonarDetailSender;

    let html = "";

    if (
        sender &&
        sender.status === "ok"
    ) {

        html += `<tr><th>${tle("ndet.infoType")}</th><td>${escapeHtml(formatNodeType(sender.node_type))}</td></tr>`;
        html += `<tr><th>${tle("ndet.infoPublicKey")}</th><td>${escapeHtml(sender.public_key || sonarDetailPrefix)}</td></tr>`;
        html += `<tr><th>${tle("ndet.infoPosition")}</th><td>${formatNodePosition(sender.adv_lat, sender.adv_lon)}</td></tr>`;

    } else {

        const note =
            sender && sender.status === "ambiguous" ?
                tl("sonar.senderAmbiguous") :
                tl("common.unknownParen");

        html += `<tr><th>${tle("ndet.infoPublicKey")}</th><td>${escapeHtml(sonarDetailPrefix)} ${escapeHtml(note)}</td></tr>`;
    }

    if (
        sonarDetailRows.length > 0
    ) {

        const summary =
            summarizeSonarSender(
                sonarDetailRows.map(
                    (message, index) => ({ message: message, index: index })
                )
            );

        html += `<tr><th>${tle("sonar.infoLastMessage")}</th><td>${formatUnixTime(summary.message.observed_at)}</td></tr>`;
        html += `<tr><th>${tle("sonar.infoReceptions")}</th><td>${summary.receptions}</td></tr>`;
    }

    infoTable.innerHTML =
        html;
}

//
// Tabella di TUTTE le ricezioni del mittente (come #nodeDetailObsTable),
// più recenti in cima. L'indice originale (posizione in sonarDetailRows)
// viaggia con ogni link in data-sonar-index. Ogni (ri)disegno riporta la
// mappa al messaggio guida: la ricezione selezionata potrebbe non esistere
// più. Msg = numero progressivo del mittente (seq): le righe con lo stesso
// numero sono le copie dello stesso messaggio.
//
function renderSonarDetailTable() {

    resetSonarPathMap();

    const table =
        document.getElementById(
            "sonarDetailMsgTable"
        );

    if (
        !table
    ) {

        return;
    }

    const rows =
        sonarDetailRows;

    if (
        rows.length === 0
    ) {

        table.innerHTML =
            `<tr><td>${tle("sonar.noMessages")}</td></tr>`;

        return;
    }

    let html =
        `<tr><th>${tle("sonar.colMsg")}</th><th>${tle("ndet.colReceived")}</th><th>${tle("ndet.colHops")}</th><th>Path</th><th>RSSI</th><th>SNR</th></tr>`;

    const hopSpans =
        new Map();

    for (
        let i = rows.length - 1;
        i >= 0;
        i--
    ) {

        const m =
            rows[i];

        html += "<tr>";
        html += `<td>${m.seq === null || m.seq === undefined ? "-" : "#" + m.seq}</td>`;
        html += `<td><a href="#" class="traceLink nodePathLink sonarPathLink" data-sonar-index="${i}" data-sonar-key="${escapeHtml(sonarMessageKey(m))}">${formatUnixTime(m.observed_at)}</a></td>`;
        html += `<td>${m.hop_count}</td>`;
        html += `<td>${buildSonarPathCellHtml(m, hopSpans)}</td>`;
        html += `<td>${m.rssi ?? "-"}</td>`;
        html += `<td>${m.snr === null || m.snr === undefined ? "-" : colorizeSnr(m.snr)}</td>`;
        html += "</tr>";
    }

    table.innerHTML = html;

    table.querySelectorAll(
        ".sonarPathLink"
    ).forEach(
        link => {

            link.addEventListener(
                "click",
                (e) => {

                    e.preventDefault();

                    showSonarMessagePath(
                        Number(
                            link.dataset.sonarIndex
                        )
                    );
                }
            );
        }
    );
}

/* ---- mappa del path del messaggio ---- */

//
// Modello PURO (nessun DOM, nessuna fetch) del path di un messaggio.
// Riusa buildAdvertPathModel() con un «nodo» fatto col mittente risolto,
// poi corregge solo il punto d'origine:
//   - mittente risolto: nome e posizione sono quelli di `nodes` (un nodo
//     senza GPS o a (0,0) viene omesso con il motivo di sempre);
//   - sconosciuto / ambiguo: non ha posizione, quindi non è disegnato; il
//     motivo è quello vero («mittente sconosciuto/ambiguo»), non «posizione
//     non nota», e il prefisso sostituisce il nome.
// message  riga di /api/sonar/messages
// sender   message's entry in `senders` (o undefined)
// srcInfo  come per buildAdvertPathModel()
//
function buildSonarPathModel(
    message,
    sender,
    srcInfo
) {

    const status =
        sender && sender.status ?
            sender.status :
            "unknown";

    const resolved =
        status === "ok";

    const model =
        buildAdvertPathModel(
            resolved ?
                {
                    adv_name: sender.adv_name,
                    node_type: sender.node_type,
                    adv_lat: sender.adv_lat,
                    adv_lon: sender.adv_lon
                } :
                {
                    adv_name: null,
                    node_type: null,
                    adv_lat: null,
                    adv_lon: null
                },
            {
                hop_count: message.hop_count,
                path_hex: message.path_hex
            },
            srcInfo
        );

    const origin =
        model.points[0];

    origin.step =
        tl("smap.stepSender");

    if (
        resolved
    ) {

        origin.name =
            sender.adv_name ||
            message.src_prefix;

        return model;
    }

    origin.name = null;
    origin.hash = message.src_prefix;
    origin.nodeType = null;

    origin.reason =
        status === "ambiguous" ?
            {
                kind: "duplicate",
                text:
                    tl("smap.reasonSenderAmbiguous", { n: sender.count, prefix: message.src_prefix })
            } :
            {
                kind: "missing",
                text:
                    tl("smap.reasonSenderUnknown", { prefix: message.src_prefix })
            };

    return model;
}

function ensureSonarPathMap() {

    if (
        sonarPathMap
    ) {

        return sonarPathMap;
    }

    sonarPathMap =
        L.map(
            "sonarPathMap"
        ).setView(
            [0, 0],
            2
        );

    createOsmTileLayer().addTo(
        sonarPathMap
    );

    sonarPathMarkerLayerGroup =
        L.layerGroup().addTo(
            sonarPathMap
        );

    sonarPathSegmentLayerGroup =
        L.layerGroup().addTo(
            sonarPathMap
        );

    //
    // Pane delle frecce, per-mappa come in ensureNodeDetailPathMap().
    //
    const arrowPane =
        sonarPathMap.createPane(
            "traceArrowPane"
        );

    arrowPane.style.zIndex = 660;
    arrowPane.style.pointerEvents = "none";

    //
    // Riquadro «punti non mostrati» in alto a destra (classe nodePathInfo,
    // stessa del path advert): click e scroll non devono arrivare alla
    // mappa sottostante.
    //
    sonarPathInfoControl =
        L.control(
            { position: "topright" }
        );

    sonarPathInfoControl.onAdd =
        function () {

            const div =
                L.DomUtil.create(
                    "div",
                    "nodePathInfo"
                );

            L.DomEvent.disableClickPropagation(
                div
            );

            L.DomEvent.disableScrollPropagation(
                div
            );

            div.style.display = "none";

            return div;
        };

    sonarPathInfoControl.addTo(
        sonarPathMap
    );

    sonarPathMap.on(
        "zoomend",
        renderSonarPathSegmentsAtCurrentZoom
    );

    return sonarPathMap;
}

function updateSonarPathInfo(
    html
) {

    if (
        !sonarPathInfoControl
    ) {

        return;
    }

    const container =
        sonarPathInfoControl.getContainer();

    if (
        !container
    ) {

        return;
    }

    container.innerHTML =
        html;

    container.style.display =
        html ?
            "block" :
            "none";
}

//
// Riporta la sezione allo stato iniziale: messaggio guida, mappa nascosta e
// svuotata, nessun messaggio selezionato. Incrementa sonarPathRequestId:
// la fetch di SRC di un click precedente, se risponde dopo, scarta il suo
// risultato. Tollera elementi DOM assenti (test con DOM minimale).
//
function resetSonarPathMap() {

    ++sonarPathRequestId;

    sonarSelectedKey = null;

    sonarPathSegmentDefs = [];

    if (
        sonarPathMarkerLayerGroup
    ) {

        sonarPathMarkerLayerGroup.clearLayers();
    }

    if (
        sonarPathSegmentLayerGroup
    ) {

        sonarPathSegmentLayerGroup.clearLayers();
    }

    updateSonarPathInfo(
        ""
    );

    const guide =
        document.getElementById(
            "sonarPathGuide"
        );

    const caption =
        document.getElementById(
            "sonarPathCaption"
        );

    const mapEl =
        document.getElementById(
            "sonarPathMap"
        );

    if (
        guide
    ) {

        guide.style.display = "";
    }

    if (
        caption
    ) {

        caption.textContent = "";
    }

    if (
        mapEl
    ) {

        mapEl.style.display = "none";
    }

    markSelectedSonarPathLink();
}

//
// Evidenzia il link (e la riga) della ricezione selezionata nel dettaglio, in
// base alla chiave: sopravvive a un ridisegno della tabella.
//
function markSelectedSonarPathLink() {

    document.querySelectorAll(
        "#sonarDetailMsgTable .sonarPathLink"
    ).forEach(
        link => {

            const selected =
                sonarSelectedKey !== null &&
                link.dataset.sonarKey === sonarSelectedKey;

            link.classList.toggle(
                "selected",
                selected
            );

            const row =
                link.closest(
                    "tr"
                );

            if (
                row
            ) {

                row.classList.toggle(
                    "nodePathSelectedRow",
                    selected
                );
            }
        }
    );
}

//
// Click su un «Received» del dettaglio: legge la posizione LIVE di SRC (come
// per l'advert, mai una copia nella riga), costruisce il modello e lo disegna.
//
async function showSonarMessagePath(
    index
) {

    const message =
        sonarDetailRows[index];

    if (
        !message
    ) {

        return;
    }

    //
    // Token catturato PRIMA di qualunque await: due click ravvicinati
    // fanno vincere l'ultimo, non il più lento a rispondere.
    //
    const requestId =
        ++sonarPathRequestId;

    sonarSelectedKey =
        sonarMessageKey(
            message
        );

    markSelectedSonarPathLink();

    const srcInfo = {
        fetchFailed: false,
        lat: null,
        lon: null
    };

    try {

        const res =
            await fetch(
                sonarDeviceStatusUrl()
            );

        assertResOk(res);

        const status =
            await res.json();

        if (
            requestId !== sonarPathRequestId
        ) {

            return;
        }

        if (
            status
        ) {

            srcInfo.lat =
                status.adv_lat;

            srcInfo.lon =
                status.adv_lon;
        }

    } catch (
        err
    ) {

        if (
            requestId !== sonarPathRequestId
        ) {

            return;
        }

        console.error(
            "Error loading device status for Sonar message path:",
            err
        );

        srcInfo.fetchFailed = true;
    }

    renderSonarPath(
        buildSonarPathModel(
            message,
            sonarDetailSender,
            srcInfo
        ),
        message
    );
}

//
// Disegna il modello: marker dei punti mostrati, vista sui loro limiti,
// segmenti+frecce, riquadro dei punti mancanti, didascalia.
//
function renderSonarPath(
    model,
    message
) {

    const guide =
        document.getElementById(
            "sonarPathGuide"
        );

    const mapEl =
        document.getElementById(
            "sonarPathMap"
        );

    const caption =
        document.getElementById(
            "sonarPathCaption"
        );

    if (
        guide
    ) {

        guide.style.display = "none";
    }

    //
    // Il contenitore va reso visibile PRIMA di creare la mappa o di
    // chiamare invalidateSize() (v. ensureNodeDetailPathMap()).
    //
    mapEl.style.display = "block";

    const map =
        ensureSonarPathMap();

    map.invalidateSize();

    sonarPathMarkerLayerGroup.clearLayers();
    sonarPathSegmentLayerGroup.clearLayers();

    const bounds = [];

    model.points.forEach(
        p => {

            if (
                !p.shown
            ) {

                return;
            }

            const label =
                p.role === "origin" ?
                    tl("smap.markerSender", { name: p.name }) :
                    p.role === "src" ?
                        p.name :
                        `${p.name} (${p.hash})`;

            L.marker(
                [p.lat, p.lon],
                { icon: nodePathIconForPoint(p) }
            ).bindTooltip(
                escapeHtml(label),
                {
                    permanent: true,
                    direction: "top"
                }
            ).addTo(
                sonarPathMarkerLayerGroup
            );

            bounds.push(
                [p.lat, p.lon]
            );
        }
    );

    sonarPathSegmentDefs =
        model.segments.map(
            s => ({
                latlngFrom: { lat: s.from.lat, lng: s.from.lon },
                latlngTo: { lat: s.to.lat, lng: s.to.lon },
                bridged: s.bridged,
                isDegenerate:
                    s.from.lat === s.to.lat &&
                    s.from.lon === s.to.lon
            })
        );

    if (
        bounds.length >= 2
    ) {

        map.fitBounds(
            bounds,
            {
                padding: [30, 30],
                animate: false,
                maxZoom: 16
            }
        );

    } else if (
        bounds.length === 1
    ) {

        map.setView(
            bounds[0],
            13,
            { animate: false }
        );
    }

    renderSonarPathSegmentsAtCurrentZoom();

    updateSonarPathInfo(
        buildNodePathInfoHtml(
            model
        )
    );

    if (
        caption
    ) {

        caption.textContent =
            tl("smap.caption", {
                time: formatUnixTime(message.observed_at),
                hops:
                    message.hop_count === 0 ?
                        "DIRECT (0 hop)" :
                        `${message.hop_count} hop`,
                shown: bounds.length,
                total: model.points.length
            });
    }

    const section =
        document.getElementById(
            "sonarPathSection"
        );

    if (
        section &&
        typeof section.scrollIntoView === "function"
    ) {

        section.scrollIntoView(
            { block: "nearest", behavior: "smooth" }
        );
    }
}

//
// Segmenti+frecce con lo zoom corrente — stessa logica di
// renderNodeDetailPathSegmentsAtCurrentZoom() (le frecce di arrivo sono a
// distanza fissa in pixel dal marker, quindi dipendono dallo zoom).
//
function renderSonarPathSegmentsAtCurrentZoom() {

    if (
        !sonarPathMap ||
        !sonarPathSegmentLayerGroup
    ) {

        return;
    }

    sonarPathSegmentLayerGroup.clearLayers();

    const zoom =
        sonarPathMap.getZoom();

    sonarPathSegmentDefs.forEach(
        def => {

            const offsetResult =
                offsetSegmentPixels(
                    sonarPathMap,
                    zoom,
                    def.latlngFrom,
                    def.latlngTo,
                    0
                );

            const offset =
                offsetResult.latlngs;

            const lineColor =
                def.bridged ?
                    NODE_PATH_BRIDGE_COLOR :
                    NODE_PATH_LINE_COLOR;

            const arrowColor =
                def.bridged ?
                    NODE_PATH_BRIDGE_COLOR :
                    NODE_PATH_ARROW_COLOR;

            const line =
                L.polyline(
                    offset,
                    {
                        color: lineColor,
                        weight: 3,
                        dashArray:
                            def.bridged ?
                                "8 6" :
                                "4 6"
                    }
                );

            if (
                def.bridged
            ) {

                line.bindTooltip(
                    tle("pmap.bridgedTooltip"),
                    { sticky: true }
                );
            }

            line.addTo(
                sonarPathSegmentLayerGroup
            );

            //
            // Segmento degenere (due punti alla stessa posizione):
            // nessuna freccia, il bearing non è definito.
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

            const ARROW_MID_T = 0.7;

            addTraceArrowMarker(
                offset,
                bearing,
                arrowColor,
                ARROW_MID_T,
                sonarPathSegmentLayerGroup
            );

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
                arrowColor,
                ARROW_END_T,
                sonarPathSegmentLayerGroup
            );
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
                    r.adv_name || tl("common.unknownParen");

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
            tl("rep.errorList")
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
            tl("rep.noData")
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
            tl("common.errorLoadingData");
    }
}

function formatSecsAgo(
    secs
) {

    if (
        secs === null ||
        secs === undefined
    ) {

        return tl("common.na");
    }

    if (
        secs < 60
    ) {

        return tl("common.agoSeconds", { n: secs });
    }

    if (
        secs < 3600
    ) {

        return tl("common.agoMinutes", { n: Math.floor(secs / 60) });
    }

    if (
        secs < 86400
    ) {

        return tl("common.agoHours", { h: Math.floor(secs / 3600), m: Math.floor((secs % 3600) / 60) });
    }

    return tl("common.agoDays", { n: Math.floor(secs / 86400) });
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

        return tl("common.na");
    }

    if (
        Math.abs(skewSeconds) < CLOCK_SKEW_SYNC_THRESHOLD_SECS
    ) {

        return tl("common.inSync");
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

        return tl("common.na");
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

        return tl("common.na");
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

        return tl("common.na");
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

        return tl("common.na");
    }

    const total =
        nb_recv + recv_errors;

    if (
        !total
    ) {

        return tl("common.na");
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

        return tl("common.unknown");
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

    //
    // Unità Cayenne LPP STANDARD (non inventate — stesse della
    // libreria cayennelpp usata da meshcore_py, v.
    // docs/ARCHITECTURE.md §81) per i tipi finora osservati in campo:
    // voltage/temperature da IK2XYP-RPT (docs/NEIGHBOR_MONITORING.md
    // §10, 2026-08-08), più altitude/barometer/humidity da
    // node_04/IT-VEN-AlpiBL-D (§81, 2026-09-26). Qualunque tipo LPP
    // non elencato qui resta senza unità — principio invariato dal
    // §10: meglio un dato spoglio ma corretto che un'unità inventata
    // per un tipo mai verificato contro la libreria. Costante LOCALE
    // (non top-level): le funzioni di questo file vengono estratte
    // singolarmente nei test tramite conteggio graffe a partire da
    // "function <nome>(" — una costante dichiarata fuori da qui non
    // sarebbe inclusa nell'estrazione.
    //
    const TELEMETRY_UNITS = {
        voltage: "V",
        temperature: "°C",
        altitude: "m",
        barometer: "hPa",
        humidity: "%",
    };

    if (
        Object.prototype.hasOwnProperty.call(TELEMETRY_UNITS, type)
    ) {

        return `${value} ${TELEMETRY_UNITS[type]}`;
    }

    return `${value}`;
}

//
// Telemetria del device companion locale, righe della tabella Device
// Status (tab Nodes) — v. docs/ARCHITECTURE.md §76.
//
// Una riga <tr> per misura, subito dopo "Radio settings", con
// etichetta "Telemetry - <Tipo> (ch N)" e valore con unità. Il dato
// arriva da status.telemetry, colonna TEXT di device_status che
// contiene una lista JSON [{channel, type, value}, ...] (v.
// contact_sync.py::_get_self_telemetry()). Il server la restituisce
// così com'è (SELECT *, nessuna modifica a server.js), quindi qui
// arriva come STRINGA JSON — accettata anche come array già parsato.
//
// Tre stati, tutti resi come UNA sola riga "Telemetry | n/a" invece
// di righe vuote o di un errore:
//   - colonna assente (DB non ancora migrato, daemon Python vecchio
//     o mai girato): status.telemetry === undefined;
//   - NULL: telemetria mai ottenuta dal device;
//   - "[]" o JSON non valido: nessuna misura utilizzabile.
//
// Formattazione dei valori: formatTelemetryType()/
// formatTelemetryValue() sono le STESSE della tabella Telemetry dei
// Repeaters (unità standard Cayenne LPP per i tipi noti — vedi
// TELEMETRY_UNITS sopra formatTelemetryValue(), §81 — tutto il resto
// senza unità inventata) e NON vanno toccate da qui — sono condivise.
// Per i valori non scalari che meshcore_py può restituire per certi
// tipi LPP (dict per gps/accelerometer/colour, lista per gyrometer/
// direction) formatDeviceTelemetryValue() li appiattisce in testo.
//
// type/channel/value sono dati provenienti da un device esterno (il
// tipo LPP è un nome libero lato firmware), quindi tutto ciò che
// finisce in innerHTML passa da escapeHtml() — la tabella Telemetry
// dei Repeaters li inietta grezzi, ma non è un buon motivo per
// replicarlo qui. I tooltip sono testi statici: descrivono cosa
// mostra la riga, non da dove arriva il dato (v. §72.1).
//
function formatDeviceTelemetryValue(
    type,
    value
) {

    if (
        value == null
    ) {

        return tl("common.na");
    }

    const flatten =
        (v) => {

            if (
                v == null
            ) {

                return tl("common.na");
            }

            if (
                typeof v === "object"
            ) {

                try {

                    return JSON.stringify(v);

                } catch (e) {

                    return tl("common.na");
                }
            }

            return String(v);
        };

    let text;

    if (
        Array.isArray(value)
    ) {

        text =
            value.map(flatten).join(", ");

    } else if (
        typeof value === "object"
    ) {

        text =
            Object.entries(value)
                .map(([k, v]) => `${k}: ${flatten(v)}`)
                .join(", ");

    } else {

        text =
            formatTelemetryValue(type, value);
    }

    return text === "" ? tl("common.na") : text;
}

function buildDeviceTelemetryRowsHtml(
    raw
) {

    let list = raw;

    if (
        typeof raw === "string"
    ) {

        try {

            list = JSON.parse(raw);

        } catch (e) {

            list = null;
        }
    }

    const measures =
        Array.isArray(list)
            ? list.filter(
                (t) => t !== null && typeof t === "object"
            )
            : [];

    if (
        measures.length === 0
    ) {

        return `<tr><th data-tooltip="${tle("tip.telemetry")}">Telemetry</th><td>${tle("common.na")}</td></tr>`;
    }

    return measures.map(
        (t) => {

            const type =
                typeof t.type === "string"
                    ? t.type
                    : null;

            const channel =
                Number.isInteger(t.channel)
                    ? ` (ch ${t.channel})`
                    : "";

            let tooltip =
                tle("tip.telDefault");

            if (
                type === "voltage"
            ) {

                tooltip =
                    tle("tip.telVoltage");

            } else if (
                type === "temperature"
            ) {

                tooltip =
                    tle("tip.telTemperature");
            }

            const label =
                `Telemetry - ${type ? formatTelemetryType(type) : "Unknown"}${channel}`;

            return `<tr><th data-tooltip="${tooltip}">${escapeHtml(label)}</th><td>${escapeHtml(formatDeviceTelemetryValue(type, t.value))}</td></tr>`;
        }
    ).join("\n        ");
}

//
// Riga «Dati dell'ultima interrogazione che li ha ricevuti: <data>» sopra le
// tabelle Telemetry e Neighbours (docs/ARCHITECTURE.md §113). Il writer non
// scrive nulla per una richiesta senza risposta, quindi in un giro in cui lo
// status riesce ma i neighbours (o la telemetria) no, la API restituisce
// l'ultimo giro che ha righe: quando non è quello dello status la pagina dice
// da quando sono i dati. Nascosta se i due giri coincidono, se non ci sono
// dati o se la API non porta il campo (undefined == null). Con un mese
// archiviato (renderNeighboursTable() senza il secondo argomento) la riga
// resta nascosta: lo scatto scelto ha la sua etichetta nel selettore.
//
function setSnapshotNote(
    elementId,
    snapshotQueriedAt,
    statusQueriedAt
) {

    const el =
        document.getElementById(
            elementId
        );

    if (
        !el
    ) {

        return;
    }

    if (
        snapshotQueriedAt == null ||
        snapshotQueriedAt === statusQueriedAt
    ) {

        el.textContent = "";
        el.style.display = "none";

        return;
    }

    el.textContent =
        tl("rep.snapshotFrom", { t: formatUnixTime(snapshotQueriedAt) });

    el.style.display = "";
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
        data.adv_name || tl("common.unknownParen");

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
            `<tr><td>${tle("rep.noStatus")}</td></tr>` +
            `<tr><th data-tooltip="${tle("tip.clockSkew")}">Clock Skew</th><td>${formatClockSkew(clock ? clock.skew_seconds : null)}</td></tr>`;
    }

    else {

        statusTable.innerHTML = `
            <tr><th data-tooltip="${tle("tip.queriedAt")}">Queried At</th><td>${formatUnixTime(status.queried_at)}</td></tr>
            <tr><th data-tooltip="${tle("tip.battery")}">Battery</th><td>${(status.bat / 1000).toFixed(2)}V</td></tr>
            <tr><th data-tooltip="${tle("tip.uptime")}">Uptime</th><td>${formatDurationLong(status.uptime)}</td></tr>
            <tr><th data-tooltip="${tle("tip.noiseFloor")}">Noise Floor</th><td>${status.noise_floor} dBm</td></tr>
            <tr><th data-tooltip="${tle("tip.lastRssi")}">Last RSSI</th><td>${status.last_rssi} dBm</td></tr>
            <tr><th data-tooltip="${tle("tip.lastSnr")}">Last SNR</th><td>${status.last_snr} dB</td></tr>
            <tr><th data-tooltip="${tle("tip.txQueueLength")}">TX Queue Length</th><td>${status.tx_queue_len}</td></tr>
            <tr><th data-tooltip="${tle("tip.packetsReceived")}">Packets Received</th><td>${status.nb_recv} pkts</td></tr>
            <tr><th data-tooltip="${tle("tip.packetsSent")}">Packets Sent</th><td>${status.nb_sent} pkts</td></tr>
            <tr><th data-tooltip="${tle("tip.sent")}">Sent (Flood | Direct)</th><td>${status.sent_flood} pkts | ${status.sent_direct} pkts</td></tr>
            <tr><th data-tooltip="${tle("tip.received")}">Received (Flood | Direct)</th><td>${status.recv_flood} pkts | ${status.recv_direct} pkts</td></tr>
            <tr><th data-tooltip="${tle("tip.duplicates")}">Duplicates (Direct | Flood)</th><td>${status.direct_dups} pkts | ${status.flood_dups} pkts</td></tr>
            <tr><th data-tooltip="${tle("tip.receiveErrors")}">Receive Errors (CRC Fail)</th><td>${status.recv_errors != null ? status.recv_errors + " pkts" : tl("common.na")}</td></tr>
            <tr><th data-tooltip="${tle("tip.crcErrorRate")}">CRC Error Rate (RX)</th><td>${formatCrcErrorRate(status.recv_errors, status.nb_recv)}</td></tr>
            <tr><th data-tooltip="${tle("tip.fullEvents")}">Full Events</th><td>${status.full_evts}</td></tr>
            <tr><th data-tooltip="${tle("tip.airtime")}">Airtime (TX | RX)</th><td>${formatDurationLong(status.airtime)} | ${formatDurationLong(status.rx_airtime)}</td></tr>
            <tr><th data-tooltip="${tle("tip.airtimePercent")}">Airtime % (mesh, TX+RX/Uptime)</th><td>${formatAirtimePercent(status.airtime, status.rx_airtime, status.uptime)}</td></tr>
            <tr><th data-tooltip="${tle("tip.txDutyCycle")}">TX Duty Cycle (observed, TX/Uptime)</th><td>${formatTxDutyCyclePercent(status.airtime, status.uptime)}</td></tr>
            <tr><th data-tooltip="${tle("tip.clockSkew")}">Clock Skew</th><td>${formatClockSkew(clock ? clock.skew_seconds : null)}</td></tr>
        `;
    }

    const telemetryTable =
        document.getElementById(
            "neighborTelemetryTable"
        );

    const telemetry =
        data.telemetry || [];

    let telemetryHtml =
        `<tr><th>${tle("rep.telColChannel")}</th><th>${tle("rep.telColType")}</th><th>${tle("rep.telColValue")}</th></tr>`;

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
            `<tr><td colspan="3">${tle("rep.noTelemetry")}</td></tr>`;
    }

    telemetryTable.innerHTML =
        telemetryHtml;

    setSnapshotNote(
        "neighborTelemetryNote",
        data.telemetry_queried_at,
        status ? status.queried_at : null
    );

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
            `<tr><td>${tle("rep.noConfig")}</td></tr>`;
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
            <tr><th data-tooltip="${tle("tip.cfgFirmwareVersion")}">Firmware Version</th><td>${escapeHtml(config.firmware_version ?? tl("common.na"))}</td></tr>
            <tr><th data-tooltip="${tle("tip.cfgHardware")}">Hardware</th><td>${escapeHtml(config.hardware ?? tl("common.na"))}</td></tr>
            <tr><th data-tooltip="${tle("tip.cfgPathHashMode")}">Path Hash Mode</th><td>${config.path_hash_mode ?? tl("common.na")}</td></tr>
            <tr><th data-tooltip="${tle("tip.cfgTxDelayFlood")}">TX Delay (Flood)</th><td>${config.txdelay ?? tl("common.na")}</td></tr>
            <tr><th data-tooltip="${tle("tip.cfgTxDelayDirect")}">TX Delay (Direct)</th><td>${config.direct_txdelay ?? tl("common.na")}</td></tr>
            <tr><th data-tooltip="${tle("tip.cfgRxDelay")}">RX Delay</th><td>${config.rxdelay ?? tl("common.na")}</td></tr>
            <tr><th data-tooltip="${tle("tip.cfgFloodMaxHops")}">Flood Max Hops</th><td>${config.flood_max ?? tl("common.na")}</td></tr>
            <tr><th data-tooltip="${tle("tip.cfgFloodMaxHopsUnscoped")}">Flood Max Hops (Unscoped)</th><td>${config.flood_max_unscoped ?? tl("common.na")}</td></tr>
            <tr><th data-tooltip="${tle("tip.cfgFloodMaxHopsAdvert")}">Flood Max Hops (Advert)</th><td>${config.flood_max_advert ?? tl("common.na")}</td></tr>
            <tr><th data-tooltip="${tle("tip.cfgDefaultRegion")}">Default Region</th><td>${escapeHtml(config.region_default ?? tl("common.na"))}</td></tr>
            <tr><th data-tooltip="${tle("tip.cfgDutyCycle")}">Duty Cycle</th><td>${config.dutycycle != null ? `${config.dutycycle}%` : tl("common.na")}</td></tr>
        `;
    }

    document.getElementById(
        "neighborRegionDump"
    ).textContent =
        data.region || tl("rep.noRegion");

    renderNeighboursTable(
        data.neighbours || [],
        data.neighbours_queried_at,
        status ? status.queried_at : null
    );
}

function renderNeighboursTable(
    neighbours,
    snapshotQueriedAt,
    statusQueriedAt
) {

    setSnapshotNote(
        "neighborsNote",
        snapshotQueriedAt,
        statusQueriedAt
    );

    const heading =
        document.getElementById(
            "neighborsTabHeading"
        );

    if (
        heading
    ) {

        heading.textContent =
            tl("rep.heading", { n: neighbours.length });
    }

    const neighborsTable =
        document.getElementById(
            "neighborsTable"
        );

    let html =
        `<tr><th>${tle("rep.colName")}</th><th>${tle("rep.colPrefix")}</th><th>SNR</th><th>${tle("rep.colLastSeen")}</th></tr>`;

    neighbours.forEach(
        n => {

            let nameCell;

            if (
                n.match_count === 0
            ) {

                nameCell =
                    tl("common.unknownParen");
            }

            else if (
                n.match_count === 1
            ) {

                nameCell =
                    escapeHtml(n.matched_names);
            }

            else {

                nameCell =
                    `${escapeHtml(n.matched_names)} ${tle("rep.nameAmbiguous")}`;
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

        html += `<tr><td colspan="4">${tle("rep.noNeighbours")}</td></tr>`;
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
                opt.textContent = localizeArchiveLabel(m);

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
