//
// i18n.js - Internazionalizzazione dell'interfaccia web (Italiano / English).
//
// Questo file è IDENTICO nel Nodo (frontend/public/) e nel Collettore
// (public/) e va caricato PRIMA di app.js e analysis.js. Contiene:
//
//   1. il motore: lingua corrente (default "it", scelta ricordata nel
//      browser con la chiave localStorage "lang"), le funzioni di
//      traduzione tl() / tlh() / tln(), la traduzione degli elementi
//      statici di index.html (attributi data-i18n*) e il selettore a
//      bandierine accanto al pulsante Dark/Light Mode;
//   2. i dizionari IT/EN, affiancati per chiave, in MESSAGES.
//
// Per rifinire un termine basta modificare la riga della chiave in
// MESSAGES: nessun altro file va toccato.
//
// Regole di base dei testi (decise con l'utente):
//   - "MeshCore Path Explorer", "Trace-Path", "path", "Advert", "Hop/hop",
//     "repeater", "chat", "room server", "TIMEOUT", "Min", "Max", "Avg"
//     non si traducono mai;
//   - Node/Collector -> Nodo/Collettore; Observer -> Tracer/Tracciatore;
//   - nelle tabelle Device Status (Nodes) e Status/Config (Repeaters) gli
//     header di riga sono nomi di parametri firmware e restano in inglese
//     in entrambe le lingue: si traducono solo i tooltip.
//
// Uso nel codice:
//   tl("chiave", {nome: valore})      testo semplice; i {segnaposto} sono
//                                     sostituiti così come sono, quindi
//                                     se il risultato va in innerHTML il
//                                     chiamante usa escapeHtml(tl(...));
//   tle("chiave", {nome: valore})     come tl() ma con il risultato escapato
//                                     per HTML (testo + parametri): è la
//                                     forma da usare nelle stringhe HTML;
//   tlh("chiave", {nome: valore})     il testo del dizionario è HTML
//                                     fidato; i parametri sono escapati
//                                     (I18N.html(x) per HTML già sicuro);
//   tln("chiave", n, {nome: valore})  plurale: usa "chiave.one" se n === 1,
//                                     altrimenti "chiave.other" ({n} = n);
//                                     tlne() / tlnh() sono le varianti
//                                     escapata / HTML, come tle() / tlh().
// In index.html: data-i18n="chiave" (testo), data-i18n-html="chiave"
// (HTML), data-i18n-attr="attributo:chiave;attributo2:chiave2".
// Una chiave mancante in una lingua ricade sull'inglese, poi sulla chiave.
//
(function (root) {

    "use strict";

    var DEFAULT_LANG = "it";
    var LANGS = ["it", "en"];
    var STORAGE_KEY = "lang";

    var MESSAGES = {

        // ---- index.html: intestazione, schede, pagina Trace ----
        "idx.titleNode": {
            en: "MeshCore Path Explorer - Node v2.0.0",
            it: "MeshCore Path Explorer - Nodo v2.0.0"
        },
        "idx.titleCollector": {
            en: "MeshCore Path Explorer - Collector v2.0.0",
            it: "MeshCore Path Explorer - Collettore v2.0.0"
        },
        "idx.themeDark": {
            en: "🌙 Dark Mode",
            it: "🌙 Modalità scura"
        },
        "idx.themeLight": {
            en: "☀️ Light Mode",
            it: "☀️ Modalità chiara"
        },
        "idx.tabTrace": {
            en: "Trace",
            it: "Tracce"
        },
        "idx.tabNodes": {
            en: "Nodes",
            it: "Nodi"
        },
        "idx.tabRepeaters": {
            en: "Repeaters",
            it: "Repeater"
        },
        "idx.tabAnalysis": {
            en: "Analysis",
            it: "Analisi"
        },
        "idx.tabGuide": {
            en: "Guide",
            it: "Guida"
        },
        "idx.tabInsights": {
            en: "Insights",
            it: "Approfondimenti"
        },
        "idx.tabTelegram": {
            en: "Telegram Notification",
            it: "Notifiche Telegram"
        },
        "idx.nodeLabel": {
            en: "Node:",
            it: "Nodo:"
        },
        "common.live": {
            en: "Live",
            it: "In tempo reale"
        },
        "idx.dataSource": {
            en: "Data Source:",
            it: "Sorgente dati:"
        },
        "idx.timeRange": {
            en: "Time Range:",
            it: "Intervallo di tempo:"
        },
        "idx.range3d": {
            en: "3 Days",
            it: "3 giorni"
        },
        "idx.range7d": {
            en: "7 Days",
            it: "7 giorni"
        },
        "idx.rangeAll": {
            en: "Last Month",
            it: "Ultimo mese"
        },
        "idx.autoRefresh": {
            en: "Auto Refresh:",
            it: "Aggiornamento automatico:"
        },
        "idx.traceChart": {
            en: "Trace-Path Chart",
            it: "Grafico Trace-Path"
        },
        "idx.stats": {
            en: "Stats",
            it: "Statistiche"
        },
        "idx.traceScheduled": {
            en: "Scheduled Trace-Path",
            it: "Trace-Path pianificati"
        },
        "idx.backToTrace": {
            en: "&larr; Back to Trace",
            it: "&larr; Torna a Tracce"
        },

        // ---- index.html: pagina Nodes e dettaglio nodo ----
        "idx.deviceStatus": {
            en: "Device Status",
            it: "Stato del device"
        },
        "idx.knownNodes": {
            en: "Known Nodes",
            it: "Nodi conosciuti"
        },
        "idx.period": {
            en: "Period:",
            it: "Periodo:"
        },
        "idx.fName": {
            en: "Name / Public Key",
            it: "Nome / Chiave pubblica"
        },
        "idx.phName": {
            en: "e.g. repeater-1 or a1b2",
            it: "es. repeater-1 o a1b2"
        },
        "idx.clear": {
            en: "Clear",
            it: "Cancella"
        },
        "idx.fPathContains": {
            en: "Path contains",
            it: "Path contiene"
        },
        "idx.phPath": {
            en: "e.g. 0d28",
            it: "es. 0d28"
        },
        "idx.fType": {
            en: "Type",
            it: "Tipo"
        },
        "idx.optAll": {
            en: "All",
            it: "Tutti"
        },
        "idx.fPathLength": {
            en: "Path length",
            it: "Lunghezza path"
        },
        "idx.optPathLen1": {
            en: "1 byte (2 hex chars)",
            it: "1 byte (2 caratteri hex)"
        },
        "idx.optPathLen2": {
            en: "2 byte (4 hex chars)",
            it: "2 byte (4 caratteri hex)"
        },
        "idx.optPathLen3": {
            en: "3 byte (6 hex chars)",
            it: "3 byte (6 caratteri hex)"
        },
        "idx.fMaxHop": {
            en: "Max hop count",
            it: "Numero massimo di hop"
        },
        "idx.phMaxHop": {
            en: "e.g. 5",
            it: "es. 5"
        },
        "idx.fDistance": {
            en: "Distance from SRC",
            it: "Distanza da SRC"
        },
        "idx.optCustom": {
            en: "Custom",
            it: "Personalizzata"
        },
        "idx.fNotObserved": {
            en: "Not observed only",
            it: "Solo non osservati"
        },
        "idx.fFutureAdvert": {
            en: "Future advert only",
            it: "Solo advert futuri"
        },
        "idx.backToList": {
            en: "&larr; Back to list",
            it: "&larr; Torna all'elenco"
        },
        "idx.advertPath": {
            en: "Advert Path",
            it: "Path dell'Advert"
        },
        "idx.nodeDetailPathGuide": {
            en: "Select a value in the \"Received\" column of the Observations table to see on the map the path followed by that advert.",
            it: "Seleziona un valore nella colonna \"Ricevuto\" della tabella Osservazioni per vedere sulla mappa il path seguito da quell'advert."
        },
        "idx.observations": {
            en: "Observations",
            it: "Osservazioni"
        },
        "idx.sonarMessages": {
            en: "Sonar Messages",
            it: "Messaggi Sonar"
        },
        "idx.fSonarTraceMonOnly": {
            en: "Only trace-mon senders",
            it: "Solo mittenti nodi trace-mon"
        },
        "idx.sonarPath": {
            en: "Message Path",
            it: "Path del messaggio"
        },
        "idx.sonarPathGuide": {
            en: "Select a value in the \"Received\" column of the Messages table to see on the map the path followed by that message.",
            it: "Seleziona un valore nella colonna \"Ricevuto\" della tabella Messaggi per vedere sulla mappa il path seguito da quel messaggio."
        },
        "idx.sonarDetailMessages": {
            en: "Messages",
            it: "Messaggi"
        },

        // ---- index.html: pagina Repeaters ----
        "idx.statusH": {
            en: "Status",
            it: "Stato"
        },
        "idx.telemetryH": {
            en: "Telemetry",
            it: "Telemetria"
        },
        "idx.configH": {
            en: "Config",
            it: "Configurazione"
        },
        "idx.regionH": {
            en: "Region",
            it: "Regione"
        },
        "idx.neighboursH": {
            en: "Neighbours",
            it: "Vicini"
        },

        // ---- index.html: scheda Analysis (testi statici) ----
        "an.selectorLabel": {
            en: "Analysis:",
            it: "Analisi:"
        },
        "an.collectorNote": {
            en: "<b>All nodes configured on this collector.</b> This analysis combines the data of every node and does not depend on a single one, so the <b>Node</b> selector is not shown on this tab.",
            it: "<b>Tutti i nodi configurati su questo collettore.</b> Questa analisi combina i dati di ogni nodo e non dipende da uno solo, quindi il selettore <b>Nodo</b> non è mostrato in questa scheda."
        },
        "an.intro": {
            en: "Compares the path taken by <b>adverts</b> (repeater flood, all nodes) with the path taken by <b>Sonar messages</b> (a message sent on purpose from a known node, so its source and send time are known). Both are read from the paths recorded by the tracers. Source and tracer are two roles, not two kinds of node: the source is the node that transmits a packet, the tracer is another trace-mon node that receives it and records its path. The same trace-mon node is the source of the packets it transmits and the tracer of those it receives. The aim is to see how far each kind of packet really travels, and which repeaters are seen forwarding at depth. It is an inference from recorded paths, not a measurement of any repeater's settings. The only settings known are the flood limits of the repeaters managed by trace-mon (panel 6).",
            it: "Confronta il path seguito dagli <b>advert</b> (flood dei repeater, tutti i nodi) con il path seguito dai <b>messaggi Sonar</b> (un messaggio inviato di proposito da un nodo noto, quindi con origine e ora di invio conosciute). Entrambi sono letti dai path registrati dai tracciatori. Sorgente e tracciatore sono due ruoli, non due tipi di nodo: la sorgente è il nodo che trasmette un pacchetto, il tracciatore è un altro nodo trace-mon che lo riceve e ne registra il path. Lo stesso nodo trace-mon è sorgente dei pacchetti che trasmette e tracciatore di quelli che riceve. Lo scopo è vedere fin dove arriva davvero ogni tipo di pacchetto e quali repeater risultano ritrasmettere lontano dalla sorgente. È un'inferenza dai path registrati, non una misura delle impostazioni di un repeater. Le uniche impostazioni note sono i limiti di flood dei repeater gestiti da trace-mon (pannello 6)."
        },
        "an.h1": {
            en: "1. Data status",
            it: "1. Stato dei dati"
        },
        "an.h2": {
            en: "2. Source &rarr; tracer matrix",
            it: "2. Matrice sorgente &rarr; tracciatore"
        },
        "an.help2": {
            en: "One cell per pair: how many Sonar messages sent by the source reached the tracer, and how many adverts of the same source it saw. Click a cell to compare that pair in panel 4.",
            it: "Una cella per coppia: quanti messaggi Sonar inviati dalla sorgente sono arrivati al tracciatore e quanti advert della stessa sorgente ha visto. Clicca una cella per confrontare quella coppia nel pannello 4."
        },
        "an.h3": {
            en: "3. Hops histogram",
            it: "3. Istogramma degli hop"
        },
        "an.lblTracer": {
            en: "Tracer",
            it: "Tracciatore"
        },
        "an.lblScope": {
            en: "Scope",
            it: "Ambito"
        },
        "an.optBoth": {
            en: "Both",
            it: "Entrambi"
        },
        "an.optNoRegion": {
            en: "No region (FLOOD)",
            it: "Senza regione (FLOOD)"
        },
        "an.optRegion": {
            en: "Region (TC_FLOOD)",
            it: "Con regione (TC_FLOOD)"
        },
        "an.lblCount": {
            en: "Count",
            it: "Conteggio"
        },
        "an.optCopies": {
            en: "All copies received",
            it: "Tutte le copie ricevute"
        },
        "an.optBest": {
            en: "Best copy of each transmission",
            it: "Copia migliore di ogni trasmissione"
        },
        "an.lblYAxis": {
            en: "Y axis",
            it: "Asse Y"
        },
        "an.optShare": {
            en: "Share of each series",
            it: "Quota di ogni serie"
        },
        "an.optNumber": {
            en: "Number",
            it: "Numero"
        },
        "an.h4": {
            en: "4. Pair comparison",
            it: "4. Confronto della coppia"
        },
        "an.lblSource": {
            en: "Source",
            it: "Sorgente"
        },
        "an.hAdvertPaths": {
            en: "Advert paths",
            it: "Path degli advert"
        },
        "an.hSonarPaths": {
            en: "Sonar paths",
            it: "Path Sonar"
        },
        "an.btnClearMap": {
            en: "Clear map",
            it: "Cancella mappa"
        },
        "an.h5": {
            en: "5. Repeaters seen at depth",
            it: "5. Repeater visti lontano dalla sorgente"
        },
        "an.help5": {
            en: "Repeaters seen forwarding at position 9 or beyond in the recorded paths. The last hop, next to the tracer, is not counted. The list is descriptive: it does not classify any repeater's limit. The last two columns add what is known about the advert limit (panel 6).",
            it: "Repeater visti ritrasmettere alla posizione 9 o oltre nei path registrati. L'ultimo hop, accanto al tracciatore, non viene contato. L'elenco è descrittivo: non classifica il limite di nessun repeater. Le ultime due colonne aggiungono ciò che si sa sul limite degli advert (pannello 6)."
        },
        "an.lblStatus": {
            en: "Status",
            it: "Stato"
        },
        "an.optProven": {
            en: "Proven ≥ 9 hops",
            it: "Provato ≥ 9 hop"
        },
        "an.optIndication": {
            en: "Indication",
            it: "Indicazione"
        },
        "an.optSonarOnly": {
            en: "Sonar only",
            it: "Solo Sonar"
        },
        "an.lblNameKey": {
            en: "Name / key",
            it: "Nome / chiave"
        },
        "an.h6": {
            en: "6. Operating limits",
            it: "6. Limiti operativi"
        },
        "an.help6": {
            en: "A repeater forwards a flooded packet only up to a number of hops, set by three settings: <b>Flood Max Hops (Unscoped)</b>, <b>Flood Max Hops (Advert)</b> and <b>Flood Max Hops</b>. trace-mon reads them only from the repeaters it manages; for every other repeater on a path they are not known, and only the highest position at which it was seen forwarding is. The effective cap used here is a working hypothesis: advert without region = min(Unscoped, Advert), advert with region = Advert, message without region = min(Unscoped, Flood Max Hops), message with region = Flood Max Hops. A repeater at position <i>k</i> of a path can appear only if <i>k</i> is within its cap. In panels 3, 4 and 5, &ldquo;would stop&rdquo; and &ldquo;not stopped&rdquo; say whether the other kind of packet, with the same scope, could have followed the same path, judged only on the settings known: it describes a path, it does not classify a repeater.",
            it: "Un repeater ritrasmette un pacchetto in flood solo fino a un certo numero di hop, stabilito da tre impostazioni: <b>Flood Max Hops (Unscoped)</b>, <b>Flood Max Hops (Advert)</b> e <b>Flood Max Hops</b>. trace-mon le legge solo dai repeater che gestisce; per ogni altro repeater di un path non sono note e si conosce solo la posizione più alta alla quale è stato visto ritrasmettere. Il limite effettivo usato qui è un'ipotesi di lavoro: advert senza regione = min(Unscoped, Advert), advert con regione = Advert, messaggio senza regione = min(Unscoped, Flood Max Hops), messaggio con regione = Flood Max Hops. Un repeater alla posizione <i>k</i> di un path può comparire solo se <i>k</i> rientra nel suo limite. Nei pannelli 3, 4 e 5, &ldquo;si fermerebbe&rdquo; e &ldquo;non bloccato&rdquo; indicano se l'altro tipo di pacchetto, con lo stesso ambito, avrebbe potuto seguire lo stesso path, giudicando solo in base alle impostazioni note: descrive un path, non classifica un repeater."
        },
        "an.hSettings": {
            en: "Settings of the repeaters managed by trace-mon",
            it: "Impostazioni dei repeater gestiti da trace-mon"
        },
        "an.helpSettings": {
            en: "The list of repeaters is not fixed: each manager of trace-mon can add or remove repeaters, and a node may start without any and get one later. The table follows the period selected above: it shows the settings in force at the <b>end</b> of the period, only for the repeaters whose settings are known in it. A repeater added during the period is marked <i>added in this period</i>; one that stopped being read, <i>no longer read</i>. The readings are kept even after a repeater is removed from the configuration, so it still counts for the periods in which it was read.",
            it: "L'elenco dei repeater non è fisso: ogni gestore di trace-mon può aggiungere o rimuovere repeater, e un nodo può partire senza e averne uno in seguito. La tabella segue il periodo selezionato sopra: mostra le impostazioni in vigore alla <b>fine</b> del periodo, solo per i repeater le cui impostazioni sono note in quel periodo. Un repeater aggiunto durante il periodo è indicato come <i>aggiunto in questo periodo</i>; uno che ha smesso di essere letto, come <i>non più letto</i>. Le letture si conservano anche dopo che un repeater è stato rimosso dalla configurazione, quindi continua a contare per i periodi in cui è stato letto."
        },
        "an.hSources": {
            en: "Where the settings come from",
            it: "Da dove vengono le impostazioni"
        },
        "an.helpSources": {
            en: "Each node reads the settings of its own repeaters, but a repeater of one node also affects the packets seen at every other node, so the readings of all nodes are combined. A node with no managed repeater adds nothing: it is normal until one is added.",
            it: "Ogni nodo legge le impostazioni dei propri repeater, ma un repeater di un nodo influisce anche sui pacchetti visti da tutti gli altri nodi, quindi le letture di tutti i nodi vengono combinate. Un nodo senza repeater gestiti non aggiunge nulla: è normale finché non ne viene aggiunto uno."
        },
        "an.hGateways": {
            en: "Gateway ceiling at each tracer",
            it: "Limite del gateway presso ogni tracciatore"
        },
        "an.helpGateways": {
            en: "The gateway is the last repeater before the tracer. A copy cannot have more hops than its gateway's cap, so where the gateways are capped low the tracer cannot see deep paths of that kind, whatever the repeaters in the middle do. Counted over all copies of the period, from any source.",
            it: "Il gateway è l'ultimo repeater prima del tracciatore. Una copia non può avere più hop del limite del suo gateway, quindi dove i gateway hanno un limite basso il tracciatore non può vedere path lunghi di quel tipo, qualunque cosa facciano i repeater intermedi. Conteggiato su tutte le copie del periodo, da qualsiasi sorgente."
        },

        // ---- app.js: elementi comuni ----
        "common.monthNames": {
            en: "January,February,March,April,May,June,July,August,September,October,November,December",
            it: "Gennaio,Febbraio,Marzo,Aprile,Maggio,Giugno,Luglio,Agosto,Settembre,Ottobre,Novembre,Dicembre"
        },
        "common.errorLoadingData": {
            en: "Error loading data.",
            it: "Errore nel caricamento dei dati."
        },
        "common.ambiguous": {
            en: "Ambiguous",
            it: "Ambiguo"
        },
        "common.unknown": {
            en: "Unknown",
            it: "Sconosciuto"
        },
        "common.srcPositionNoGps": {
            en: "Position of the local node (SRC) not available: the connected Companion has not yet provided GPS coordinates.",
            it: "Posizione del nodo locale (SRC) non disponibile: il Companion collegato non ha ancora fornito coordinate GPS."
        },

        // ---- app.js: scheda Trace ----
        "trace.colTimestamp": {
            en: "timestamp",
            it: "Data e ora"
        },
        "trace.colStatus": {
            en: "status",
            it: "Stato"
        },
        "trace.noData": {
            en: "No trace data available for this path.",
            it: "Nessun dato di traccia disponibile per questo path."
        },
        "trace.statsPathElement": {
            en: "Path Element",
            it: "Elemento del path"
        },
        "trace.noStats": {
            en: "No stats data available.",
            it: "Nessun dato statistico disponibile."
        },
        "trace.pathInfoTitle": {
            en: "Info Path",
            it: "Info Path"
        },
        "trace.pathInfoText": {
            en: "These are the repeaters analysed with this trace:",
            it: "Questi sono i repeater analizzati con questa traccia:"
        },
        "trace.showingObservations.one": {
            en: "Showing {n} observations",
            it: "Mostrata {n} osservazione"
        },
        "trace.showingObservations.other": {
            en: "Showing {n} observations",
            it: "Mostrate {n} osservazioni"
        },
        "trace.srcPositionUnavailable": {
            en: "Position of the local node (SRC) not available: {reason}.",
            it: "Posizione del nodo locale (SRC) non disponibile: {reason}."
        },
        "trace.srcPositionReadError": {
            en: "Unable to read the position of the local node (SRC) from /api/device_status.",
            it: "Impossibile leggere la posizione del nodo locale (SRC) da /api/device_status."
        },
        "trace.nodePositionUnusable": {
            en: "Position of {name} ({id}) not available: {reason}.",
            it: "Posizione di {name} ({id}) non disponibile: {reason}."
        },
        "trace.nodePositionMissing": {
            en: "Position of {name} ({id}) not available in contacts.db.",
            it: "Posizione di {name} ({id}) non disponibile in contacts.db."
        },
        "trace.prefixAmbiguous": {
            en: "Prefix \"{id}\" is ambiguous: several nodes match, unable to determine which one to show.",
            it: "Prefisso \"{id}\" ambiguo: più nodi corrispondono, impossibile determinare quale mostrare."
        },
        "trace.nodeNotFound": {
            en: "Node {id} not found in contacts.db.",
            it: "Nodo {id} non trovato in contacts.db."
        },
        "trace.timeoutNotice": {
            en: "This trace ended in TIMEOUT: the path drawn is the CONFIGURED one, not necessarily the one actually followed by the packets (see trace.sh).",
            it: "Questa traccia è andata in TIMEOUT: il path disegnato è quello CONFIGURATO, non necessariamente quello realmente seguito dai pacchetti (v. trace.sh)."
        },
        "trace.noMapPositions": {
            en: "No resolvable position for this trace: unable to show the map.",
            it: "Nessuna posizione risolvibile per questa traccia: impossibile mostrare la mappa."
        },
        "trace.srcPositionNoGpsCollector": {
            en: "Position of the local node (SRC) not available: the Companion connected to this node has not yet provided GPS coordinates.",
            it: "Posizione del nodo locale (SRC) non disponibile: il Companion collegato a questo nodo non ha ancora fornito coordinate GPS."
        },

        // ---- app.js: formattatori comuni (valori nelle celle) ----
        "common.na": {
            en: "n/a",
            it: "n/d"
        },
        "common.never": {
            en: "never",
            it: "mai"
        },
        "common.unknownParen": {
            en: "(unknown)",
            it: "(sconosciuto)"
        },
        "common.inSync": {
            en: "in sync",
            it: "sincronizzato"
        },
        "common.agoSeconds": {
            en: "{n}s ago",
            it: "{n}s fa"
        },
        "common.agoMinutes": {
            en: "{n}m ago",
            it: "{n}m fa"
        },
        "common.agoHours": {
            en: "{h}h {m}m ago",
            it: "{h}h {m}m fa"
        },
        "common.agoDays": {
            en: "{n}d ago",
            it: "{n}d fa"
        },

        // ---- app.js: scheda Nodes ----
        "nodes.typeUnknown": {
            en: "unknown ({t})",
            it: "sconosciuto ({t})"
        },
        "nodes.notObserved": {
            en: "not observed",
            it: "non osservato"
        },
        "nodes.hopCountMaxHint": {
            en: "With \"Path length\" set to {length} byte, the maximum possible hop count is {max} (firmware path buffer: {buffer} byte).",
            it: "Con \"Lunghezza path\" su {length} byte, il numero massimo di hop possibile è {max} (buffer path del firmware: {buffer} byte)."
        },
        "nodes.liveOnlyNotObserved": {
            en: "Available only for the Live period: an archived month lists only the nodes actually observed in that month.",
            it: "Disponibile solo per il periodo In tempo reale: un mese archiviato elenca solo i nodi effettivamente osservati in quel mese."
        },
        "nodes.liveOnlyFutureAdvert": {
            en: "Available only for the Live period: it compares the Advert Time with the current clock, which makes no sense on an archived month.",
            it: "Disponibile solo per il periodo In tempo reale: confronta l'Ora Advert con l'orologio di adesso, non ha senso su un mese archiviato."
        },
        "nodes.deviceStatusError": {
            en: "Error loading device status.",
            it: "Errore nel caricamento dello stato del device."
        },
        "nodes.deviceStatusNone": {
            en: "No device status data available.",
            it: "Nessun dato sullo stato del device disponibile."
        },
        "nodes.connConnected": {
            en: "Connected",
            it: "Connesso"
        },
        "nodes.connDisconnected": {
            en: "Disconnected",
            it: "Disconnesso"
        },
        "nodes.connUnknown": {
            en: "Unknown",
            it: "Sconosciuto"
        },
        "nodes.connTipConnected": {
            en: "The Companion is connected to trace-mon. Last check: {checked}.",
            it: "Il Companion è connesso a trace-mon. Ultimo controllo: {checked}."
        },
        "nodes.connTipDisconnected": {
            en: "The Companion is not connected to trace-mon (since {since}). Last check: {checked}.",
            it: "Il Companion non è connesso a trace-mon (dal {since}). Ultimo controllo: {checked}."
        },
        "nodes.connTipUnknown": {
            en: "Status not up to date: the last check was on {checked}. The daemon may be stopped, or recent data may be missing.",
            it: "Stato non aggiornato: l'ultimo controllo risale al {checked}. Il daemon potrebbe essere fermo, oppure potrebbero mancare dati recenti."
        },
        "nodes.heading": {
            en: "Known Nodes - {total} ({chat} chat | {repeaters} repeaters | {rooms} room server)",
            it: "Nodi conosciuti - {total} ({chat} chat | {repeaters} repeater | {rooms} room server)"
        },
        "nodes.colName": {
            en: "Name",
            it: "Nome"
        },
        "nodes.colType": {
            en: "Type",
            it: "Tipo"
        },
        "nodes.colAdvertTime": {
            en: "Advert Time",
            it: "Ora Advert"
        },
        "nodes.noData": {
            en: "No nodes data available.",
            it: "Nessun dato sui nodi disponibile."
        },
        "nodes.noMatch": {
            en: "No nodes match the current filters.",
            it: "Nessun nodo corrisponde ai filtri attuali."
        },
        "tip.telDefault": {
            en: "Telemetry reading from the local companion device on the indicated channel. The value is shown as reported by the device, without a unit of measurement if unknown.",
            it: "Misura di telemetria del device companion locale sul canale indicato. Il valore è mostrato come riportato dal device, senza unità di misura se non nota."
        },
        "tip.telVoltage": {
            en: "Voltage measured on the indicated telemetry channel, in Volts. It may coincide with the battery voltage shown above.",
            it: "Tensione misurata sul canale di telemetria indicato, in Volt. Può coincidere con la tensione di batteria mostrata sopra."
        },
        "tip.telTemperature": {
            en: "Temperature measured on the indicated telemetry channel, in °C.",
            it: "Temperatura misurata sul canale di telemetria indicato, in °C."
        },

        // ---- app.js: elementi comuni (valori di errore, coordinate) ----
        "common.loading": {
            en: "Loading...",
            it: "Caricamento..."
        },
        "common.srcLocalNode": {
            en: "SRC (local node)",
            it: "SRC (nodo locale)"
        },
        "common.coordNoGps": {
            en: "coordinates 0,0 (node without GPS)",
            it: "coordinate 0,0 (nodo senza GPS)"
        },
        "common.coordInvalid": {
            en: "invalid coordinates ({lat}, {lon})",
            it: "coordinate non valide ({lat}, {lon})"
        },

        // ---- app.js: dettaglio nodo ----
        "ndet.errorNode": {
            en: "Error loading node.",
            it: "Errore nel caricamento del nodo."
        },
        "ndet.errorArchive": {
            en: "Error loading archive.",
            it: "Errore nel caricamento dell'archivio."
        },
        "ndet.infoType": {
            en: "Type",
            it: "Tipo"
        },
        "ndet.infoPublicKey": {
            en: "Public Key",
            it: "Chiave pubblica"
        },
        "ndet.infoPosition": {
            en: "Position",
            it: "Posizione"
        },
        "ndet.infoLastActivity": {
            en: "Last Activity",
            it: "Ultima attività"
        },
        "ndet.infoTotalObservations": {
            en: "Total Observations",
            it: "Osservazioni totali"
        },
        "ndet.noObservations": {
            en: "No observations recorded.",
            it: "Nessuna osservazione registrata."
        },
        "ndet.colReceived": {
            en: "Received",
            it: "Ricevuto"
        },
        "ndet.colHops": {
            en: "Hops",
            it: "Hop"
        },

        // ---- app.js: mappa dei path degli Advert (dettaglio nodo) ----
        "pmap.positionUnavailable": {
            en: "Not available: {reason}",
            it: "Non disponibile: {reason}"
        },
        "pmap.stepOrigin": {
            en: "Origin",
            it: "Origine"
        },
        "pmap.noPositionOrigin": {
            en: "position not known in contacts.db",
            it: "posizione non nota in contacts.db"
        },
        "pmap.stepIntermediateHops": {
            en: "Intermediate hops ({n})",
            it: "Hop intermedi ({n})"
        },
        "pmap.reasonPathHexMissing": {
            en: "path_hex not recorded: the intermediate hops are not known",
            it: "path_hex non registrato: gli hop intermedi non sono noti"
        },
        "pmap.noteInconsistent": {
            en: "hop_count ({hopCount}) is inconsistent with path_hex ({elements} elements): the path may be incomplete.",
            it: "hop_count ({hopCount}) non coerente con path_hex ({elements} elementi): il path potrebbe essere incompleto."
        },
        "pmap.noPositionHop": {
            en: "no GPS position known in contacts.db",
            it: "nessuna posizione GPS nota in contacts.db"
        },
        "pmap.reasonAmbiguousHash": {
            en: "ambiguous hash: more than one repeater starts with this prefix",
            it: "hash ambiguo: più repeater iniziano con questo prefisso"
        },
        "pmap.reasonUnknownHash": {
            en: "no known repeater with this hash in contacts.db",
            it: "nessun repeater noto con questo hash in contacts.db"
        },
        "pmap.reasonSrcUnreadable": {
            en: "position not readable from /api/device_status",
            it: "posizione non leggibile da /api/device_status"
        },
        "pmap.noPositionSrc": {
            en: "the Companion has not yet provided GPS coordinates",
            it: "il Companion non ha ancora fornito coordinate GPS"
        },
        "pmap.missingTitle": {
            en: "Path points not shown: {n} of {total}",
            it: "Punti del path non mostrati: {n} su {total}"
        },
        "pmap.missingSub": {
            en: "because of missing or duplicate data",
            it: "per mancanza di dati o dati duplicati"
        },
        "pmap.kindDuplicate": {
            en: "duplicate data",
            it: "dato duplicato"
        },
        "pmap.kindMissing": {
            en: "missing data",
            it: "dato mancante"
        },
        "pmap.legendBridged": {
            en: "amber dashes: link that skips one or more points not shown",
            it: "tratteggio ambra: collegamento che salta uno o più punti non mostrati"
        },

        // ---- app.js: mappa dei path degli Advert (marker, didascalia, tooltip) ----
        "pmap.markerOrigin": {
            en: "{name} (origin)",
            it: "{name} (origine)"
        },
        "pmap.caption": {
            en: "Advert received on {time} — {hops} — points on the map: {shown} of {total}",
            it: "Advert ricevuto il {time} — {hops} — punti sulla mappa: {shown} su {total}"
        },
        "pmap.bridgedTooltip": {
            en: "Link that skips one or more points not shown (missing or duplicate data)",
            it: "Collegamento che salta uno o più punti non mostrati (dati mancanti o duplicati)"
        },

        // ---- app.js: elenco dei messaggi Sonar per mittente (pagina Nodes), dettaglio del mittente e mappa del path ----
        "sonar.heading.one": {
            en: "Sonar Messages - {n} sender",
            it: "Messaggi Sonar - {n} mittente"
        },
        "sonar.heading.other": {
            en: "Sonar Messages - {n} senders",
            it: "Messaggi Sonar - {n} mittenti"
        },
        "sonar.headingFiltered.one": {
            en: "Sonar Messages - {shown} of {n} sender",
            it: "Messaggi Sonar - {shown} su {n} mittente"
        },
        "sonar.headingFiltered.other": {
            en: "Sonar Messages - {shown} of {n} senders",
            it: "Messaggi Sonar - {shown} su {n} mittenti"
        },
        "sonar.colSender": {
            en: "Sender",
            it: "Mittente"
        },
        "sonar.colMsg": {
            en: "Msg",
            it: "Msg"
        },
        "sonar.infoLastMessage": {
            en: "Last Message",
            it: "Ultimo messaggio"
        },
        "sonar.infoReceptions": {
            en: "Total Receptions",
            it: "Ricezioni totali"
        },
        "sonar.senderAmbiguous": {
            en: "(ambiguous)",
            it: "(ambiguo)"
        },
        "sonar.pathUnknown": {
            en: "{n} hop (path not recorded)",
            it: "{n} hop (path non registrato)"
        },
        "sonar.noMessages": {
            en: "No Sonar messages received.",
            it: "Nessun messaggio Sonar ricevuto."
        },
        "sonar.noArchive": {
            en: "No Sonar messages archived for the selected period.",
            it: "Nessun messaggio Sonar archiviato per il periodo selezionato."
        },
        "sonar.noMatch": {
            en: "No messages from trace-mon nodes.",
            it: "Nessun messaggio da nodi trace-mon."
        },
        "smap.stepSender": {
            en: "Sender",
            it: "Mittente"
        },
        "smap.reasonSenderUnknown": {
            en: "unknown sender: no known node starts with prefix {prefix}",
            it: "mittente sconosciuto: nessun nodo conosciuto inizia con il prefisso {prefix}"
        },
        "smap.reasonSenderAmbiguous": {
            en: "ambiguous sender: {n} known nodes start with prefix {prefix}",
            it: "mittente ambiguo: {n} nodi conosciuti iniziano con il prefisso {prefix}"
        },
        "smap.markerSender": {
            en: "{name} (sender)",
            it: "{name} (mittente)"
        },
        "smap.caption": {
            en: "Sonar message received on {time} — {hops} — points on the map: {shown} of {total}",
            it: "Messaggio Sonar ricevuto il {time} — {hops} — punti sulla mappa: {shown} su {total}"
        },

        // ---- tooltip delle righe di Device Status, Telemetry, Status e Config (header non tradotti) ----
        "tip.updated": {
            en: "Time elapsed since the last update of the local companion data shown in this table (read by trace-mon at intervals, not in real time).",
            it: "Tempo trascorso dall'ultimo aggiornamento dei dati del companion locale mostrati in questa tabella (letti a intervalli da trace-mon, non in tempo reale)."
        },
        "tip.battery": {
            en: "Battery voltage, reported by the device in millivolts and converted here to Volts.",
            it: "Tensione della batteria, riportata dal device in millivolt e convertita qui in Volt."
        },
        "tip.uptime": {
            en: "Time elapsed since the device last started, in days/hours/minutes format.",
            it: "Tempo trascorso dall'ultimo avvio del device, nel formato giorni/ore/minuti."
        },
        "tip.noiseFloor": {
            en: "Noise floor of the radio channel measured by the chip, in dBm. More negative values mean a quieter channel; a persistent rise signals interference or a crowded channel.",
            it: "Rumore di fondo del canale radio misurato dal chip, in dBm. Valori più negativi indicano un canale più silenzioso; un innalzamento persistente segnala interferenze o canale affollato."
        },
        "tip.lastRssi": {
            en: "Signal strength (RSSI, in dBm) of the last packet received. Closer to 0 = stronger signal.",
            it: "Potenza del segnale (RSSI, in dBm) dell'ultimo pacchetto ricevuto. Più vicino a 0 = segnale più forte."
        },
        "tip.lastSnr": {
            en: "Signal-to-noise ratio (SNR, in dB) of the last packet received: how far the useful signal stands out above the noise floor. Higher values mean cleaner reception.",
            it: "Rapporto segnale/rumore (SNR, in dB) dell'ultimo pacchetto ricevuto: quanto il segnale utile emerge sul rumore di fondo. Valori più alti indicano una ricezione più pulita."
        },
        "tip.txQueue": {
            en: "Number of packets currently queued waiting to be transmitted, out of the total queue available. A frequently full queue means the radio channel cannot clear the traffic as fast as it is generated.",
            it: "Numero di pacchetti attualmente in coda in attesa di trasmissione, sul totale della coda disponibile. Una coda spesso piena indica che il canale radio non riesce a smaltire il traffico alla velocità con cui viene generato."
        },
        "tip.errorFlags": {
            en: "Bitmask of low-level radio dispatcher events (e.g. queue full, CAD timeout, receive-start timeout) — NOT a packet count, nor the same data as \"Receive Errors (CRC Fail)\" below despite the similar name.",
            it: "Bitmask di eventi del dispatcher radio a basso livello (es. coda piena, timeout CAD, timeout di avvio ricezione) — NON un conteggio di pacchetti, né lo stesso dato di \"Receive Errors (CRC Fail)\" qui sotto nonostante il nome simile."
        },
        "tip.packetsReceived": {
            en: "Total packets received since boot that passed the CRC check and reached the mesh layer (sum of flood + direct).",
            it: "Totale dei pacchetti ricevuti dal boot che hanno superato il controllo CRC e sono arrivati al livello mesh (somma di flood + direct)."
        },
        "tip.packetsSent": {
            en: "Total packets transmitted since boot (sum of flood + direct).",
            it: "Totale dei pacchetti trasmessi dal boot (somma di flood + direct)."
        },
        "tip.sent": {
            en: "Packets transmitted, split by routing mode: flood (rebroadcast by every node that hears them) or direct (routed along a specific path).",
            it: "Pacchetti trasmessi suddivisi per modalità di instradamento: in flood (rilanciati da tutti i nodi che li sentono) o diretti (instradati lungo un path specifico)."
        },
        "tip.received": {
            en: "Packets received, split by the routing mode they arrived with: flood or direct.",
            it: "Pacchetti ricevuti suddivisi per la modalità di instradamento con cui sono arrivati: flood o diretti."
        },
        "tip.receiveErrors": {
            en: "Packets physically received by the radio chip (valid preamble/sync/header) whose payload failed the CRC check on read. It does not only indicate collisions: weak signal, interference or a truncated packet have the same effect.",
            it: "Pacchetti fisicamente ricevuti dal chip radio (preambolo/sync/header validi) il cui payload però ha fallito il controllo CRC in lettura. Non indica solo collisioni: anche segnale debole, interferenze o un pacchetto troncato producono lo stesso effetto."
        },
        "tip.crcErrorRate": {
            en: "Percentage of physically received packets lost to CRC errors: Receive Errors / (Packets Received + Receive Errors) × 100. Shows n/a if no packet was physically received.",
            it: "Percentuale di pacchetti fisicamente ricevuti persi per errore CRC: Receive Errors / (Packets Received + Receive Errors) × 100. Mostra n/d se non è stato fisicamente ricevuto alcun pacchetto."
        },
        "tip.airtime": {
            en: "Cumulative time since startup spent transmitting and receiving actual packets respectively (not the total time the radio has been on).",
            it: "Tempo cumulativo, dall'avvio, passato rispettivamente a trasmettere e a ricevere pacchetti effettivi (non il tempo totale con la radio accesa)."
        },
        "tip.airtimePercent": {
            en: "Percentage of uptime during which the channel was occupied by traffic, our own in TX plus that of other nodes detected in RX: (Airtime TX + Airtime RX) / Uptime × 100. Shows how congested the mesh is in the surroundings, not compliance with a regulatory limit.",
            it: "Percentuale di uptime in cui il canale è stato occupato da traffico, proprio in TX più altrui rilevato in RX: (Airtime TX + Airtime RX) / Uptime × 100. Indica quanto è congestionata la mesh nei dintorni, non il rispetto di un limite normativo."
        },
        "tip.txDutyCycle": {
            en: "Percentage of uptime spent transmitting: Airtime TX / Uptime × 100. TX only: directly comparable with \"Duty Cycle\" in the Config table of Repeaters (also TX only) to see how close it gets to the configured limit.",
            it: "Percentuale di uptime passata in trasmissione: Airtime TX / Uptime × 100. Solo TX: confrontabile direttamente con \"Duty Cycle\" nella tabella Configurazione dei Repeater (anch'esso solo TX) per vedere quanto ci si avvicina al limite impostato."
        },
        "tip.firmwareVersion": {
            en: "Version and build of the firmware running on the companion device connected locally to trace-mon, reported by a direct query to the device (not a CLI command as for Repeaters).",
            it: "Versione e build del firmware in esecuzione sul device companion collegato localmente a trace-mon, riportata da una query diretta al device (non un comando CLI come per i Repeater)."
        },
        "tip.hardware": {
            en: "Hardware model of the companion device connected locally to trace-mon (e.g. the board the firmware runs on), reported by a direct query to the device.",
            it: "Modello hardware del device companion collegato localmente a trace-mon (es. la scheda su cui gira il firmware), riportato da una query diretta al device."
        },
        "tip.radioSettings": {
            en: "LoRa radio configuration parameters: Freq = operating frequency (MHz), SF = Spreading Factor, BW = bandwidth (kHz), CR = Coding Rate. Together they set the trade-off between range, data rate and noise resistance. CR is shown in RAW RadioLib convention (5-8): the actual value of the standard formula is raw-4 (e.g. CR=8 raw → 4/8).",
            it: "Parametri di configurazione radio LoRa: Freq = frequenza operativa (MHz), SF = Spreading Factor, BW = larghezza di banda (kHz), CR = Coding Rate. Insieme determinano il compromesso tra portata, velocità di trasmissione e resistenza al rumore. CR mostrato in convenzione RAW RadioLib (5-8): il valore effettivo della formula standard è raw-4 (es. CR=8 raw → 4/8)."
        },
        "tip.telemetry": {
            en: "Telemetry readings (voltage, temperature, etc.) from the local companion device, one row per reading. n/a if the device reported none.",
            it: "Misure di telemetria (tensione, temperatura, ecc.) del device companion locale, una riga per misura. n/d se il device non ne ha riportate."
        },
        "tip.clockSkew": {
            en: "Difference between the clock reported by the repeater and that of this host, in seconds. Positive = repeater clock ahead. A skew of days typically means a repeater without an external RTC that was never resynchronised.",
            it: "Differenza tra l'orologio dichiarato dal repeater e quello di questo host, in secondi. Positivo = orologio del repeater avanti. Uno scarto di giorni segnala tipicamente un repeater senza RTC esterno mai risincronizzato."
        },
        "tip.queriedAt": {
            en: "Date and time of the last successful query to this repeater. Failed requests (timeout, missing or removed ACL permission) do not produce a new row: the last available data always stays visible here, with its age.",
            it: "Data e ora dell'ultima interrogazione riuscita a questo repeater. Le richieste con esito negativo (timeout, permesso ACL mancante o rimosso) non producono una nuova riga: qui resta sempre visibile l'ultimo dato disponibile, con la sua età."
        },
        "tip.txQueueLength": {
            en: "Number of packets currently queued on the repeater waiting to be transmitted. A frequently full queue means the radio channel cannot clear the traffic as fast as it is generated.",
            it: "Numero di pacchetti attualmente in coda sul repeater in attesa di trasmissione. Una coda spesso piena indica che il canale radio non riesce a smaltire il traffico alla velocità con cui viene generato."
        },
        "tip.duplicates": {
            en: "Packets received CORRECTLY (valid CRC) but already seen before — mesh-level deduplication, not a radio error. Mutually exclusive with \"Receive Errors (CRC Fail)\": a packet either fails the CRC (and can never count as a duplicate) or passes it (and may be new or a duplicate).",
            it: "Pacchetti ricevuti CORRETTAMENTE (CRC valido) ma già visti in precedenza — deduplica a livello mesh, non un errore radio. Mutuamente esclusivo da \"Receive Errors (CRC Fail)\": un pacchetto o fallisce il CRC (non può mai risultare duplicato) o lo supera (dove può risultare nuovo o duplicato)."
        },
        "tip.fullEvents": {
            en: "Number of times the repeater's transmit queue was full and a packet could not be queued — an indicator of saturation under load.",
            it: "Numero di volte in cui la coda di trasmissione del repeater era piena e un pacchetto non ha potuto essere accodato — indicatore di saturazione sotto carico."
        },
        "tip.cfgFirmwareVersion": {
            en: "Version and build of the firmware running on the repeater, reported by the CLI command \"ver\" (requires login with admin permission in the ACL).",
            it: "Versione e build del firmware in esecuzione sul repeater, riportata dal comando CLI \"ver\" (richiede login con permesso admin nell'ACL)."
        },
        "tip.cfgHardware": {
            en: "Name/model of the repeater hardware (e.g. the board or module the firmware runs on), reported by the CLI command \"board\" (requires login with admin permission in the ACL).",
            it: "Nome/modello dell'hardware del repeater (es. la scheda o il modulo su cui gira il firmware), riportato dal comando CLI \"board\" (richiede login con permesso admin nell'ACL)."
        },
        "tip.cfgPathHashMode": {
            en: "Size in bytes of the hash used to identify flood packets (0 = 1 byte/256 unique IDs, 1 = 2 bytes/65,536 IDs, 2 = 3 bytes). A shorter hash weighs less in the packet but exhausts the unique ID space sooner on networks with a lot of flood traffic.",
            it: "Dimensione in byte dell'hash usato per identificare i pacchetti in flood (0 = 1 byte/256 ID unici, 1 = 2 byte/65.536 ID, 2 = 3 byte). Un hash più corto pesa meno nel pacchetto ma satura prima lo spazio di ID unici su reti con molto traffico flood."
        },
        "tip.cfgTxDelayFlood": {
            en: "Factor that scales the random delay before retransmitting a flood packet: when several nearby repeaters hear the same packet, each waits a random time before rebroadcasting it, to avoid all of them retransmitting together and colliding. 0 disables the delay.",
            it: "Fattore che scala il ritardo casuale prima di ritrasmettere un pacchetto flood: quando più repeater vicini sentono lo stesso pacchetto, ciascuno attende un tempo casuale prima di rilanciarlo, per evitare che ritrasmettano tutti insieme collidendo. 0 disabilita il ritardo."
        },
        "tip.cfgTxDelayDirect": {
            en: "Like \"TX Delay (Flood)\" but for packets routed directly towards a specific hop: typically a lower value because fewer nodes compete to retransmit the same packet.",
            it: "Come \"TX Delay (Flood)\" ma per i pacchetti instradati direttamente verso un hop specifico: valore tipicamente più basso perché meno nodi competono per ritrasmettere lo stesso pacchetto."
        },
        "tip.cfgRxDelay": {
            en: "Experimental feature: flood packets received with a weak signal are briefly held in a delay queue, giving priority to repeaters that received them with a strong signal, to reduce redundant retransmissions.",
            it: "Funzione sperimentale: i pacchetti flood ricevuti con segnale debole vengono trattenuti brevemente in una coda di ritardo, dando la precedenza ai repeater che li hanno ricevuti con segnale forte, per ridurre ritrasmissioni ridondanti."
        },
        "tip.cfgFloodMaxHops": {
            en: "Maximum number of hops that a packet routed in flood can travel before being discarded.",
            it: "Numero massimo di hop che un pacchetto instradato in flood può percorrere prima di essere scartato."
        },
        "tip.cfgFloodMaxHopsUnscoped": {
            en: "Like \"Flood Max Hops\", but applied to flood packets without a specific scope/region (transport code).",
            it: "Come \"Flood Max Hops\", ma applicato ai pacchetti flood privi di un ambito/regione (transport code) specifico."
        },
        "tip.cfgFloodMaxHopsAdvert": {
            en: "Maximum number of hops for flood advert packets only (announcements of a node's presence) — normally a lower limit than for generic flood traffic.",
            it: "Numero massimo di hop per i soli pacchetti Advert in flood (quelli che segnalano la presenza di un nodo) — di norma un limite più basso rispetto al traffico flood generico."
        },
        "tip.cfgDefaultRegion": {
            en: "Default radio region used by the repeater when a packet does not explicitly specify one.",
            it: "Regione radio predefinita usata dal repeater quando un pacchetto non ne specifica una esplicitamente."
        },
        "tip.cfgDutyCycle": {
            en: "Self-limitation imposed by the firmware itself: after each transmission, the repeater imposes a silence proportional to the time just transmitted, to comply with regulatory bandwidth limits (e.g. 10% below 868MHz in Europe). It applies to TX only, never to reception — it is not a measured average: compare it with \"TX Duty Cycle (observed)\" in Status, not with \"Airtime % (mesh)\", which also includes RX.",
            it: "Autolimitazione imposta dal firmware stesso: dopo ogni trasmissione, il repeater si impone un silenzio proporzionale al tempo appena trasmesso, per rispettare i limiti normativi di banda (es. 10% sotto 868MHz in Europa). Riguarda solo il TX, mai la ricezione — non è una media misurata: confrontalo con \"TX Duty Cycle (observed)\" in Stato, non con \"Airtime % (mesh)\" che include anche l'RX."
        },

        // ---- app.js: scheda Repeaters ----
        "rep.errorList": {
            en: "Error loading repeater list.",
            it: "Errore nel caricamento dell'elenco repeater."
        },
        "rep.noData": {
            en: "No repeater data available yet.",
            it: "Nessun dato repeater ancora disponibile."
        },
        "rep.noStatus": {
            en: "No status data available.",
            it: "Nessun dato di stato disponibile."
        },
        "rep.telColChannel": {
            en: "Channel",
            it: "Canale"
        },
        "rep.telColType": {
            en: "Type",
            it: "Tipo"
        },
        "rep.telColValue": {
            en: "Value",
            it: "Valore"
        },
        "rep.noTelemetry": {
            en: "No telemetry data available.",
            it: "Nessun dato di telemetria disponibile."
        },
        "rep.noConfig": {
            en: "No config data available.",
            it: "Nessun dato di configurazione disponibile."
        },
        "rep.noRegion": {
            en: "No region data available.",
            it: "Nessun dato di regione disponibile."
        },
        "rep.heading": {
            en: "Neighbours - {n}",
            it: "Vicini - {n}"
        },
        "rep.colName": {
            en: "Name",
            it: "Nome"
        },
        "rep.colPrefix": {
            en: "Prefix",
            it: "Prefisso"
        },
        "rep.colLastSeen": {
            en: "Last Seen",
            it: "Ultima ricezione"
        },
        "rep.nameAmbiguous": {
            en: "(ambiguous)",
            it: "(ambiguo)"
        },
        "rep.noNeighbours": {
            en: "No neighbours data available.",
            it: "Nessun dato sui vicini disponibile."
        },

        // ---- app.js: parti presenti solo nel Collettore ----
        "nodes.noDataForNode": {
            en: "No data available for this node — check that the update has been applied.",
            it: "Nessun dato disponibile per questo nodo — verifica che l'aggiornamento sia stato applicato."
        },
        "nodes.noNodesInPeriod": {
            en: "No nodes were observed in the selected period for this node.",
            it: "Nessun nodo osservato nel periodo selezionato per questo nodo."
        },

        // ---- analysis.js e analysis_propagation.js: costanti, formati, avvisi, note ----
        "an.tipProven": {
            en: "Seen forwarding a packet at position 9 or beyond (the last hop, next to the tracer, is not counted) in at least 3 distinct advert transmissions from at least 2 different sources.",
            it: "Visto ritrasmettere un pacchetto alla posizione 9 o oltre (l'ultimo hop, accanto al tracciatore, non viene contato) in almeno 3 trasmissioni di advert distinte provenienti da almeno 2 sorgenti diverse."
        },
        "an.tipIndication": {
            en: "Seen forwarding at position 9 or beyond in 1-2 advert transmissions, or from a single source: not enough to call it proven.",
            it: "Visto ritrasmettere alla posizione 9 o oltre in 1-2 trasmissioni di advert, o da una sola sorgente: non abbastanza per considerarlo provato."
        },
        "an.tipSonarOnly": {
            en: "Seen at depth only in Sonar messages, never in an advert. Descriptive only: it is not a classification and says nothing about the advert limit.",
            it: "Visto lontano dalla sorgente solo nei messaggi Sonar, mai in un advert. Solo descrittivo: non è una classificazione e non dice nulla sul limite degli advert."
        },
        "an.regPropagation": {
            en: "Propagation: advert paths vs Sonar paths",
            it: "Propagazione: path degli advert contro path Sonar"
        },
        "an.noData": {
            en: "no data",
            it: "nessun dato"
        },
        "an.winAll": {
            en: "All history",
            it: "Tutta la storia"
        },
        "an.winLive": {
            en: "Live (current database)",
            it: "In tempo reale (database corrente)"
        },
        "an.nDays": {
            en: "{n} days",
            it: "{n} giorni"
        },
        "an.thisNode": {
            en: "This node",
            it: "Questo nodo"
        },
        "an.unknownError": {
            en: "unknown error",
            it: "errore sconosciuto"
        },
        "an.noticeFailedNoResult": {
            en: "The analysis job has run but failed and there is no earlier result to show{error}.",
            it: "Il job di analisi è stato eseguito ma è fallito e non c'è nessun risultato precedente da mostrare{error}."
        },
        "an.noticeNoData": {
            en: "No analysis data available yet.",
            it: "Nessun dato di analisi ancora disponibile."
        },
        "an.noticeLastRunFailed": {
            en: "The last run of the analysis job failed{at}{error}. Showing the results of the last successful run ({time}).",
            it: "L'ultima esecuzione del job di analisi è fallita{at}{error}. Vengono mostrati i risultati dell'ultima esecuzione riuscita ({time})."
        },
        "an.noticeStale": {
            en: "These results are {age} old: the scheduled job normally refreshes them every two hours and may have stopped.",
            it: "Questi risultati sono vecchi di {age}: il job pianificato normalmente li aggiorna ogni due ore e potrebbe essersi fermato."
        },
        "an.noteMissingTables": {
            en: "{tracer}: the tables {tables} are not present (node not updated yet?). Treated as \"no data\", not as zero.",
            it: "{tracer}: le tabelle {tables} non sono presenti (nodo non ancora aggiornato?). Trattato come \"nessun dato\", non come zero."
        },
        "an.noteTracerError": {
            en: "{tracer}: the database could not be read ({message}).",
            it: "{tracer}: non è stato possibile leggere il database ({message})."
        },
        "an.noteNoParticipantFilter": {
            en: "This node does not know which other nodes take part in the Sonar, so every source heard on the Sonar channel is shown. A collector applies the participant filter.",
            it: "Questo nodo non sa quali altri nodi partecipano al Sonar, quindi viene mostrata ogni sorgente sentita sul canale Sonar. Un collettore applica il filtro dei partecipanti."
        },
        "an.notePrefixConflict": {
            en: "Prefix {prefix} is used by two nodes ({tracers}); the first one was kept.",
            it: "Il prefisso {prefix} è usato da due nodi ({tracers}); è stato mantenuto il primo."
        },
        "an.noteSourceAmbiguous": {
            en: "Source {prefix}: more than one known node matches this prefix, so its position is unknown.",
            it: "Sorgente {prefix}: più di un nodo noto corrisponde a questo prefisso, quindi la sua posizione è sconosciuta."
        },
        "an.noteSourceUnknown": {
            en: "Source {prefix}: no known node has this prefix, so its name and position are unknown.",
            it: "Sorgente {prefix}: nessun nodo noto ha questo prefisso, quindi il suo nome e la sua posizione sono sconosciuti."
        },
        "an.noteGeneric": {
            en: "Note: {code}",
            it: "Nota: {code}"
        },

        // ---- analysis_propagation.js: pannello 1, stato dei dati ----
        "an.modeCollector": {
            en: "All nodes configured on this collector.",
            it: "Tutti i nodi configurati su questo collettore."
        },
        "an.modeNode": {
            en: "This node only; the participants of the Sonar are not known, so no filter is applied.",
            it: "Solo questo nodo; i partecipanti al Sonar non sono noti, quindi non viene applicato nessun filtro."
        },
        "an.noSonarInWindow": {
            en: "no Sonar data in this window",
            it: "nessun dato Sonar in questa finestra"
        },
        "an.commonFrom": {
            en: "from {time} (first Sonar message in this window): panels 2-4 count adverts only from then",
            it: "da {time} (primo messaggio Sonar in questa finestra): i pannelli 2-4 contano gli advert solo da quel momento"
        },
        "an.commonWhole": {
            en: "the whole window (no Sonar data to align with)",
            it: "tutta la finestra (nessun dato Sonar con cui allinearsi)"
        },
        "an.kvWindow": {
            en: "Window",
            it: "Finestra"
        },
        "an.kvDataSpan": {
            en: "Data span",
            it: "Intervallo dei dati"
        },
        "an.kvSonarSpan": {
            en: "Sonar span",
            it: "Intervallo Sonar"
        },
        "an.kvComparison": {
            en: "Comparison period",
            it: "Periodo di confronto"
        },
        "an.kvScope": {
            en: "Scope",
            it: "Ambito"
        },
        "an.kvDeep": {
            en: "Deep position",
            it: "Posizione lontana"
        },
        "an.orBeyond": {
            en: "{n} or beyond",
            it: "{n} o oltre"
        },
        "an.hTracers": {
            en: "Tracers",
            it: "Tracciatori"
        },
        "an.thTracer": {
            en: "Tracer",
            it: "Tracciatore"
        },
        "an.thPosition": {
            en: "Position",
            it: "Posizione"
        },
        "an.thAdvertsReceived": {
            en: "Adverts received",
            it: "Advert ricevuti"
        },
        "an.thAdvertsSpan": {
            en: "Adverts span",
            it: "Intervallo advert"
        },
        "an.thSonarReceived": {
            en: "Sonar messages received",
            it: "Messaggi Sonar ricevuti"
        },
        "an.thSonarSent": {
            en: "Sonar sent",
            it: "Sonar inviati"
        },
        "an.thAdvertsSent": {
            en: "Adverts sent (logged)",
            it: "Advert inviati (registrati)"
        },
        "an.thState": {
            en: "State",
            it: "Stato"
        },
        "an.noTracer": {
            en: "No tracer",
            it: "Nessun tracciatore"
        },
        "an.yes": {
            en: "yes",
            it: "sì"
        },
        "an.no": {
            en: "no",
            it: "no"
        },
        "an.missing": {
            en: "missing:",
            it: "mancanti:"
        },
        "an.stateOk": {
            en: "ok",
            it: "ok"
        },
        "an.hSonarSources": {
            en: "Sonar sources",
            it: "Sorgenti Sonar"
        },
        "an.notKnownNode": {
            en: "not a known node",
            it: "non è un nodo noto"
        },
        "an.txUncertain": {
            en: "(+{n} uncertain)",
            it: "(+{n} incerti)"
        },
        "an.txFailed": {
            en: "({n} failed)",
            it: "({n} falliti)"
        },
        "an.thSource": {
            en: "Source",
            it: "Sorgente"
        },
        "an.thPrefix": {
            en: "Prefix",
            it: "Prefisso"
        },
        "an.thNode": {
            en: "Node",
            it: "Nodo"
        },
        "an.thAdvertsSeen": {
            en: "Adverts seen by ≥ 1 tracer",
            it: "Advert visti da ≥ 1 tracciatore"
        },
        "an.thLastAdvert": {
            en: "Last advert seen",
            it: "Ultimo advert visto"
        },
        "an.noSonarSource": {
            en: "No Sonar source in this window",
            it: "Nessuna sorgente Sonar in questa finestra"
        },
        "an.hExcluded": {
            en: "Sonar sources not counted",
            it: "Sorgenti Sonar non conteggiate"
        },
        "an.helpExcluded": {
            en: "Heard on the Sonar channel but sent by a node that is not part of this project (it is not configured on this collector with the Sonar active), so its messages are left out of the comparison.",
            it: "Sentite sul canale Sonar ma inviate da un nodo che non fa parte di questo progetto (non è configurato su questo collettore con il Sonar attivo), quindi i suoi messaggi sono esclusi dal confronto."
        },
        "an.unknown": {
            en: "unknown",
            it: "sconosciuto"
        },
        "an.thName": {
            en: "Name",
            it: "Nome"
        },
        "an.thMessages": {
            en: "Messages",
            it: "Messaggi"
        },
        "an.thCopies": {
            en: "Copies",
            it: "Copie"
        },
        "an.thHeardBy": {
            en: "Heard by",
            it: "Sentito da"
        },
        "an.hDeepEvidence": {
            en: "Deep evidence from Sonar messages",
            it: "Prove a grande distanza dai messaggi Sonar"
        },
        "an.deepEvidence": {
            en: "{copies} at {hops} hops or more, from {transmissions} and {sources}. A per-repeater limit classification would need at least {needTx} deep transmissions from at least {needSrc} sources: {verdict}.",
            it: "{copies} a {hops} hop o più, da {transmissions} e {sources}. Una classificazione del limite per singolo repeater richiederebbe almeno {needTx} trasmissioni con posizioni lontane, da almeno {needSrc} sorgenti: {verdict}."
        },
        "an.enoughData": {
            en: "enough data",
            it: "dati sufficienti"
        },
        "an.notEnoughData": {
            en: "not enough data yet, so no classification is made",
            it: "dati ancora insufficienti, quindi non viene fatta nessuna classificazione"
        },
        "an.hNameResolution": {
            en: "Hop name resolution",
            it: "Risoluzione dei nomi degli hop"
        },
        "an.helpNameResolution": {
            en: "A hop is named only when its hash prefix identifies exactly one known repeater; otherwise it stays unresolved (never a guessed name).",
            it: "Un hop riceve un nome solo quando il suo prefisso di hash identifica esattamente un repeater noto; altrimenti resta non risolto (mai un nome indovinato)."
        },
        "an.thHopsCounted": {
            en: "Hops counted",
            it: "Hop conteggiati"
        },
        "an.thTotal": {
            en: "Total",
            it: "Totale"
        },
        "an.thResolved": {
            en: "Resolved",
            it: "Risolti"
        },
        "an.thAmbiguousPrefix": {
            en: "Ambiguous prefix",
            it: "Prefisso ambiguo"
        },
        "an.thNoKnownRepeater": {
            en: "No known repeater",
            it: "Nessun repeater noto"
        },
        "an.covAdverts": {
            en: "Adverts, positions of the paths shown in panels 3-4",
            it: "Advert, posizioni dei path mostrati nei pannelli 3-4"
        },
        "an.covSonar": {
            en: "Sonar, paths shown in panels 3-4",
            it: "Sonar, path mostrati nei pannelli 3-4"
        },
        "an.covDeepAdverts": {
            en: "Adverts, deep positions (panel 5)",
            it: "Advert, posizioni lontane (pannello 5)"
        },
        "an.covDeepSonar": {
            en: "Sonar, deep positions (panel 5)",
            it: "Sonar, posizioni lontane (pannello 5)"
        },
        "an.jobWarning": {
            en: "Job: {warning}",
            it: "Job: {warning}"
        },
        "an.hNotes": {
            en: "Notes",
            it: "Note"
        },
        "an.infoComputed": {
            en: "Computed {time}",
            it: "Calcolato {time}"
        },
        "an.infoComputedAgo": {
            en: "Computed {time} ({age} ago)",
            it: "Calcolato {time} ({age} fa)"
        },
        "an.lastRunFailed": {
            en: "last run failed",
            it: "ultima esecuzione fallita"
        },
        "an.lastRunOk": {
            en: "last run ok",
            it: "ultima esecuzione riuscita"
        },
        "an.infoTook": {
            en: "took {s} s",
            it: "durata {s} s"
        },
        "an.infoEngine": {
            en: "engine {engine}",
            it: "motore {engine}"
        },
        "an.infoInference": {
            en: "statistical inference from recorded paths, not a measurement of each repeater's settings",
            it: "inferenza statistica dai path registrati, non una misura delle impostazioni di ciascun repeater"
        },

        // ---- analysis_propagation.js: parole per i plurali (analysisPlural) ----
        "an.wCopy": {
            en: "copy",
            it: "copia"
        },
        "an.wCopies": {
            en: "copies",
            it: "copie"
        },
        "an.wTransmission": {
            en: "transmission",
            it: "trasmissione"
        },
        "an.wTransmissions": {
            en: "transmissions",
            it: "trasmissioni"
        },
        "an.wSource": {
            en: "source",
            it: "sorgente"
        },
        "an.wSources": {
            en: "sources",
            it: "sorgenti"
        },
        "an.wMessage": {
            en: "message",
            it: "messaggio"
        },
        "an.wMessages": {
            en: "messages",
            it: "messaggi"
        },

        // ---- analysis_propagation.js: pannello 2, matrice ----
        "an.noneReceived": {
            en: "none received",
            it: "nessuno ricevuto"
        },
        "an.ofSent.one": {
            en: "of {n} sent",
            it: "su {n} inviato"
        },
        "an.ofSent.other": {
            en: "of {n} sent",
            it: "su {n} inviati"
        },
        "an.messagesWord.one": {
            en: "messages",
            it: "messaggio"
        },
        "an.messagesWord.other": {
            en: "messages",
            it: "messaggi"
        },
        "an.hopsText": {
            en: "hops {text}",
            it: "hop {text}"
        },
        "an.nDeep.one": {
            en: "{n} deep",
            it: "{n} lontana"
        },
        "an.nDeep.other": {
            en: "{n} deep",
            it: "{n} lontane"
        },
        "an.noneSeen": {
            en: "none seen",
            it: "nessuno visto"
        },
        "an.seenWord.one": {
            en: "seen",
            it: "visto"
        },
        "an.seenWord.other": {
            en: "seen",
            it: "visti"
        },
        "an.matrixEmpty": {
            en: "No Sonar source in this window, so there is nothing to compare yet.",
            it: "Nessuna sorgente Sonar in questa finestra, quindi non c'è ancora nulla da confrontare."
        },
        "an.selfCellTip": {
            en: "A node does not record its own transmissions as received.",
            it: "Un nodo non registra le proprie trasmissioni come ricevute."
        },
        "an.advertsLogged.one": {
            en: "{n} adverts logged",
            it: "{n} advert registrato"
        },
        "an.advertsLogged.other": {
            en: "{n} adverts logged",
            it: "{n} advert registrati"
        },
        "an.sonarSentN.one": {
            en: "{n} Sonar sent",
            it: "{n} Sonar inviato"
        },
        "an.sonarSentN.other": {
            en: "{n} Sonar sent",
            it: "{n} Sonar inviati"
        },
        "an.matrixCorner": {
            en: "Source ↓ / Tracer →",
            it: "Sorgente ↓ / Tracciatore →"
        },

        // ---- analysis_propagation.js: pannello 4, confronto della coppia ----
        "an.kindAdvert": {
            en: "advert",
            it: "advert"
        },
        "an.kindSonarMsg": {
            en: "Sonar message",
            it: "messaggio Sonar"
        },
        "an.capOf": {
            en: "{kind} cap {cap}",
            it: "limite {kind}: {cap}"
        },
        "an.verdictB": {
            en: "a {other} would be stopped before position {position}",
            it: "un {other} si fermerebbe prima della posizione {position}"
        },
        "an.verdictU": {
            en: "a {other} may be stopped here: its cap changed around this time",
            it: "un {other} potrebbe fermarsi qui: il suo limite è cambiato in questo periodo"
        },
        "an.verdictP": {
            en: "a {other} could pass (cap known)",
            it: "un {other} potrebbe passare (limite noto)"
        },
        "an.verdictC": {
            en: "a {other} was seen forwarding at this position or beyond",
            it: "un {other} è stato visto ritrasmettere a questa posizione o oltre"
        },
        "an.verdictN": {
            en: "no evidence for a {other}: cap not known",
            it: "nessuna evidenza per un {other}: limite non noto"
        },
        "an.hopTipNamed": {
            en: "Position {position} · prefix {prefix} · {key}…",
            it: "Posizione {position} · prefisso {prefix} · {key}…"
        },
        "an.hopShared": {
            en: "{n} known repeaters share the prefix {prefix}: not resolved",
            it: "{n} repeater noti condividono il prefisso {prefix}: non risolto"
        },
        "an.hopNoName": {
            en: "Known repeater without a name (prefix {prefix})",
            it: "Repeater noto senza nome (prefisso {prefix})"
        },
        "an.hopNoRepeaterTip": {
            en: "No known repeater has the prefix {prefix}",
            it: "Nessun repeater noto ha il prefisso {prefix}"
        },
        "an.hopTipUnknown": {
            en: "Position {position} · {why}",
            it: "Posizione {position} · {why}"
        },
        "an.noPathForPair": {
            en: "No path recorded for this pair in this window",
            it: "Nessun path registrato per questa coppia in questa finestra"
        },
        "an.scopeRegionFlood": {
            en: "region (TC_FLOOD)",
            it: "con regione (TC_FLOOD)"
        },
        "an.scopeNoRegionFlood": {
            en: "no region (FLOOD)",
            it: "senza regione (FLOOD)"
        },
        "an.showOnMap": {
            en: "Show on map",
            it: "Mostra sulla mappa"
        },
        "an.alsoInTip": {
            en: "The same sequence of repeaters also appears among the {name} paths of this pair.",
            it: "La stessa sequenza di repeater compare anche tra i path {name} di questa coppia."
        },
        "an.alsoIn": {
            en: "also in {name}",
            it: "anche in {name}"
        },
        "an.pairThMap": {
            en: "Map",
            it: "Mappa"
        },
        "an.thScope": {
            en: "Scope",
            it: "Ambito"
        },
        "an.thHops": {
            en: "Hops",
            it: "Hop"
        },
        "an.thTransmissions": {
            en: "Transmissions",
            it: "Trasmissioni"
        },
        "an.thFirstLast": {
            en: "First / last seen",
            it: "Prima / ultima volta visto"
        },
        "an.thPathSrcTracer": {
            en: "Path (source → tracer)",
            it: "Path (sorgente → tracciatore)"
        },
        "an.thComparison": {
            en: "Comparison",
            it: "Confronto"
        },
        "an.noDataForPair": {
            en: "No data for this pair.",
            it: "Nessun dato per questa coppia."
        },
        "an.pairSonar": {
            en: "Sonar: {messages}, {copies}, hops {hops}",
            it: "Sonar: {messages}, {copies}, hop {hops}"
        },
        "an.pairAdvert.one": {
            en: "Advert: {seen} seen, {copies}, hops {hops}",
            it: "Advert: {seen} visto, {copies}, hop {hops}"
        },
        "an.pairAdvert.other": {
            en: "Advert: {seen} seen, {copies}, hops {hops}",
            it: "Advert: {seen} visti, {copies}, hop {hops}"
        },
        "an.hopsLegend": {
            en: "(hops: min / median / max)",
            it: "(hop: min / mediana / max)"
        },
        "an.coordUnknown": {
            en: "position not known",
            it: "posizione non nota"
        },
        "an.stepSource": {
            en: "Source",
            it: "Sorgente"
        },
        "an.stepTracer": {
            en: "Tracer",
            it: "Tracciatore"
        },
        "an.reasonShared": {
            en: "prefix {prefix} is shared by {n} known repeaters",
            it: "il prefisso {prefix} è condiviso da {n} repeater noti"
        },
        "an.reasonNoRepeater": {
            en: "no known repeater has the prefix {prefix}",
            it: "nessun repeater noto ha il prefisso {prefix}"
        },

        // ---- analysis_propagation.js: pannello 5, repeater profondi ----
        "an.colStatus": {
            en: "Status",
            it: "Stato"
        },
        "an.colSeenAdverts": {
            en: "Seen in adverts",
            it: "Visto negli advert"
        },
        "an.colSeenSonar": {
            en: "Seen in Sonar messages",
            it: "Visto nei messaggi Sonar"
        },
        "an.colCouldFollow": {
            en: "Could an advert follow?",
            it: "Un advert potrebbe proseguire?"
        },
        "an.tipCouldFollow": {
            en: "For the deep Sonar copies that include this repeater: could an advert with the same scope have followed the same path, judging only on the flood settings trace-mon knows?",
            it: "Per le copie Sonar arrivate da lontano che includono questo repeater: un advert con lo stesso ambito avrebbe potuto seguire lo stesso path, giudicando solo in base alle impostazioni di flood che trace-mon conosce?"
        },
        "an.colAdvertCap": {
            en: "Advert cap",
            it: "Limite advert"
        },
        "an.tipAdvertCap": {
            en: "Advert cap of the repeater from its settings (no region / region), or the highest position at which it was seen forwarding an advert",
            it: "Limite advert del repeater dalle sue impostazioni (senza regione / con regione), oppure la posizione più alta alla quale è stato visto ritrasmettere un advert"
        },
        "an.colTransm": {
            en: "Transm.",
            it: "Trasm."
        },
        "an.colSources": {
            en: "Sources",
            it: "Sorgenti"
        },
        "an.colTracers": {
            en: "Tracers",
            it: "Tracciatori"
        },
        "an.colDeepest": {
            en: "Deepest",
            it: "Più lontana"
        },
        "an.colLast": {
            en: "Last",
            it: "Ultima"
        },
        "an.noRepeaterMatches": {
            en: "No repeater matches",
            it: "Nessun repeater corrisponde"
        },
        "an.unnamed": {
            en: "unnamed",
            it: "senza nome"
        },
        "an.scopeNoRegion": {
            en: "no region",
            it: "senza regione"
        },
        "an.scopeRegion": {
            en: "region",
            it: "con regione"
        },

        // ---- analysis_propagation.js: pannello 6, limiti operativi ----
        "an.lastRead": {
            en: "last read",
            it: "ultima lettura"
        },
        "an.firstRead": {
            en: "first read",
            it: "prima lettura"
        },
        "an.plusMore": {
            en: "+{n} more",
            it: "+{n} altri"
        },
        "an.outsideBefore.one": {
            en: "{n} repeater read only before this period and no longer: {list}",
            it: "{n} repeater letto solo prima di questo periodo e non più dopo: {list}"
        },
        "an.outsideBefore.other": {
            en: "{n} repeaters read only before this period and no longer: {list}",
            it: "{n} repeater letti solo prima di questo periodo e non più dopo: {list}"
        },
        "an.outsideAfter.one": {
            en: "{n} repeater read for the first time only after this period: {list}",
            it: "{n} repeater letto per la prima volta solo dopo questo periodo: {list}"
        },
        "an.outsideAfter.other": {
            en: "{n} repeaters read for the first time only after this period: {list}",
            it: "{n} repeater letti per la prima volta solo dopo questo periodo: {list}"
        },
        "an.outsideNote": {
            en: "Not in the table, because its settings are not known in this period: {parts}. Packets of this period are not judged against them.",
            it: "Non sono nella tabella perché le loro impostazioni non sono note in questo periodo: {parts}. I pacchetti di questo periodo non vengono giudicati in base ad esse."
        },
        "an.capLastTip": {
            en: "Not known at the end of this period: no valid reading in the {duration} before it. Most recent value read: {value}.",
            it: "Non noto alla fine di questo periodo: nessuna lettura valida nei {duration} precedenti. Ultimo valore letto: {value}."
        },
        "an.capRangeTip": {
            en: "Changed between two readings, around the end of this period: the value is one of these two.",
            it: "Cambiato tra due letture, intorno alla fine di questo periodo: il valore è uno di questi due."
        },
        "an.capSingleTip": {
            en: "Seen in a single reading only",
            it: "Visto in una sola lettura"
        },
        "an.noneRecorded": {
            en: "none recorded",
            it: "nessuno registrato"
        },
        "an.noneInPeriod": {
            en: "none in this period",
            it: "nessuno in questo periodo"
        },
        "an.changeBetween": {
            en: "between {from} and {to}",
            it: "tra {from} e {to}"
        },
        "an.badgeAddedTip": {
            en: "First reading {time}, after the start of this period: before that its settings are not known (the repeater may have been added to trace-mon in this period, or its readings started later). Packets received earlier are not judged against it.",
            it: "Prima lettura {time}, dopo l'inizio di questo periodo: prima le sue impostazioni non sono note (il repeater può essere stato aggiunto a trace-mon in questo periodo, oppure le sue letture sono iniziate più tardi). I pacchetti ricevuti prima non vengono giudicati in base ad esso."
        },
        "an.badgeAdded": {
            en: "added in this period",
            it: "aggiunto in questo periodo"
        },
        "an.badgeEndedTip": {
            en: "No reading in the {duration} before the end of this period (last reading {time}): the repeater may have been removed or does not answer. Its settings are not applied to packets received after that.",
            it: "Nessuna lettura nei {duration} precedenti la fine di questo periodo (ultima lettura {time}): il repeater può essere stato rimosso oppure non risponde. Le sue impostazioni non vengono applicate ai pacchetti ricevuti dopo."
        },
        "an.badgeEnded": {
            en: "no longer read",
            it: "non più letto"
        },
        "an.limTipSettingsEnd": {
            en: "The values in force at the end of the selected period, not the current ones. Italic: seen in a single reading. Two numbers: the setting changed between two readings.",
            it: "I valori in vigore alla fine del periodo selezionato, non quelli attuali. Corsivo: visto in una sola lettura. Due numeri: l'impostazione è cambiata tra due letture."
        },
        "an.limThSettingsEnd": {
            en: "Settings at the end of the period",
            it: "Impostazioni a fine periodo"
        },
        "an.limThSettingsRepeater": {
            en: "Settings on the repeater",
            it: "Impostazioni sul repeater"
        },
        "an.limTipEffective": {
            en: "Highest hop count at which the repeater still forwards (working hypothesis: advert without region = min(Unscoped, Advert); advert with region = Advert; message without region = min(Unscoped, Flood Max Hops); message with region = Flood Max Hops)",
            it: "Numero massimo di hop fino al quale il repeater ritrasmette ancora (ipotesi di lavoro: advert senza regione = min(Unscoped, Advert); advert con regione = Advert; messaggio senza regione = min(Unscoped, Flood Max Hops); messaggio con regione = Flood Max Hops)"
        },
        "an.limThEffective": {
            en: "Effective cap (hops)",
            it: "Limite effettivo (hop)"
        },
        "an.limTipKnown": {
            en: "First and last reading of the settings of this repeater (the whole history kept, not only this period), how many readings, and which nodes read them",
            it: "Prima e ultima lettura delle impostazioni di questo repeater (tutta la storia conservata, non solo questo periodo), quante letture e quali nodi le hanno lette"
        },
        "an.limThKnown": {
            en: "Settings known",
            it: "Impostazioni note"
        },
        "an.limThChanges": {
            en: "Changes in this period",
            it: "Cambiamenti in questo periodo"
        },
        "an.limThAdvertNoRegion": {
            en: "Advert, no region",
            it: "Advert, senza regione"
        },
        "an.limThAdvertRegion": {
            en: "Advert, region",
            it: "Advert, con regione"
        },
        "an.limThMessageNoRegion": {
            en: "Message, no region",
            it: "Messaggio, senza regione"
        },
        "an.limThMessageRegion": {
            en: "Message, region",
            it: "Messaggio, con regione"
        },
        "an.limNoRepeater": {
            en: "No repeater with settings known in this period",
            it: "Nessun repeater con impostazioni note in questo periodo"
        },
        "an.noValidTip": {
            en: "Every reading of this repeater was empty (timeout) or invalid: no setting is known.",
            it: "Ogni lettura di questo repeater era vuota (timeout) o non valida: nessuna impostazione è nota."
        },
        "an.noValidReading": {
            en: "no valid reading",
            it: "nessuna lettura valida"
        },
        "an.wReading": {
            en: "reading",
            it: "lettura"
        },
        "an.wReadings": {
            en: "readings",
            it: "letture"
        },
        "an.srcNoteReadFailed": {
            en: "The database of this node could not be read in the last run, and no earlier reading was kept: no settings from this node.",
            it: "Il database di questo nodo non è stato leggibile nell'ultima esecuzione e non è stata conservata nessuna lettura precedente: nessuna impostazione da questo nodo."
        },
        "an.srcNoteNoTable": {
            en: "No settings table (repeater_config): this node has not been updated, its settings are not known.",
            it: "Nessuna tabella delle impostazioni (repeater_config): questo nodo non è stato aggiornato, le sue impostazioni non sono note."
        },
        "an.srcNoteNoRepeater": {
            en: "No managed repeater has been read at this node yet. Normal for a node that starts without one: it fills in once a repeater is added and read.",
            it: "Nessun repeater gestito è stato ancora letto da questo nodo. È normale per un nodo che parte senza: si popola quando un repeater viene aggiunto e letto."
        },
        "an.srcNoteOutside": {
            en: "Its repeaters have settings only outside this period.",
            it: "I suoi repeater hanno impostazioni solo fuori da questo periodo."
        },
        "an.srcNoteDbError": {
            en: "The database could not be read in the last run: these settings come from the history kept by the job.",
            it: "Il database non è stato leggibile nell'ultima esecuzione: queste impostazioni vengono dallo storico conservato dal job."
        },
        "an.srcTipReadings": {
            en: "Readings of the settings of the repeaters recorded by this node (repeater_config), including the history kept by the job",
            it: "Letture delle impostazioni dei repeater registrate da questo nodo (repeater_config), compreso lo storico conservato dal job"
        },
        "an.srcThReadings": {
            en: "Readings",
            it: "Letture"
        },
        "an.srcTipRepeaters": {
            en: "Distinct repeaters managed by this node that have at least one reading",
            it: "Repeater distinti gestiti da questo nodo che hanno almeno una lettura"
        },
        "an.srcThRepeaters": {
            en: "Repeaters",
            it: "Repeater"
        },
        "an.srcTipInPeriod": {
            en: "Of those, how many have settings known in the selected period",
            it: "Fra questi, quanti hanno impostazioni note nel periodo selezionato"
        },
        "an.srcThInPeriod": {
            en: "In this period",
            it: "In questo periodo"
        },
        "an.srcThFirstLast": {
            en: "First → last reading",
            it: "Prima → ultima lettura"
        },
        "an.thNote": {
            en: "Note",
            it: "Nota"
        },
        "an.srcNoNode": {
            en: "No node reported",
            it: "Nessun nodo ha riportato dati"
        },
        "an.badgeNoTable": {
            en: "no table",
            it: "nessuna tabella"
        },
        "an.badgeCheck": {
            en: "check",
            it: "da verificare"
        },
        "an.gwCap": {
            en: "cap {cap}",
            it: "limite {cap}"
        },
        "an.gwCapUnknownSeen": {
            en: "cap unknown, seen ≥ {n}",
            it: "limite sconosciuto, visto ≥ {n}"
        },
        "an.gwCapUnknown": {
            en: "cap unknown",
            it: "limite sconosciuto"
        },
        "an.gwThPackets": {
            en: "Packets",
            it: "Pacchetti"
        },
        "an.gwTipResolved": {
            en: "Copies whose last hop (the gateway, next to the tracer) has a unique known name",
            it: "Copie il cui ultimo hop (il gateway, accanto al tracciatore) ha un nome noto univoco"
        },
        "an.gwThResolved": {
            en: "Gateway identified",
            it: "Gateway identificato"
        },
        "an.gwTipKnown": {
            en: "Copies whose gateway has a known setting",
            it: "Copie il cui gateway ha un'impostazione nota"
        },
        "an.gwThKnown": {
            en: "Cap known",
            it: "Limite noto"
        },
        "an.gwTipBelow": {
            en: "Copies that arrived through a gateway whose cap is below 10 hops: they can say nothing about positions 9 and beyond",
            it: "Copie arrivate attraverso un gateway con un limite inferiore a 10 hop: non possono dire nulla sulle posizioni 9 e oltre"
        },
        "an.gwThBelow": {
            en: "Cap &lt; 10",
            it: "Limite &lt; 10"
        },
        "an.gwThCaps": {
            en: "Caps of the gateways",
            it: "Limiti dei gateway"
        },
        "an.gwThMain": {
            en: "Main gateways (copies)",
            it: "Gateway principali (copie)"
        },
        "an.gwNoCopy": {
            en: "No copy recorded in this period",
            it: "Nessuna copia registrata in questo periodo"
        },
        "an.noneKnown": {
            en: "none known",
            it: "nessuno noto"
        },
        "an.plusDirect": {
            en: "+{n} direct",
            it: "+{n} diretti"
        },
        "an.whileChanging": {
            en: "{n} while changing",
            it: "{n} durante il cambio"
        },
        "an.limNoticeOld": {
            en: "These results were computed before the operating-limits section existed. It will appear after the next run of the analysis job.",
            it: "Questi risultati sono stati calcolati prima che esistesse la sezione dei limiti operativi. Comparirà dopo la prossima esecuzione del job di analisi."
        },
        "an.limNoticeNone": {
            en: "No flood setting is recorded yet: no repeater managed by trace-mon has been read. This is normal for a node that starts without one: the section fills in by itself after a repeater is added and read (the job runs every two hours). Until then packet paths are shown without any information about hop limits.",
            it: "Non è ancora registrata nessuna impostazione di flood: nessun repeater gestito da trace-mon è stato letto. È normale per un nodo che parte senza: la sezione si popola da sola dopo che un repeater è stato aggiunto e letto (il job gira ogni due ore). Fino ad allora i path dei pacchetti sono mostrati senza alcuna informazione sui limiti di hop."
        },
        "an.limNoticeMissing": {
            en: "No settings table (repeater_config) at: {names}. For those nodes the settings are not known.",
            it: "Nessuna tabella delle impostazioni (repeater_config) presso: {names}. Per quei nodi le impostazioni non sono note."
        },
        "an.limAdded.one": {
            en: "{n} repeater added",
            it: "{n} repeater aggiunto"
        },
        "an.limAdded.other": {
            en: "{n} repeaters added",
            it: "{n} repeater aggiunti"
        },
        "an.limEnded.one": {
            en: "{n} repeater no longer read",
            it: "{n} repeater non più letto"
        },
        "an.limEnded.other": {
            en: "{n} repeaters no longer read",
            it: "{n} repeater non più letti"
        },
        "an.and": {
            en: " and ",
            it: " e "
        },
        "an.limNoticeAddedEnded": {
            en: "{what} during this period: for the time when their settings are not known, their hops count as “no known cap”.",
            it: "{what} durante questo periodo: per il tempo in cui le loro impostazioni non sono note, i loro hop contano come “limite non noto”."
        },
        "an.limChanged.one": {
            en: "{n} repeater changed flood settings during this period: copies received before and after a change are mixed in the charts and tables.",
            it: "{n} repeater ha cambiato le impostazioni di flood durante questo periodo: le copie ricevute prima e dopo un cambio sono mescolate nei grafici e nelle tabelle."
        },
        "an.limChanged.other": {
            en: "{n} repeaters changed flood settings during this period: copies received before and after a change are mixed in the charts and tables.",
            it: "{n} repeater hanno cambiato le impostazioni di flood durante questo periodo: le copie ricevute prima e dopo un cambio sono mescolate nei grafici e nelle tabelle."
        },
        "an.ceilingPart": {
            en: "{share} of the {kind} copies at this tracer ({copies} of {total}) come through a gateway capped at {cap} hops",
            it: "{share} delle copie di tipo {kind} presso questo tracciatore ({copies} su {total}) passano da un gateway con un limite di {cap} hop"
        },
        "an.ceilingNote": {
            en: "Dashed lines: {parts}. A copy cannot have more hops than the cap of its gateway, so beyond the line these packets can only arrive through other gateways. Counted over all copies of the period, any source. Known only for repeaters managed by trace-mon.",
            it: "Linee tratteggiate: {parts}. Una copia non può avere più hop del limite del suo gateway, quindi oltre la linea questi pacchetti possono arrivare solo attraverso altri gateway. Conteggiato su tutte le copie del periodo, da qualsiasi sorgente. Noto solo per i repeater gestiti da trace-mon."
        },
        "an.cpBasis": {
            en: "A {other} with the same scope ({scope}) on the same repeaters at the same time, judged only on the flood settings trace-mon knows. Repeaters without a known setting are not checked.",
            it: "Un {other} con lo stesso ambito ({scope}) sugli stessi repeater nello stesso momento, giudicato solo in base alle impostazioni di flood che trace-mon conosce. I repeater senza impostazione nota non vengono controllati."
        },
        "an.allCopies": {
            en: "all copies",
            it: "tutte le copie"
        },
        "an.nOf": {
            en: "{n} of {total}",
            it: "{n} su {total}"
        },
        "an.atHop": {
            en: "at hop {hop}: {name} (cap {cap})",
            it: "all'hop {hop}: {name} (limite {cap})"
        },
        "an.settingChangedSince": {
            en: "(the setting has changed since)",
            it: "(l'impostazione è cambiata da allora)"
        },
        "an.badgeStop": {
            en: "would stop",
            it: "si fermerebbe"
        },
        "an.badgeChanging": {
            en: "cap changing",
            it: "limite in cambiamento"
        },
        "an.settingChangedAround": {
            en: "setting changed around this time, {share}",
            it: "impostazione cambiata in questo periodo, {share}"
        },
        "an.hopsNoEvidence": {
            en: "{count} with no evidence",
            it: "{count} senza evidenza"
        },
        "an.badgeOpen": {
            en: "not stopped",
            it: "non bloccato"
        },
        "an.badgeNoCap": {
            en: "no known cap",
            it: "limite non noto"
        },
        "an.wHop": {
            en: "hop",
            it: "hop"
        },
        "an.wHops": {
            en: "hops",
            it: "hop"
        },

        // ---- analysis.js e analysis_propagation.js: pannello 5 (verdetti e tetto), caricamento, istogramma, confronto, mappa ----
        "an.followBasis": {
            en: "An advert with the same scope on the same repeaters, judged only on the flood settings trace-mon knows (deep Sonar copies that include this repeater).",
            it: "Un advert con lo stesso ambito sugli stessi repeater, giudicato solo in base alle impostazioni di flood che trace-mon conosce (copie Sonar arrivate da lontano che includono questo repeater)."
        },
        "an.followWhere": {
            en: "{name}, cap {cap}, hop {pos}",
            it: "{name}, limite {cap}, hop {pos}"
        },
        "an.repCapTip": {
            en: "Advert cap from the settings of the repeater at the end of this period: no region / region. Messages: {a} / {b}",
            it: "Limite advert dalle impostazioni del repeater alla fine di questo periodo: senza regione / con regione. Messaggi: {a} / {b}"
        },
        "an.repCapAdv": {
            en: "adv {a} / {b}",
            it: "adv {a} / {b}"
        },
        "an.repCapSeenTip": {
            en: "Seen forwarding an advert at this position, so its advert cap is at least this. Its real setting is not known.",
            it: "Visto ritrasmettere un advert a questa posizione, quindi il suo limite advert è almeno questo. La sua impostazione reale non è nota."
        },
        "an.repCapSeen": {
            en: "≥ {n} seen",
            it: "≥ {n} visto"
        },
        "an.loadNoData": {
            en: "No analysis data available yet. The scheduled job that computes it (analysis_job.js) has not run on this system: see the installation notes.",
            it: "Nessun dato di analisi ancora disponibile. Il job pianificato che lo calcola (analysis_job.js) non è stato ancora eseguito su questo sistema: vedi le note di installazione."
        },
        "an.loadError": {
            en: "Could not load the analysis data ({reason}).",
            it: "Impossibile caricare i dati di analisi ({reason})."
        },
        "an.networkError": {
            en: "network error",
            it: "errore di rete"
        },
        "an.showingEarlier": {
            en: "Showing the data loaded earlier.",
            it: "Vengono mostrati i dati caricati in precedenza."
        },
        "an.allTracers": {
            en: "All tracers",
            it: "Tutti i tracciatori"
        },
        "an.deepLineLabel": {
            en: "{n}+ hops: deep positions possible",
            it: "{n}+ hop: posizioni lontane possibili"
        },
        "an.capLineLabel": {
            en: "{kind} gateway cap {cap} ({share} %)",
            it: "{kind} limite gateway {cap} ({share} %)"
        },
        "an.histEmpty": {
            en: "No advert or Sonar copy recorded for this selection.",
            it: "Nessuna copia di advert o Sonar registrata per questa selezione."
        },
        "an.histAdvertsName": {
            en: "Adverts",
            it: "Advert"
        },
        "an.histShareNote": {
            en: "each series is shown as a share of its own total, so the two shapes can be compared even though adverts are far more numerous",
            it: "ogni serie è mostrata come quota del proprio totale, così le due forme si possono confrontare anche se gli advert sono molto più numerosi"
        },
        "an.histXAxis": {
            en: "Hops of the copy",
            it: "Hop della copia"
        },
        "an.histYShare": {
            en: "Share of the series (%)",
            it: "Quota della serie (%)"
        },
        "an.histYNumber": {
            en: "Number of {unit}",
            it: "Numero di {unit}"
        },
        "an.histTipTitle": {
            en: "{label} hops",
            it: "{label} hop"
        },
        "an.pairEmpty": {
            en: "No Sonar source in this window, so there is no pair to compare.",
            it: "Nessuna sorgente Sonar in questa finestra, quindi non c'è nessuna coppia da confrontare."
        },
        "an.pairTruncated.one": {
            en: "{n} less frequent path(s) not listed.",
            it: "{n} path meno frequente non elencato."
        },
        "an.pairTruncated.other": {
            en: "{n} less frequent path(s) not listed.",
            it: "{n} path meno frequenti non elencati."
        },
        "an.mapPaths": {
            en: "Paths on the map",
            it: "Path sulla mappa"
        },
        "an.mapNotShown": {
            en: "Points not shown",
            it: "Punti non mostrati"
        },
        "an.mapLegend": {
            en: "dashed link: it skips one or more points that are not shown",
            it: "collegamento tratteggiato: salta uno o più punti non mostrati"
        },
        "an.markerSource": {
            en: "{name} (source)",
            it: "{name} (sorgente)"
        },
        "an.markerTracer": {
            en: "{name} (tracer)",
            it: "{name} (tracciatore)"
        },
        "an.mapCaptionEmpty": {
            en: "Tick the \"Map\" box of one or more paths to draw them here.",
            it: "Spunta la casella \"Mappa\" di uno o più path per disegnarli qui."
        },
        "an.mapCaption": {
            en: "{paths} path(s) drawn; {points} point(s) with a position",
            it: "Path disegnati: {paths}; punti con una posizione: {points}"
        },
        "an.mapCaptionOmitted": {
            en: ", {n} not shown (see the box on the map)",
            it: ", non mostrati: {n} (vedi il riquadro sulla mappa)"
        },
        "an.mapBridgedTip": {
            en: "Link that skips one or more points not shown (position or name not known)",
            it: "Collegamento che salta uno o più punti non mostrati (posizione o nome non noti)"
        },
        "an.repSummary": {
            en: "{total} repeater(s): {proven} proven, {indication} with an indication, {sonar} seen at depth in Sonar messages only. Showing {shown}.",
            it: "Repeater: {total} (provati: {proven}; con un'indicazione: {indication}; visti lontano dalla sorgente solo nei messaggi Sonar: {sonar}). Mostrati: {shown}."
        },
        "an.repCut": {
            en: "The list was cut at its maximum size.",
            it: "L'elenco è stato troncato alla sua dimensione massima."
        },
        "an.mapMax": {
            en: "At most {n} paths can be drawn at once.",
            it: "Si possono disegnare al massimo {n} path alla volta."
        },
        // ---- analysis_quality.js: «Qualità dei path e simmetrie» (§109) ----
        "an.regQuality": {
            en: "Path quality and symmetries",
            it: "Qualità dei path e simmetrie"
        },
        "aq.winLive": {
            en: "Live (current trace file)",
            it: "In tempo reale (file di tracce corrente)"
        },
        "aq.infoInference": {
            en: "indication drawn from recorded traces, not a laboratory measurement",
            it: "indicazione ricavata dalle tracce registrate, non una misura di laboratorio"
        },
        "aq.badData": {
            en: "These analysis data do not have the expected format.",
            it: "Questi dati di analisi non hanno il formato atteso."
        },
        "aq.intro": {
            en: "Shows how good each radio link is and how balanced it is between the two directions, using the results of the traces run by the nodes (Trace tab). A trace sends a packet along a path of repeaters and back, and for every leg the receiver reports the <b>SNR</b>: so a link between two repeaters is measured in both directions, either in the same trace (mirror paths, where the way back retraces the way out) or in different ones. The <b>margin</b> is how far the average SNR of the weaker direction is above the lowest SNR the radio can demodulate: how much room the link has before it fails. The <b>symmetry</b> is the difference between the two directions. A link can be symmetric and weak, or strong and lopsided, so the two are shown together. These are indications drawn from recorded traces, not laboratory measurements: the SNR exists only for traces that were answered, a TIMEOUT cannot be attributed to a single leg, and the difference between the two directions mixes propagation, transmit power and noise floor at the two ends.",
            it: "Mostra quanto è buono ogni collegamento radio e quanto è equilibrato tra le due direzioni, a partire dai risultati delle tracce eseguite dai nodi (scheda Tracce). Una traccia invia un pacchetto lungo un path di repeater e ritorno, e per ogni tratta il ricevente riporta l'<b>SNR</b>: così un collegamento tra due repeater viene misurato in entrambe le direzioni, nella stessa traccia (path speculari, in cui il ritorno ripercorre l'andata) o in tracce diverse. Il <b>margine</b> è di quanto l'SNR medio della direzione più debole supera l'SNR minimo che la radio sa demodulare: quanto spazio ha il collegamento prima di cedere. La <b>simmetria</b> è la differenza tra le due direzioni. Un collegamento può essere simmetrico ma debole, o forte ma sbilanciato: per questo i due aspetti sono mostrati insieme. Sono indicazioni ricavate dalle tracce registrate, non misure di laboratorio: l'SNR esiste solo per le tracce che hanno avuto risposta, un TIMEOUT non è attribuibile a una singola tratta, e la differenza tra le due direzioni mescola propagazione, potenza di trasmissione e rumore di fondo ai due estremi."
        },
        "aq.h1": {
            en: "1. Data status and coverage",
            it: "1. Stato dei dati e copertura"
        },
        "aq.h2": {
            en: "2. Symmetry and margin",
            it: "2. Simmetria e margine"
        },
        "aq.help2": {
            en: "Each link falls in one cell: its symmetry (rows) and its margin (columns). The best case is symmetric and good. Click a number to list those links in panel 3; click it again to remove the filter.",
            it: "Ogni collegamento cade in una cella: la sua simmetria (righe) e il suo margine (colonne). Il caso migliore è simmetrico e buono. Clicca un numero per elencare quei collegamenti nel pannello 3; cliccalo di nuovo per togliere il filtro."
        },
        "aq.h3": {
            en: "3. Links",
            it: "3. Collegamenti"
        },
        "aq.help3": {
            en: "One row per link between two repeaters measured in at least one direction. In each row the first repeater is A and the second is B: A → B is the average SNR of the leg from A to B, B → A the one of the opposite leg, and Δ is A → B minus B → A. The symmetry is judged only when both directions have enough samples; the margin is that of the weaker direction. Click a row to show that link in panels 4 and 6.",
            it: "Una riga per ogni collegamento tra due repeater misurato in almeno una direzione. In ogni riga il primo repeater è A e il secondo è B: A → B è l'SNR medio della tratta da A a B, B → A quello della tratta opposta, e Δ è A → B meno B → A. La simmetria si giudica solo quando entrambe le direzioni hanno campioni sufficienti; il margine è quello della direzione più debole. Clicca una riga per mostrare quel collegamento nei pannelli 4 e 6."
        },
        "aq.h4": {
            en: "4. Trend over time",
            it: "4. Andamento nel tempo"
        },
        "aq.help4": {
            en: "Average SNR of the selected link, day by day (month by month over long periods). Empty points have fewer samples than the minimum: read them with care. Only links with enough samples in both directions are listed.",
            it: "SNR medio del collegamento scelto, giorno per giorno (mese per mese sui periodi lunghi). I punti vuoti hanno meno campioni del minimo: vanno letti con cautela. Sono elencati solo i collegamenti con campioni sufficienti in entrambe le direzioni."
        },
        "aq.h5": {
            en: "5. Reachability vs margin",
            it: "5. Raggiungibilità e margine"
        },
        "aq.help5": {
            en: "Each point is a path run by a node: the horizontal axis is the margin of its weakest leg, the vertical axis is the share of its traces that were answered. A path with a good margin but few answers is marked as an anomaly: its legs look fine on average, yet something else may be making its traces fail (for example a repeater that does not forward, interference or congestion at certain times). It is a hint to investigate, not a diagnosis. Click a row of the table to see that path by time of day in panel 6.",
            it: "Ogni punto è un path eseguito da un nodo: l'asse orizzontale è il margine della sua tratta più debole, quello verticale la quota delle sue tracce che hanno avuto risposta. Un path con buon margine ma poche risposte è segnato come anomalia: le sue tratte sembrano buone in media, eppure qualcos'altro può far fallire le sue tracce (per esempio un repeater che non ritrasmette, interferenze o congestione in certi orari). È uno spunto da approfondire, non una diagnosi. Clicca una riga della tabella per vedere quel path per fascia oraria nel pannello 6."
        },
        "aq.h6": {
            en: "6. Day and hour profile",
            it: "6. Profilo per giorno e ora"
        },
        "aq.help6": {
            en: "How the selected link or path behaves over the day (bands of hours) and over the week. The hours are those of the node's clock. A cell with fewer samples than the minimum shows no value.",
            it: "Come si comporta il collegamento o il path scelto nell'arco della giornata (fasce orarie) e della settimana. Le ore sono quelle dell'orologio del nodo. Una cella con meno campioni del minimo non mostra alcun valore."
        },
        "aq.h7": {
            en: "7. Comparison between nodes",
            it: "7. Confronto tra nodi"
        },
        "aq.help7": {
            en: "The same link measured by more than one node. A large spread between nodes means that the figure depends on the traces that crossed the link, not only on the link itself.",
            it: "Lo stesso collegamento misurato da più di un nodo. Una grande dispersione tra i nodi significa che il valore dipende dalle tracce che hanno attraversato il collegamento, non solo dal collegamento stesso."
        },
        "aq.lblSym": {
            en: "Symmetry",
            it: "Simmetria"
        },
        "aq.lblMargin": {
            en: "Margin",
            it: "Margine"
        },
        "aq.lblSort": {
            en: "Order",
            it: "Ordine"
        },
        "aq.sortDelta": {
            en: "Largest difference first",
            it: "Differenza maggiore prima"
        },
        "aq.sortMargin": {
            en: "Lowest margin first",
            it: "Margine minore prima"
        },
        "aq.sortName": {
            en: "Name",
            it: "Nome"
        },
        "aq.lblLink": {
            en: "Link",
            it: "Collegamento"
        },
        "aq.lblGrain": {
            en: "Group by",
            it: "Raggruppa per"
        },
        "aq.lblMetric": {
            en: "Show",
            it: "Mostra"
        },
        "aq.lblNode": {
            en: "Node",
            it: "Nodo"
        },
        "aq.lblKind": {
            en: "Look at",
            it: "Osserva"
        },
        "aq.lblSubject": {
            en: "Link / path",
            it: "Collegamento / path"
        },
        "aq.grainDay": {
            en: "Day",
            it: "Giorno"
        },
        "aq.grainMonth": {
            en: "Month",
            it: "Mese"
        },
        "aq.metricSnr": {
            en: "SNR of both directions",
            it: "SNR delle due direzioni"
        },
        "aq.metricDelta": {
            en: "Difference Δ",
            it: "Differenza Δ"
        },
        "aq.allNodes": {
            en: "All nodes",
            it: "Tutti i nodi"
        },
        "aq.kindLink": {
            en: "Link (two repeaters)",
            it: "Collegamento (due repeater)"
        },
        "aq.kindPath": {
            en: "Path (run by one node)",
            it: "Path (eseguito da un nodo)"
        },
        "aq.metricPctOk": {
            en: "Traces answered (%)",
            it: "Tracce con risposta (%)"
        },
        "aq.metricAB": {
            en: "{a} → {b}: mean SNR (dB)",
            it: "{a} → {b}: SNR medio (dB)"
        },
        "aq.metricBA": {
            en: "{b} → {a}: mean SNR (dB)",
            it: "{b} → {a}: SNR medio (dB)"
        },
        "aq.metricDeltaLong": {
            en: "Δ: first → second minus second → first (dB)",
            it: "Δ: prima → seconda meno seconda → prima (dB)"
        },
        "aq.sym_symmetric": {
            en: "symmetric",
            it: "simmetrico"
        },
        "aq.sym_moderate": {
            en: "moderate",
            it: "moderato"
        },
        "aq.sym_asymmetric": {
            en: "asymmetric",
            it: "asimmetrico"
        },
        "aq.sym_insufficient": {
            en: "few samples",
            it: "pochi campioni"
        },
        "aq.sym_unmeasured": {
            en: "one direction only",
            it: "una sola direzione"
        },
        "aq.symTip_symmetric": {
            en: "The two directions have almost the same average SNR.",
            it: "Le due direzioni hanno quasi lo stesso SNR medio."
        },
        "aq.symTip_moderate": {
            en: "The two directions differ noticeably.",
            it: "Le due direzioni differiscono in modo apprezzabile."
        },
        "aq.symTip_asymmetric": {
            en: "One direction is clearly stronger than the other.",
            it: "Una direzione è nettamente più forte dell'altra."
        },
        "aq.symTip_insufficient": {
            en: "Too few samples in at least one direction to judge the symmetry.",
            it: "Troppi pochi campioni in almeno una direzione per giudicare la simmetria."
        },
        "aq.symTip_unmeasured": {
            en: "Measured in one direction only, so the symmetry cannot be judged.",
            it: "Misurato in una sola direzione: la simmetria non si può giudicare."
        },
        "aq.mar_critical": {
            en: "critical",
            it: "critico"
        },
        "aq.mar_sufficient": {
            en: "sufficient",
            it: "sufficiente"
        },
        "aq.mar_good": {
            en: "good",
            it: "buono"
        },
        "aq.marTip_critical": {
            en: "The weaker direction is close to the lowest SNR the radio can demodulate: the link can fail.",
            it: "La direzione più debole è vicina all'SNR minimo che la radio sa demodulare: il collegamento può cedere."
        },
        "aq.marTip_sufficient": {
            en: "The weaker direction has some margin, but not a comfortable one.",
            it: "La direzione più debole ha un certo margine, ma non comodo."
        },
        "aq.marTip_good": {
            en: "The weaker direction has plenty of margin above the demodulation floor.",
            it: "La direzione più debole ha ampio margine sopra la soglia di demodulazione."
        },
        "aq.kind_mirror": {
            en: "mirror",
            it: "speculare"
        },
        "aq.kind_non_mirror": {
            en: "non-mirror",
            it: "non speculare"
        },
        "aq.kind_direct": {
            en: "direct",
            it: "diretto"
        },
        "aq.rangeSymmetric": {
            en: "Δ below {a} dB",
            it: "Δ sotto {a} dB"
        },
        "aq.rangeModerate": {
            en: "Δ {a}–{b} dB",
            it: "Δ {a}–{b} dB"
        },
        "aq.rangeAsymmetric": {
            en: "Δ above {b} dB",
            it: "Δ oltre {b} dB"
        },
        "aq.rangeCritical": {
            en: "below {a} dB",
            it: "sotto {a} dB"
        },
        "aq.rangeSufficient": {
            en: "{a}–{b} dB",
            it: "{a}–{b} dB"
        },
        "aq.rangeGood": {
            en: "{b} dB or more",
            it: "{b} dB o più"
        },
        "aq.unknownRepeater": {
            en: "unknown repeater ({hash})",
            it: "repeater sconosciuto ({hash})"
        },
        "aq.localRadio": {
            en: "local radio of {node}",
            it: "radio locale di {node}"
        },
        "aq.weekdays": {
            en: "Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday",
            it: "Lunedì,Martedì,Mercoledì,Giovedì,Venerdì,Sabato,Domenica"
        },
        "aq.weekdaysShort": {
            en: "Mon,Tue,Wed,Thu,Fri,Sat,Sun",
            it: "Lun,Mar,Mer,Gio,Ven,Sab,Dom"
        },
        "aq.colNode": {
            en: "Node",
            it: "Nodo"
        },
        "aq.colLive": {
            en: "Live file",
            it: "File corrente"
        },
        "aq.colArchives": {
            en: "Archives",
            it: "Archivi"
        },
        "aq.colRecords": {
            en: "Traces recorded",
            it: "Tracce registrate"
        },
        "aq.colOk": {
            en: "Answered",
            it: "Con risposta"
        },
        "aq.colUnusable": {
            en: "Unusable",
            it: "Non utilizzabili"
        },
        "aq.colPaths": {
            en: "Paths",
            it: "Path"
        },
        "aq.colPeriod": {
            en: "Period",
            it: "Periodo"
        },
        "aq.yes": {
            en: "yes",
            it: "sì"
        },
        "aq.no": {
            en: "no",
            it: "no"
        },
        "aq.total": {
            en: "Total",
            it: "Totale"
        },
        "aq.pathsSplit": {
            en: "{mirror} mirror, {non} non-mirror, {direct} direct",
            it: "{mirror} speculari, {non} non speculari, {direct} diretti"
        },
        "aq.hMonths": {
            en: "Traces per month (share answered)",
            it: "Tracce per mese (quota con risposta)"
        },
        "aq.colMonth": {
            en: "Month",
            it: "Mese"
        },
        "aq.monthsHelp": {
            en: "Each cell: traces recorded in the month and, in brackets, the share that got an answer.",
            it: "Ogni cella: tracce registrate nel mese e, tra parentesi, la quota che ha avuto risposta."
        },
        "aq.noteNodeError": {
            en: "Node {node}: {message}",
            it: "Nodo {node}: {message}"
        },
        "aq.noteNoTrace": {
            en: "Node {node} has no trace file yet.",
            it: "Il nodo {node} non ha ancora un file di tracce."
        },
        "aq.noteDupLegs": {
            en: "{n} paths pass twice through the same leg: the parser keeps a single SNR value for a repeated leg, so their SNR is not attributed to the links.",
            it: "{n} path passano due volte per la stessa tratta: il parser conserva un solo valore di SNR per una tratta ripetuta, quindi la loro SNR non è attribuita ai collegamenti."
        },
        "aq.noteUnresolved": {
            en: "{n} hops could not be matched to a known repeater (unknown or ambiguous hash) and are shown by their hash.",
            it: "{n} hop non associati a un repeater noto (hash sconosciuto o ambiguo), mostrati con il loro hash."
        },
        "aq.statusParams": {
            en: "Thresholds: a link is symmetric if Δ is below {symOk} dB, moderate up to {symMod} dB, asymmetric above. Margin = mean SNR of the weaker direction minus the demodulation floor ({floor} dB): critical below {marCrit} dB, good from {marGood} dB, sufficient in between. Links and cells need at least {min} samples; the time of day is grouped in bands of {bucket} hours. A path is flagged as anomaly when its margin is good but fewer than {anomaly} % of its traces get an answer.",
            it: "Soglie: un collegamento è simmetrico se Δ è sotto {symOk} dB, moderato fino a {symMod} dB, asimmetrico oltre. Margine = SNR medio della direzione più debole meno la soglia di demodulazione ({floor} dB): critico sotto {marCrit} dB, buono da {marGood} dB, sufficiente nel mezzo. Collegamenti e celle richiedono almeno {min} campioni; l'ora del giorno è raggruppata in fasce di {bucket} ore. Un path è segnalato come anomalia quando il suo margine è buono ma meno del {anomaly} % delle sue tracce riceve risposta."
        },
        "aq.summaryLine": {
            en: "<b>{measured}</b> of {pairs} links are measured in both directions with enough samples; {insufficient} have too few samples and {unmeasured} were measured in one direction only.",
            it: "<b>{measured}</b> collegamenti su {pairs} sono misurati in entrambe le direzioni con campioni sufficienti; {insufficient} hanno pochi campioni e {unmeasured} sono misurati in una sola direzione."
        },
        "aq.summaryBest": {
            en: "Symmetric and with a good margin: <b>{good}</b> of {measured} measured links.",
            it: "Simmetrici e con buon margine: <b>{good}</b> collegamenti misurati su {measured}."
        },
        "aq.sumCellTip": {
            en: "Click to list these links",
            it: "Clicca per elencare questi collegamenti"
        },
        "aq.colLink": {
            en: "Link",
            it: "Collegamento"
        },
        "aq.colNodes": {
            en: "Measured by",
            it: "Misurato da"
        },
        "aq.colAB": {
            en: "A → B (mean SNR dB)",
            it: "A → B (SNR medio dB)"
        },
        "aq.colBA": {
            en: "B → A (mean SNR dB)",
            it: "B → A (SNR medio dB)"
        },
        "aq.colSymmetry": {
            en: "Symmetry",
            it: "Simmetria"
        },
        "aq.colMargin": {
            en: "Margin",
            it: "Margine"
        },
        "aq.dirTip": {
            en: "A is the first repeater named in the row, B the second. The SNR is read by the receiver of the leg.",
            it: "A è il primo repeater nominato nella riga, B il secondo. L'SNR è letto dal ricevente della tratta."
        },
        "aq.deltaTip": {
            en: "A → B minus B → A (mean SNR)",
            it: "A → B meno B → A (SNR medio)"
        },
        "aq.sdTip": {
            en: "standard deviation {sd} dB",
            it: "deviazione standard {sd} dB"
        },
        "aq.pairedTip": {
            en: "Same-trace difference (mirror paths): mean {mean} dB, standard deviation {sd} dB, {n} traces",
            it: "Differenza nella stessa traccia (path speculari): media {mean} dB, deviazione standard {sd} dB, {n} tracce"
        },
        "aq.linksNone": {
            en: "No link matches the filters.",
            it: "Nessun collegamento corrisponde ai filtri."
        },
        "aq.linksShown": {
            en: "{shown} of {total} links shown",
            it: "{shown} collegamenti su {total}"
        },
        "aq.trendNone": {
            en: "This link has no daily series: it needs enough samples in both directions.",
            it: "Questo collegamento non ha una serie giornaliera: servono campioni sufficienti in entrambe le direzioni."
        },
        "aq.axisDay": {
            en: "Day",
            it: "Giorno"
        },
        "aq.axisMonth": {
            en: "Month",
            it: "Mese"
        },
        "aq.axisSnr": {
            en: "Mean SNR (dB)",
            it: "SNR medio (dB)"
        },
        "aq.axisDelta": {
            en: "Difference between the two directions Δ (dB)",
            it: "Differenza tra le due direzioni Δ (dB)"
        },
        "aq.colPath": {
            en: "Path",
            it: "Path"
        },
        "aq.colKind": {
            en: "Type",
            it: "Tipo"
        },
        "aq.colTraces": {
            en: "Traces",
            it: "Tracce"
        },
        "aq.colWeakest": {
            en: "Weakest leg (mean SNR)",
            it: "Tratta più debole (SNR medio)"
        },
        "aq.pathsNone": {
            en: "No path in this period.",
            it: "Nessun path in questo periodo."
        },
        "aq.dupLegs": {
            en: "repeated leg",
            it: "tratta ripetuta"
        },
        "aq.dupLegsTip": {
            en: "The path crosses the same leg twice, so its SNR values are not attributed to the links.",
            it: "Il path attraversa due volte la stessa tratta, quindi i suoi valori di SNR non sono attribuiti ai collegamenti."
        },
        "aq.anomaly": {
            en: "anomaly",
            it: "anomalia"
        },
        "aq.anomalyTip": {
            en: "Good margin but few traces answered: worth investigating.",
            it: "Buon margine ma poche tracce con risposta: da approfondire."
        },
        "aq.reachCount": {
            en: "{points} paths plotted, {rows} listed, {anomalies} flagged as anomaly.",
            it: "{points} path nel grafico, {rows} in elenco, {anomalies} segnalati come anomalia."
        },
        "aq.reachNoMargin": {
            en: "{n} have no margin yet (no leg with enough samples) and are not plotted.",
            it: "{n} non hanno ancora un margine (nessuna tratta con campioni sufficienti) e non sono nel grafico."
        },
        "aq.legendNormal": {
            en: "Paths",
            it: "Path"
        },
        "aq.axisMargin": {
            en: "Margin of the weakest leg (dB)",
            it: "Margine della tratta più debole (dB)"
        },
        "aq.axisPctOk": {
            en: "Traces answered (%)",
            it: "Tracce con risposta (%)"
        },
        "aq.guideMargin": {
            en: "margin {n} dB",
            it: "margine {n} dB"
        },
        "aq.guideOk": {
            en: "{n} % answered",
            it: "{n} % con risposta"
        },
        "aq.profileNone": {
            en: "No day and hour data for this choice (a link needs enough samples in both directions).",
            it: "Nessun dato per giorno e ora per questa scelta (un collegamento richiede campioni sufficienti in entrambe le direzioni)."
        },
        "aq.hByHour": {
            en: "By time of day",
            it: "Per fascia oraria"
        },
        "aq.hByDay": {
            en: "By weekday",
            it: "Per giorno della settimana"
        },
        "aq.hGrid": {
            en: "Weekday × time of day",
            it: "Giorno × fascia oraria"
        },
        "aq.cellFew": {
            en: "{n} samples: fewer than the minimum of {min}, so no value is shown",
            it: "{n} campioni: meno del minimo di {min}, quindi nessun valore"
        },
        "aq.cellN": {
            en: "{n} samples",
            it: "{n} campioni"
        },
        "aq.legendSnr": {
            en: "More intense blue = higher SNR (scale from the lowest to the highest value shown). A dash means fewer than {min} samples.",
            it: "Blu più intenso = SNR più alto (scala dal valore più basso al più alto mostrato). Un trattino indica meno di {min} campioni."
        },
        "aq.legendPct": {
            en: "More intense blue = more traces answered (steps of 20 %). A dash means fewer than {min} samples.",
            it: "Blu più intenso = più tracce con risposta (a passi del 20 %). Un trattino indica meno di {min} campioni."
        },
        "aq.legendDelta": {
            en: "Green: Δ below the symmetry limit; amber: moderate; red: asymmetric (limits in panel 1). A dash means fewer than {min} samples in a direction.",
            it: "Verde: Δ sotto il limite di simmetria; ambra: moderato; rosso: asimmetrico (limiti nel pannello 1). Un trattino indica meno di {min} campioni in una direzione."
        },
        "aq.crossNodeOnly": {
            en: "The comparison between nodes needs the Collector, which sees the traces of all the nodes. This Node only analyzes its own traces.",
            it: "Il confronto tra nodi richiede il Collettore, che vede le tracce di tutti i nodi. Questo Nodo analizza solo le proprie tracce."
        },
        "aq.crossNone": {
            en: "No link has been measured by more than one node in this period.",
            it: "Nessun collegamento è stato misurato da più di un nodo in questo periodo."
        },
        "aq.colSpread": {
            en: "Spread of Δ between nodes (dB)",
            it: "Dispersione di Δ tra i nodi (dB)"
        },
        "aq.few": {
            en: "few",
            it: "pochi"
        },
        "aq.fewTip": {
            en: "Fewer than {min} samples in a direction: not counted in the spread.",
            it: "Meno di {min} campioni in una direzione: non conta nella dispersione."
        }
    };

    var currentLang = null;
    var warnedKeys = {};

    function hasOwn(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    // Lettura protetta: in modalità privata o con storage bloccato
    // localStorage può lanciare; in quel caso si usa la lingua di default.
    function readStoredLang() {
        try {
            var v = root.localStorage ? root.localStorage.getItem(STORAGE_KEY) : null;
            return LANGS.indexOf(v) >= 0 ? v : null;
        } catch (err) {
            return null;
        }
    }

    function getLang() {
        if (currentLang === null) {
            currentLang = readStoredLang() || DEFAULT_LANG;
        }
        return currentLang;
    }

    // Usa la lingua indicata solo in memoria (senza salvarla): serve ai test.
    function useLang(lang) {
        if (LANGS.indexOf(lang) < 0) {
            return false;
        }
        currentLang = lang;
        return true;
    }

    // Usa e ricorda la lingua indicata.
    function setLang(lang) {
        if (!useLang(lang)) {
            return false;
        }
        try {
            if (root.localStorage) {
                root.localStorage.setItem(STORAGE_KEY, lang);
            }
        } catch (err) {
            // la scelta vale comunque fino al ricaricamento della pagina
        }
        return true;
    }

    function escapeText(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    // Marcatore per un parametro che è già HTML sicuro (solo per tlh).
    function RawHtml(markup) {
        this.markup = String(markup);
    }

    function html(markup) {
        return new RawHtml(markup);
    }

    function lookup(key) {
        if (!hasOwn(MESSAGES, key)) {
            if (!warnedKeys[key] && root.console && root.console.warn) {
                warnedKeys[key] = true;
                root.console.warn("i18n: chiave mancante '" + key + "'");
            }
            return key;
        }
        var entry = MESSAGES[key];
        var text = entry[getLang()];
        if (typeof text !== "string") {
            text = entry.en;
        }
        return typeof text === "string" ? text : key;
    }

    function fill(text, params, escapeParams) {
        if (!params) {
            return text;
        }
        return text.replace(/\{([A-Za-z0-9_]+)\}/g, function (whole, name) {
            if (!hasOwn(params, name)) {
                return whole;
            }
            var v = params[name];
            if (v instanceof RawHtml) {
                return v.markup;
            }
            v = (v === null || v === undefined) ? "" : String(v);
            return escapeParams ? escapeText(v) : v;
        });
    }

    function tl(key, params) {
        return fill(lookup(key), params, false);
    }

    function tle(key, params) {
        return escapeText(tl(key, params));
    }

    function tlh(key, params) {
        return fill(lookup(key), params, true);
    }

    function pluralParams(n, params) {
        var p = {};
        if (params) {
            for (var k in params) {
                if (hasOwn(params, k)) {
                    p[k] = params[k];
                }
            }
        }
        p.n = n;
        return p;
    }

    function tln(key, n, params) {
        return tl(key + (n === 1 ? ".one" : ".other"), pluralParams(n, params));
    }

    function tlne(key, n, params) {
        return escapeText(tln(key, n, params));
    }

    function tlnh(key, n, params) {
        return tlh(key + (n === 1 ? ".one" : ".other"), pluralParams(n, params));
    }

    // Traduce gli elementi statici di index.html (e la lingua del documento).
    function applyStatic(doc) {
        doc = doc || root.document;
        if (!doc || !doc.querySelectorAll) {
            return;
        }
        var i, el, list;

        list = doc.querySelectorAll("[data-i18n]");
        for (i = 0; i < list.length; i++) {
            el = list[i];
            el.textContent = tl(el.getAttribute("data-i18n"));
        }

        list = doc.querySelectorAll("[data-i18n-html]");
        for (i = 0; i < list.length; i++) {
            el = list[i];
            el.innerHTML = tlh(el.getAttribute("data-i18n-html"));
        }

        list = doc.querySelectorAll("[data-i18n-attr]");
        for (i = 0; i < list.length; i++) {
            el = list[i];
            var pairs = el.getAttribute("data-i18n-attr").split(";");
            for (var j = 0; j < pairs.length; j++) {
                var sep = pairs[j].indexOf(":");
                if (sep > 0) {
                    el.setAttribute(
                        pairs[j].slice(0, sep).trim(),
                        tl(pairs[j].slice(sep + 1).trim())
                    );
                }
            }
        }

        if (doc.documentElement) {
            doc.documentElement.setAttribute("lang", getLang());
        }
    }

    // Selettore a bandierine: evidenzia la lingua attiva e, al click su
    // un'altra, la salva e ricarica la pagina (tabelle, tooltip, grafici e
    // mappe vengono così ridisegnati tutti nella nuova lingua).
    function bindLangSelector(doc) {
        doc = doc || root.document;
        if (!doc || !doc.querySelectorAll) {
            return;
        }
        var flags = doc.querySelectorAll(".lang-flag[data-lang]");
        for (var i = 0; i < flags.length; i++) {
            (function (flag) {
                var lang = flag.getAttribute("data-lang");
                var active = lang === getLang();
                if (flag.classList) {
                    flag.classList.toggle("active", active);
                }
                flag.setAttribute("aria-pressed", active ? "true" : "false");
                flag.addEventListener("click", function () {
                    if (lang !== getLang()) {
                        setLang(lang);
                        root.location.reload();
                    }
                });
            })(flags[i]);
        }
    }

    var api = {
        MESSAGES: MESSAGES,
        LANGS: LANGS,
        DEFAULT_LANG: DEFAULT_LANG,
        getLang: getLang,
        setLang: setLang,
        useLang: useLang,
        html: html,
        tl: tl,
        tle: tle,
        tlh: tlh,
        tln: tln,
        tlne: tlne,
        tlnh: tlnh,
        applyStatic: applyStatic,
        bindLangSelector: bindLangSelector
    };

    root.I18N = api;
    root.tl = tl;
    root.tle = tle;
    root.tlh = tlh;
    root.tln = tln;
    root.tlne = tlne;
    root.tlnh = tlnh;

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }

    // i18n.js viene caricato in fondo al body: gli elementi statici sono
    // già presenti, quindi si traduce subito (niente lampo in inglese).
    // Se invece il body non esistesse ancora si attende DOMContentLoaded.
    if (root.document) {
        var start = function () {
            applyStatic(root.document);
            bindLangSelector(root.document);
        };
        if (root.document.body || root.document.readyState !== "loading") {
            start();
        } else {
            root.document.addEventListener("DOMContentLoaded", start);
        }
    }

})(typeof window !== "undefined" ? window : globalThis);
