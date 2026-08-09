# trace-mon — documento tecnico di architettura

> Documento vivo. Aggiornalo (o fai aggiornare a Claude) ogni volta che si
> prende una decisione architetturale, si scopre un vincolo della libreria,
> o si conclude una fase. Vedi la sezione finale "Come usare questo
> documento con Claude Code" per il meccanismo di persistenza tra sessioni.

Ultimo aggiornamento: 2026-08-08

---

## 1. Obiettivo del progetto

`trace-mon` gira su un Raspberry Pi (`rpi4b`, utente `meshcore`) e serve a
monitorare una rete MeshCore LoRa. Ha due macro-funzioni:

1. **Trace periodico** (esistente, oggi implementato via `meshcore-cli`):
   esegue trace di rotta su percorsi predefiniti, scrive i risultati in
   `data/trace.json`, che viene letto da un frontend Node.js
   (`server.js`, `parser.js`, `public/`) per grafici e tabelle.
2. **Bot su canale** (da realizzare): un servizio che ascolta i messaggi
   in arrivo su un canale MeshCore e risponde — richiede un processo
   **residente** con connessione permanente al device.

L'obiettivo di questa fase è **sostituire `meshcore-cli` con l'uso diretto
di `meshcore_py`**, ristrutturando il progetto in un'architettura a
**daemon + servizi pluggable**, perché device seriale/BLE (e di fatto
anche TCP) permettono **una sola connessione attiva alla volta** — quindi
trace, bot e qualsiasi altro servizio futuro devono condividere un'unica
connessione gestita da un processo permanente.

## 2. Bug critico nell'implementazione precedente

L'implementazione precedente (trace/advert/system funzionanti) **non
gestiva correttamente le disconnessioni accidentali**: quando il device si
disconnetteva, il daemon non se ne accorgeva, e i servizi credevano di
aver completato il lavoro (nessun errore, nessun timeout rilevato
correttamente). Questo è il problema principale da risolvere nella
riscrittura, non una feature accessoria — va trattato come requisito di
correttezza fin dal disegno del connection manager, non aggiunto dopo.

## 3. Analisi di `meshcore_py` (libreria di riferimento)

Repo: https://github.com/meshcore-dev/meshcore_py

- **Un'istanza `MeshCore` = una connessione fisica.** Creata con
  `MeshCore.create_tcp(host, port, ...)`, `create_serial(port, baud, ...)`
  o `create_ble(address, ...)`. Non è pensata per essere condivisa tra
  processi diversi — va posseduta da un solo processo (il daemon).
- **Tutti i comandi sono metodi async** sotto `meshcore.commands.*` e
  restituiscono un oggetto `Event` con `.type` (un `EventType`) e
  `.payload`. Verificare sempre `result.type == EventType.ERROR`.
- **Due stili combinabili**: comandi request/response (`await
  meshcore.commands.X()`) ed event-driven (`meshcore.subscribe(event_type,
  callback, attribute_filters=...)`). Entrambi operano sulla stessa
  connessione condivisa — più servizi possono sottoscrivere eventi diversi
  senza conflitto.
- **Auto-reconnect nativo**: `create_tcp(..., auto_reconnect=True,
  max_reconnect_attempts=N)` con backoff esponenziale (1s, 2s, 4s, 8s max).
  Emette eventi `EventType.CONNECTED` / `EventType.DISCONNECTED`
  (payload include motivo disconnessione ed eventuale
  `max_attempts_exceeded`). **Questo è il meccanismo su cui va costruita
  la correzione del bug del punto 2** — il connection manager deve
  sottoscrivere questi eventi e propagare lo stato reale ai servizi,
  invece di assumere che ogni comando vada sempre a buon fine.
- **`is_connected`** (proprietà booleana) va controllata esplicitamente
  prima di ogni operazione critica, non solo affidata all'auto-reconnect.
- **`send_trace`** (comando rilevante per `TraceService`):
  ```python
  async def send_trace(auth_code: int = 0, tag: Optional[int] = None,
                        flags = None,
                        path: Optional[Union[str, bytes, bytearray]] = None) -> Event
  ```
  - Ritorna **subito** `MSG_SENT` (con `expected_ack`,
    `suggested_timeout`) — è solo la conferma di invio del pacchetto di
    trace, **non** il risultato.
  - Il risultato vero arriva **in modo asincrono** come evento separato
    `EventType.TRACE_DATA` — va atteso con
    `await meshcore.wait_for_event(EventType.TRACE_DATA, timeout=...)`.
  - `path`: stringa comma-separated di hash hex (es. `"0d28,8dbb,0d28"`).
    Se omesso → trace in flood, `tag` generato casualmente.
  - `flags`: bit 0-1 codificano la dimensione dell'hash (0=1 byte, 1=2
    byte, 2=4 byte, 3=8 byte). Con hash a 2 caratteri hex (1 byte, es.
    `0d28` è in realtà 2 byte → `flags=1`) confermato empiricamente
    dall'output reale (vedi §6).
- **Payload di `TRACE_DATA`** (confermato da output reale prodotto da
  `meshcore-cli -j`, che si limita a serializzare il payload
  dell'evento):
  ```json
  {
    "tag": 288195332,
    "auth": 0,
    "flags": 1,
    "path_len": 3,
    "path": [
      {"hash": "0d28", "snr": 7.0},
      {"hash": "8dbb", "snr": -1.25},
      {"hash": "0d28", "snr": 1.5},
      {"snr": 12.0}
    ]
  }
  ```
  L'ultimo elemento di `path` non ha `hash` (è il rientro verso il nodo
  locale). Questo formato **deve essere preservato esattamente** per
  compatibilità con il frontend Node.js esistente.

## 4. Analisi di `meshcore-cli` (implementazione da sostituire)

Repo: https://github.com/meshcore-dev/meshcore-cli

- Dipende da `meshcore_py`, aggiunge CLI/interattività/scripting sopra.
- Il comando `trace <path>` (alias `tr`) chiama `send_trace` e attende
  `TRACE_DATA`; senza `<path>` esegue trace in flood.
- Con `-j` produce output JSON puro (quello che oggi finisce in
  `trace.json`).
- **Ogni invocazione CLI apre una connessione propria** — è proprio
  questo il motivo per cui lo script bash attuale (un processo CLI per
  ogni path, con `sleep 10` tra uno e l'altro) non può coesistere con un
  bot residente: aprirebbero connessioni concorrenti sullo stesso device.

## 5. Struttura del progetto (stato attuale)

```
trace-mon/
  advert.sh, floodadv.sh, backup.sh, sync-meshnode.sh, trace.sh   # wrapper bash esistenti (da valutare se dismettere)
  bootstrap.py
  main_trace.py                # entrypoint trace attuale
  mesh-nodes.json              # mappa nodi rete (da capire se usata a runtime)
  requirements.txt
  clients/
    ipc_client.py              # già esiste un client IPC — verificare protocollo attuale
  core/
    config.py, engine.py, logger.py, __init__.py
  mesh_modules/
    advert/, system/, trace/   # moduli precedenti per servizio
  services/
    context.py, daemon.py, dispatcher.py, ipc_server.py, loader.py
  tools/
    send_advert.py, send_floodadv.py, test_ping.py, test_trace.py
  config/                      # contiene config.yaml (vedi §7)
  data/                        # trace.json e altri output
  logs/
  backup/
  run/                         # presumibilmente socket/pid file
  systemd/                     # unit file
  experiments/
  server.js, parser.js, package.json, public/, node_modules/   # frontend Node.js
```

**Punto importante**: esiste già uno scheletro `daemon.py` +
`ipc_server.py` + `dispatcher.py` + `loader.py` sotto `services/`, e un
`ipc_client.py` sotto `clients/`. **Prima di riscrivere da zero, va fatta
una code review di questi file** per decidere se:
(a) riutilizzarli come base e correggere il bug di disconnessione, oppure
(b) ripartire da zero seguendo la struttura discussa in questa chat
    (`core/connection.py`, `core/service_base.py`, `core/ipc.py`, ecc.)

Questa è una **decisione aperta**, non ancora presa — vedi §9.

## 6. Esempio reale di output (comportamento da preservare)

Dal file `data/trace.json` prodotto oggi dallo script bash + cron:

```
20260806_073001 0d28,b3de,0d28
{"error": "timeout waiting trace"}
20260806_073025 0d28,8dbb,0d28
{
  "tag": 288195332,
  "auth": 0,
  "flags": 1,
  "path_len": 3,
  "path": [
    {"hash": "0d28", "snr": 7.0},
    {"hash": "8dbb", "snr": -1.25},
    {"hash": "0d28", "snr": 1.5},
    {"snr": 12.0}
  ]
}
```

Formato: riga `YYYYMMDD_HHMMSS <path>`, seguita da JSON compatto per gli
errori/timeout, JSON con `indent=2` per i successi. Il frontend Node.js
(`parser.js`) legge questo formato — **qualsiasi backend nuovo deve
produrlo identico**, salvo decisione esplicita di cambiare anche il
parser.

## 7. Configurazione esistente (`config/config.yaml`)

```yaml
connection:
  type: tcp
  tcp: {host: mesh-tracer.lan.crlnet072.it, port: 5000}
  serial: {device: /dev/remote-term, baudrate: 115200}
  ble: {address: AA:BB:CC:DD:EE:FF}
trace:
  enabled: true
  output_file: data/trace.json
  interval: 10        # significato da confermare: pausa tra trace? intervallo di scheduling?
  timeout: 15
  backup: true         # comportamento non ancora specificato
  paths: [...]
bot:
  enabled: false
logging:
  level: INFO
  file: logs/trace-mon.log
  console: false
services:
  - {name: system, enabled: true, module: system.service, class: SystemService}
  - {name: trace,  enabled: true, module: trace.service,  class: TraceService}
  - {name: advert, enabled: true, module: advert.service, class: AdvertService}
```

Nota: la convenzione `module: trace.service` implica pacchetti tipo
`trace/service.py` — leggermente diversa dal layout `mesh_modules/trace/`
già presente. Da allineare quando si decide il punto §5.

## 8. Architettura decisa (in questa fase di progettazione)

**Principio cardine**: un solo processo (il daemon) possiede l'istanza
`MeshCore`. Nessun altro processo si connette mai direttamente al device.

- **Connection manager** (nel daemon): crea la connessione in base a
  `connection.type`, gestisce `auto_reconnect`, sottoscrive
  `CONNECTED`/`DISCONNECTED` e mantiene uno stato di connessione
  interrogabile dagli altri componenti — **questo è il pezzo che risolve
  il bug del punto 2**.
- **Service registry**: carica dinamicamente i servizi da
  `services:` in config, ciascuno con un'interfaccia comune
  (`setup()`/`start()`/`stop()`/eventuale `handle_command()`), tutti
  condividono la stessa istanza `MeshCore`.
- **IPC server**: **unix domain socket**, protocollo JSON **una riga per
  messaggio** (newline-delimited), niente dipendenze esterne. Permette a
  processi esterni (cron, CLI) di chiedere al daemon di eseguire
  un'azione, senza che aprano una propria connessione al device.

### Decisioni per singolo servizio

| Servizio | Trigger | Note |
|---|---|---|
| `TraceService` | **Solo IPC** (comando esplicito) | Nessuno scheduler interno — il cron resta l'unico trigger, per scelta esplicita dell'utente. Il servizio implementa la logica di §3/§6, scrive `trace.json` da solo (unica fonte di verità). |
| `AdvertService` | Candidato a scheduling interno al daemon | Non richiede trigger esterno per natura, ma la decisione finale non è ancora stata presa — verificare comportamento attuale in `mesh_modules/advert/` prima di implementare. |
| `SystemService` | Su richiesta IPC (es. `system.status`) | Utile come primo test end-to-end del daemon (verifica che sia vivo e connesso) prima ancora di portare `TraceService`. |
| `BotService` (futuro) | Event-driven puro | Si iscrive a `CHANNEL_MSG_RECV`/`CONTACT_MSG_RECV` via `meshcore.subscribe()`. Nessun bisogno di IPC in ingresso. È il motivo strutturale per cui serve un daemon residente. |

### Protocollo IPC

- Trasporto: **unix domain socket**, path configurabile
  (`daemon.socket_path` in `config.yaml`), permessi ristretti (0600 o
  gruppo dedicato).
- Framing: un oggetto JSON per riga.
- Richiesta: `{"service": "trace", "command": "run", "args": {}}`
- Risposta OK: `{"ok": true, "result": {...}}`
- Risposta errore: `{"ok": false, "error": "..."}`
- Timeout lato client: proporzionale a `trace_timeout * n_paths +
  margine`, per non bloccare cron indefinitamente.

## 9. Decisioni aperte (da chiudere prima o durante l'implementazione)

- [x] **Riuso vs riscrittura**: risolto in §11 — riuso confermato, fix
      mirati invece di riscrittura completa.
- [x] Significato di `trace.interval`: chiarito — pausa tra un path e
      il successivo nello stesso batch (§20).
- [x] `trace.backup`: chiarito dall'utente — non è letto/gestito dal
      codice Python (`TraceWriter` non lo consulta). Il backup mensile
      è un processo **esterno**, uno script bash (`backup.sh`) separato
      su cron: il primo giorno del mese copia `data/trace.json` in
      `backup/` e ripulisce il file per ripartire da zero. Il campo
      in `config.yaml` è vestigiale, fuori dallo scope del backend
      Python.
- [x] `node: node_01`: chiarito dall'utente — identifica questo nodo
      di acquisizione in un'infrastruttura multi-nodo: ogni volta che
      `trace.sh` esegue un run, `trace.json` viene copiato (via script
      esterno, es. `sync-meshnode.sh`) su un server centrale che
      aggrega le tracce di più nodi (`node01`, `node02`, ...) dietro un
      unico frontend, non esposto su internet. Non riguarda il
      contenuto/formato di `trace.json` prodotto dal backend Python,
      solo la sua distribuzione a valle.
- [x] Path del socket IPC: `run/trace-mon.sock`, gestito con pulizia
      automatica di eventuali socket orfani allo start (§20).
- [x] `AdvertService`: resta trigger-based via IPC/cron, nessuno
      scheduling interno — confermato in §20, coerente col resto.
- [x] Strategia di test: di fatto risolta sul campo — ogni fix è stato
      validato con test reali sul Raspberry prima di considerarlo
      chiuso (vedi §12, §13, checklist di regressione).

## 10. Roadmap

1. Code review di `services/` e `mesh_modules/` esistenti → decidere §9.
2. Scheletro daemon: connection manager con gestione corretta di
   connect/reconnect/disconnessione (fix del bug §2), config loader YAML,
   logging, service loader — senza servizi reali, solo per validare che
   resti su e rilevi correttamente le disconnessioni.
3. IPC minimale con comando `system.status` come primo test end-to-end.
4. Porta/riscrivi `TraceService`, con IPC (`trace.run`), preservando il
   formato di `trace.json` (§6).
5. Sostituisci il cron attuale con un client IPC minimale; verifica
   parità di output col sistema attuale.
6. `AdvertService` (decisione su trigger da §9).
7. `BotService` (event-driven, primo vero banco di prova del modello a
   daemon residente).
8. Systemd unit per il daemon (auto-restart, log).

---

## 11. Code review dell'implementazione esistente (2026-08-06)

Analizzato il tar con l'implementazione già realizzata. **Verdetto: non
serve ripartire da zero.** L'impianto (`daemon.py`, `dispatcher.py`,
`loader.py`, `ipc_server.py`, `clients/ipc_client.py`) è coerente con
l'architettura decisa nelle sezioni precedenti — protocollo IPC via unix
socket/JSON-line, `TraceEngine` lato cron che parla solo via IPC, mai
connessione diretta al device dal client. La riscrittura va mirata alle
cause del bug §2, individuate con precisione:

**Causa 1 — nessuna riconnessione mai attiva.** `core/engine.py` crea la
connessione senza `auto_reconnect=True` e non si iscrive mai a
`EventType.CONNECTED`/`DISCONNECTED`. Esiste `Engine.reconnect()` con
meccanismo di rebind (`register_rebind`), ma è **codice morto** — nessun
servizio lo richiama né si registra.

**Causa 2 — riferimento alla connessione congelato allo startup.**
`services/context.py` cattura `mesh=self.engine.mesh` una sola volta al
boot (commento originale: "mantenuta per compatibilità durante la
migrazione dei moduli" — mai risolto). `TraceService`/`AdvertService`
catturano a loro volta questo riferimento nel costruttore
(`mesh_modules/trace/trace.py`, `mesh_modules/advert/advert.py`). Anche
con un `reconnect()` funzionante, i servizi già caricati continuerebbero
a operare sul vecchio oggetto `MeshCore` scartato.

**Causa 3 — comandi "fire and forget" senza conferma reale.**
`send_advert()` restituisce `OK` che conferma solo l'accodamento locale
del comando, non l'effettiva trasmissione. Su TCP morto ma non ancora
rilevato (nessun RST ricevuto), la write locale può avere successo
silenziosamente — `AdvertService.execute()` interpreta questo come pieno
successo. **Questa è la causa diretta di "i servizi pensavano di aver
svolto il lavoro".** `TraceService` non ne soffre allo stesso modo
(conferma reale via `TRACE_DATA` con timeout), ma resta esposto alle
cause 1 e 2.

**Causa 4 (minore) — nessun health-check reale.** `SystemService` espone
solo `ping` (verifica l'IPC, non la connessione al device).

### Interventi mirati necessari (sostituiscono il punto §9 "riuso vs
riscrittura" — decisione presa: riuso con fix mirati)

1. Riscrivere `core/engine.py`: `auto_reconnect=True` +
   `max_reconnect_attempts`, sottoscrizione a `CONNECTED`/`DISCONNECTED`
   con stato interrogabile in tempo reale (non solo allo startup).
2. Eliminare il riferimento "congelato" — `ServiceContext` non deve più
   esporre `mesh` come attributo statico: i moduli (`TraceModule`,
   `AdvertModule`) devono leggere `context.engine.mesh` dinamicamente a
   ogni comando, mai tenerne una copia locale in `__init__`.
3. Verificare `engine.connected` (o equivalente) **prima** di ogni
   dispatch di comando, non fidarsi del solo esito del comando stesso.
4. Estendere `SystemService` con un comando reale (es. `status`) che
   riporti lo stato vero della connessione al device, non solo la
   vivacità dell'IPC.
5. Rivalutare `AdvertService`: dato che `send_advert` non ha conferma
   nativa equivalente a `TRACE_DATA`, valutare se serve un controllo
   aggiuntivo (es. verifica `is_connected` post-invio, o un
   comando di verifica leggero) per non ripetere il falso positivo.

### Nota sul formato di `trace.json`

`mesh_modules/trace/writer.py` usa sempre `json.dump(..., indent=2)`,
**anche per gli errori** — a differenza del formato storico osservato
(§6) dove gli errori erano su riga singola compatta
(`{"error": "timeout waiting trace"}`). Questa è già una implementazione
nuova (non lo script bash storico), quindi la divergenza è probabilmente
intenzionale/accettabile — da confermare con l'utente se il frontend
Node.js (`parser.js`) gestisce correttamente entrambi i formati o se va
allineato.

---

## 12. Stato implementazione fix (aggiornato 2026-08-06)

Interventi da §11 completati e **testati con successo sul Raspberry**:

- [x] `core/engine.py` riscritto: `auto_reconnect=True`, sottoscrizione
      `CONNECTED`/`DISCONNECTED`, recovery loop per l'esaurimento
      dell'auto-reconnect nativo.
      **Test 1** (device disconnesso a rete): `send_trace()` ha
      restituito subito `EventType.ERROR` (`no_event_received`),
      timeout gestito correttamente, nessun falso positivo.
      **Test 2** (rete ripristinata): evento `CONNECTED` con
      `reconnected: true`, trace successivo completato regolarmente —
      confermato che l'auto-reconnect nativo mantiene la stessa
      istanza `MeshCore` (nessuna ricreazione necessaria in questo
      caso).
- [x] `services/context.py`: non espone più `mesh` staticamente, solo
      `engine`.
- [x] `mesh_modules/trace/trace.py` + `service.py`: `TraceModule` legge
      `engine.mesh` dinamicamente, si registra con
      `engine.register_rebind()`, controlla `engine.connected` prima
      dell'invio, non attende il timeout completo se `send_trace()`
      torna già `ERROR`.
- [x] `mesh_modules/advert/advert.py` + `service.py`: stesso pattern
      (lettura dinamica di `engine.mesh`, controllo pre-invio). Nota:
      `send_advert()` resta senza conferma di consegna reale
      equivalente a `TRACE_DATA` — il rischio di falso positivo è
      ridotto ma non eliminato del tutto.
      **Test 3** (caso limite, il più significativo): batch di 3 trace
      in corso, connessione interrotta a metà, poi ripristinata — il
      sistema ha atteso la riconnessione reale ed eseguito
      correttamente l'ultimo dei 3 trace, **senza falsi positivi**.
      Valida sia il recovery loop di `Engine` sia il meccanismo di
      rebind end-to-end.

Non ancora affrontato:

- [x] Causa 4: aggiunto comando `status` (minimale: `{"connected": bool}`)
      a `mesh_modules/system/service.py`, più `tools/test_status.py`
      sullo stile di `tools/test_ping.py` per interrogarlo da riga di
      comando. **Fase di fix mirati (cause 1-4) completata e testata
      sul Raspberry.**
- [ ] `services/daemon.py`: unica modifica necessaria per coerenza con
      `context.py` è la costruzione di `ServiceContext` senza il
      parametro `mesh` — già applicata.

## 13. Secondo giro di fix: disconnessioni "silenziose" (2026-08-06)

Durante i test di regressione della fase precedente è emerso uno
scenario **non coperto** dai fix del punto §12: una disconnessione
"silenziosa" (rete a terra senza RST TCP, es. cavo/rotta rimossi senza
segnale esplicito) non viene rilevata **né** dagli eventi nativi
`CONNECTED`/`DISCONNECTED` **né** da `mesh.is_connected` — la libreria
non ha modo di accorgersene finché non tenta attivamente di usare la
connessione. Solo il comando in corso (`send_advert`, `send_trace`) lo
scopriva tramite il proprio timeout locale (`no_event_received`), ma
quell'informazione non veniva mai propagata allo stato globale
dell'`Engine` → falso positivo confermato anche su `system.status`.

**Fix applicati:**

- **Health-check attivo** in `core/engine.py`: task periodico
  (`heartbeat_interval`, default 15s) che chiama `get_bat()` — comando
  leggero, query locale al companion, **nessun traffico radio LoRa** —
  con timeout breve (`heartbeat_timeout`, default 5s). Se fallisce,
  marca `_connected = False` e avvia lo stesso recovery loop già
  esistente.
- **`Engine.report_possible_failure()`**: richiamato da
  `TraceModule`/`AdvertModule` quando **il comando stesso**
  (`send_trace`/`send_advert`) fallisce con un errore sul link locale
  al companion — forza una verifica immediata invece di aspettare il
  prossimo ciclo di heartbeat. **Non** viene richiamato per il timeout
  su `TRACE_DATA` (quello resta un esito radio normale — un path
  irraggiungibile non implica nulla sul link locale device↔host).
- **Bug secondario individuato durante i test**: due meccanismi di
  rilevamento indipendenti (evento nativo + heartbeat) potevano
  scatenare due cicli di recovery quasi simultanei, con doppia
  ricreazione della connessione. Risolto blindando `Engine.reconnect()`
  con un `asyncio.Lock()` — la ricreazione fisica avviene una sola
  volta per ciclo di guasto, qualunque sia il trigger.
- Corretto anche un log fuorviante in `AdvertModule` (stampava
  "completed" anche sugli esiti `ERROR" — solo cosmetico, il
  comportamento funzionale/IPC era già corretto).

**Nuovi parametri di config** (opzionali, con default via
`config.get`): `connection.heartbeat_interval` (15s),
`connection.heartbeat_timeout` (5s).

**Test di regressione superati sul Raspberry:**
- Disconnessione silenziosa rilevata entro `heartbeat_interval`,
  recovery avviato automaticamente senza intervento manuale.
- Un solo ciclo di reconnect anche col doppio trigger — verificato
  nei log (nessuna doppia sequenza "Rebinding").
- Tentativo di reconnect fallito per rete ancora giù
  (`OSError: Connect call failed`) correttamente ritentato
  all'intervallo successivo, senza propagare l'eccezione al daemon.

Restano da ritestare esplicitamente con questa versione: scenario
advert/system.status con la disconnessione silenziosa (già verificati
prima del fix dell'health-check, da confermare ora che è attivo), e il
batch trace con doppia interruzione (checklist già proposta in
precedenza).

**Aggiornamento (2026-08-06): checklist di regressione completata e
superata sul Raspberry.**

- `system.status` con rete off: heartbeat rileva il guasto, recovery
  loop parte, `status` risponde correttamente `connected: false`
  durante tutta la finestra di disconnessione.
- `advert` con rete off: comando fallisce con errore locale
  (`no_event_received`), `report_possible_failure()` trova un recovery
  già in corso (avviato dall'heartbeat) e non duplica nulla — un solo
  rebind.
- Batch trace con interruzione a metà (scenario reale, non
  artificiale): **osservata per la prima volta la coesistenza corretta
  tra auto-reconnect nativo e recovery loop custom** — l'auto-reconnect
  nativo ripristina la connessione prima che scada il timer del
  recovery loop; quando quest'ultimo si sveglia comunque, il controllo
  "connessione già ripristinata" in `reconnect()` lo rileva e non fa
  nulla. Sui 3 trace del batch: 1 successo pre-guasto, 1 errore locale
  genuino (connessione giù), 1 timeout su `TRACE_DATA` post-ripristino
  (esito radio normale, correttamente **non** trattato come guasto di
  connessione — il path era semplicemente irraggiungibile in quel
  momento). Nessun falso positivo, nessuna doppia riconnessione.

**Fase di gestione connessione (cause 1-4 + disconnessioni silenziose)
considerata chiusa e validata in produzione.**

## 14. Esperimenti su ricezione/invio canale (2026-08-06)

Script sperimentali (`experiments/exp01_channel_receive.py`,
`experiments/exp02_channel_send.py`) — **da eseguire sempre a daemon
fermo**, dato che aprono una propria connessione indipendente e
andrebbero in conflitto con quella del daemon (stesso vincolo di
sempre: un solo consumatore alla volta sulla connessione al
companion). Verificato empiricamente: se lanciati col daemon attivo,
le due connessioni si scalzano a vicenda in loop continuo.

**Risultati confermati:**

- **`CHANNEL_MSG_RECV` da solo è sufficiente** — la deduplica dei
  pacchetti ricevuti più volte per strade diverse (es. 0-hop diretto +
  ripetuto da un repeater) è già gestita a monte: nello stesso test,
  due `RX_LOG_DATA` con lo stesso `pkt_hash` (uno diretto, uno via
  path `0d28`) hanno prodotto **un solo** `CHANNEL_MSG_RECV`. Non serve
  `set_decrypt_channel_logs(True)` né sottoscrivere `RX_LOG_DATA`: solo
  rumore diagnostico in più, non necessario per la logica del bot.
- **`CHANNEL_MSG_RECV` porta già RSSI/SNR/path/path_len** nel proprio
  payload — non serve incrociarlo con `RX_LOG_DATA` per avere questi
  dati nelle risposte del bot.
- **Formato testo confermato**: `"<nome mittente>: <messaggio>"` (es.
  `"Base-IK2XYP-Armando: T1"`), non verificato crittograficamente —
  chiunque abbia la chiave del canale può firmarsi con qualsiasi nome.
- **Nessun eco**: un messaggio inviato da `Vigevano-Tracciatore`
  (il device del daemon) su `#bot` **non torna indietro** come
  `CHANNEL_MSG_RECV` sullo stesso device. Confermato con
  `exp02_channel_send.py` (invio + 15s di ascolto, nessun evento).
  **Nessun filtro anti-loop necessario** per le risposte del bot sul
  canale.
- **Comando di invio**: `send_chan_msg(channel_idx: int, msg: str) ->
  Event` (`OK` su successo).
- **DM (`CONTACT_MSG_RECV`)** — verificato empiricamente (2026-08-06,
  `experiments/exp03_dm_receive.py`), comportamento **sostanzialmente
  diverso** dal caso canale:
  - **Nessuna deduplica automatica dei tentativi di invio**: lo stesso
    messaggio logico (stesso `sender_timestamp`, stesso testo) è
    arrivato **tre volte** come `CONTACT_MSG_RECV` distinti durante i
    retry del mittente prima dell'ACK — ogni tentativo ha un
    `pkt_hash` diverso (il contatore di tentativo altera il testo in
    chiaro prima della cifratura, quindi il pacchetto radio cambia a
    ogni retry). La deduplica vista per i canali funziona solo su
    pacchetti realmente identici (stesso `pkt_hash`, es. via ripetitore
    diverso) — **non** su retry semanticamente identici. **Il
    `BotService` deve implementare da sé la deduplica per i DM** (es.
    chiave `pubkey_prefix` + `sender_timestamp` + testo).
  - **`path_len` resta 0** per tutta la sessione di test, anche dopo il
    passaggio flood→direct osservato lato mittente — non è una lista
    di hop utilizzabile, è più un flag di modalità (comportamento non
    disambiguabile del tutto in laboratorio a corto raggio).
  - **Il passaggio flood→direct è confermato visibile**, ma come
    pacchetto a sé stante (`payload_typename: PATH`, il "returned
    path" della documentazione — visibile solo in `RX_LOG_DATA`, con
    `route_typename` che passa da `TC_FLOOD` a `DIRECT`), non come
    campo del messaggio ricevuto. Ipotesi da verificare in seguito:
    probabilmente riflesso nello stato del contatto (`get_contacts()`),
    non nel messaggio.
  - **Conseguenza sullo scope**: la v1 del `BotService` copre solo il
    canale `#bot` (dove `path` nel messaggio è affidabile e diretto).
    I DM sono rimandati a una fase successiva dedicata, per via della
    dedup mancante e del meccanismo di path separato da esplorare.

**Vincolo di banda** (da `docs.meshcore.io/packet_format`): payload
pacchetto max **184 byte** (`MAX_PACKET_PAYLOAD`) — le risposte del
bot devono avere un limite esplicito di lunghezza, mai affidarsi al
fatto che "di solito ci sta".

## 15. BotService — implementazione e refactor a comandi pluggable (2026-08-06)

**v1 implementata e testata**: `BotModule` in ascolto su `#bot`,
comando `!path` funzionante end-to-end, incluso il riconoscimento e
riapplicazione dello scope regionale (vedi §16).

**Refactor a comandi pluggable**, su richiesta esplicita per
prepararsi a comandi futuri senza intrecciare logiche diverse nello
stesso file:

```
mesh_modules/bot/
  bot.py                    # SOLO infrastruttura: connessione, rebind,
                             # correlazione scope, dispatch, invio/troncamento
                             # di sicurezza — non conosce alcun comando specifico
  region_resolver.py         # invariato
  commands/
    base.py                  # interfaccia BotCommand
    context.py                # CommandContext (engine, channel, payload,
                               # sender_name, region, reply_budget)
    registry.py                # COMMANDS = {name: istanza}, unico punto di
                                # registrazione
    path.py                    # PathCommand
    ping.py                    # PingCommand
```

**Contratto**: ogni comando riceve un `CommandContext` già pronto
(mittente estratto, scope risolto, budget di caratteri già al netto
del prefisso `@[nome] `) e ritorna solo il contenuto testuale della
risposta — prefisso, scope e troncamento di sicurezza restano
centralizzati in `BotModule`, uguali per tutti i comandi.

**Aggiungere un comando** = un file nuovo in `commands/` + una riga in
`registry.py`. Nessun altro file va toccato.

**Verificato con un secondo comando reale** (`!ping`, risponde
`pong RSSI:<val> SNR:<val>` letti da `ctx.payload`): funzionante al
primo tentativo, prefisso/scope/invio ereditati correttamente dalle
parti comuni senza alcuna modifica a `bot.py`.

## 16. Flood-scope regionale nelle risposte del bot (2026-08-06)

Requisito: il bot deve rispondere usando lo **stesso scope regionale**
(es. `it-lom-pv`) con cui è arrivato il messaggio, non lo scope di
default del device.

**Meccanismo del firmware** (confermato leggendo il codice sorgente di
un altro progetto meshcore_py in produzione, `jkingsman/Remote-
Terminal-for-MeshCore`, `app/region_resolver.py` — non solo
documentazione):

```
key  = SHA256("#" + nome_regione)[:16]
code = HMAC-SHA256(key, payload_type || payload)[:2]  (uint16 little-endian)
```

Il transport code dipende **anche dal payload**, non solo dal nome
regione — quindi due invii con lo stesso scope ma payload diverso
producono codici diversi (comportamento inizialmente scambiato per
un'anomalia, poi chiarito). **Non esiste decodifica diretta**: si
ricalcola il codice per ogni nome candidato di una lista configurata
(`bot.known_regions`) e si cerca corrispondenza.

**Implementazione**: `mesh_modules/bot/region_resolver.py` (logica
portata 1:1 da RT) + in `BotModule`:
- sottoscrizione anche a `RX_LOG_DATA` (oltre a `CHANNEL_MSG_RECV`),
  filtrata su `payload_typename == 'GRP_TXT'` e `chan_hash` del canale;
  richiede `set_decrypt_channel_logs(True)`.
- **Punto chiave**: i byte necessari per l'HMAC (`chan_hash` +
  `cipher_mac` + `crypted`) sono **già esposti separatamente** da
  `meshcore_py` in `RX_LOG_DATA` — non serve un parser di pacchetti
  proprio, basta concatenarli.
- **Correlazione** tra `CHANNEL_MSG_RECV` e `RX_LOG_DATA`: i due eventi
  hanno identificatori diversi (`txt_hash` ≠ `pkt_hash`, verificato
  empiricamente) — si correla tramite `sender_timestamp`, con una
  cache a vita breve (`CORRELATION_TTL = 15s`) e una piccola attesa
  (0.3s) prima di consultarla, perché `RX_LOG_DATA` non sempre precede
  `CHANNEL_MSG_RECV`.
- `set_flood_scope(nome_regione)` va richiamato **prima** di ogni
  invio di risposta — è uno stato del device, non un parametro
  per-messaggio.
- Se lo scope non è risolvibile (nome non tra i candidati configurati,
  o correlazione mancante) si **evita di toccare lo stato corrente**
  del device, piuttosto che rischiare di impostare uno scope sbagliato.

**Test end-to-end riuscito**: risposta del bot verificata sul secondo
device con lo stesso `transport_code` (quindi stesso scope,
`it-lom-pv`) del messaggio originale.

**Nota sul budget di caratteri**: il firmware del device mittente
antepone da solo il proprio nome al testo (`"NomeDevice: messaggio"`)
prima di calcolare il payload — questo va conteggiato come overhead
fisso, non controllabile da codice, nel budget dei 184 byte totali di
payload. Il prefisso `@[nome_mittente]` che aggiunge il bot è invece
di lunghezza **variabile** (dipende dal nome di chi scrive) — non
eliminabile mantenendo la leggibilità su un canale pubblico, ma va
tenuto a mente nel dimensionare `bot.max_reply_length`. Il
troncamento in `PathCommand`/`format_path` è **sui confini degli hop**
(mai un hash tagliato a metà) con contatore degli hop omessi; la rete
di sicurezza finale in `BotModule._send_reply` misura in **byte
UTF-8**, non caratteri.

## 17. Bug: risposta a messaggi unscoped non era realmente unscoped (2026-08-06)

**Osservazione**: testando il bot con un device mobile (1 hop), un
messaggio inviato **senza scope** riceveva risposta con scope `it`
(il default del device) invece di restare unscoped.

**Causa**: `mesh.commands.set_flood_scope()` distingue **due comandi
diversi** a livello di libreria (confermato ispezionando il sorgente
installato, `meshcore_py` 2.3.8):

```python
async def set_flood_scope(self, scope, force_unscoped=False):
    ...
    if scope == "0" or scope == "None" or scope == "":
        scope_key = b"\0"*16   # "resetta al default scope del device"
    elif scope == "*":
        force_unscoped = True  # comando DIVERSO sul filo: unscoped forzato
```

Corrisponde esattamente a una modifica recente del firmware
(`meshcore-dev/MeshCore` PR #2492, *"Companion: Set flood scope to
None"* — introduce una seconda variante di `CMD_SET_FLOOD_SCOPE_KEY`
per l'unscoped esplicito, distinta dal semplice reset). Il codice del
bot passava `""` per i messaggi ricevuti senza scope, che la libreria
interpreta come "torna al default", non come "forza unscoped" — da qui
il fallback a `it`.

**Fix**: in `BotModule._send_reply`, quando `region == ""` (messaggio
arrivato confermato unscoped) si passa `"*"` a `set_flood_scope()`
invece di `""`, per attivare `force_unscoped=True` lato libreria. Il
caso `region is None` (scope sconosciuto/non risolto — non toccare lo
stato) resta invariato.

**Metodo di verifica usato**: nessun changelog pubblico dava
conferma definitiva per la versione installata — risolto ispezionando
direttamente il sorgente installato sul Raspberry:
```bash
python3 -c "
import inspect
from meshcore.commands import CommandHandler
print(inspect.signature(CommandHandler.set_flood_scope))
print(inspect.getsource(CommandHandler.set_flood_scope))
"
```
Utile da ricordare come tecnica generale per questo progetto: quando
la documentazione di `meshcore_py` è ambigua o non aggiornata,
ispezionare il sorgente installato è più affidabile che dedurre da
changelog/blog post esterni.

## 18. Correzione: fallback non deterministico per scope non risolto (2026-08-06)

**Osservazione**: un messaggio con scope non presente in
`bot.known_regions` (`region = None`, "scope non riconosciuto")
produceva una risposta che **non** usava il default scope del device
— usava qualunque scope fosse rimasto impostato dall'ultima chiamata
precedente a `set_flood_scope()` (es. un residuo di un test
precedente), perché il codice **non chiamava affatto**
`set_flood_scope()` per questo caso ("meglio non toccare nulla se non
sappiamo lo scope giusto" — scelta progettuale, non un bug di
distrazione).

**Perché era sbagliato**: "non toccare nulla" non equivale a "usa il
default del device" — produce invece un comportamento non
deterministico, dipendente dalla cronologia delle chiamate precedenti
del bot. Il fallback corretto per uno scope non risolvibile è
esplicito: `set_flood_scope("")`, che (§17) resetta deterministicamente
al default scope del device.

**Fix**: `BotModule._send_reply` ora chiama sempre
`set_flood_scope()` con un valore esplicito per tutti e tre i casi:
`region == ""` → `"*"` (unscoped forzato), `region is None` → `""`
(fallback al default), `region == "nome"` → quel nome. Mai più "lascia
lo stato residuo".

## 19. Lock condiviso tra IPC e BotModule (2026-08-06)

**Osservazione**: durante test approfonditi sul bot, un episodio di
mancata ripetizione da parte del repeater (`0d28`) su una singola
risposta — con cron trace/advert **disattivati** durante il test,
quindi non spiegabile con una race sulla connessione condivisa in
quel caso specifico. Diagnosi: probabile causa a livello RF/duty
cycle, non diagnosticabile dai log disponibili (i messaggi di canale
sono flood broadcast senza conferma di consegna a livello di
protocollo — a differenza di DM/trace, `send_chan_msg()` conferma solo
che il companion ha accettato di trasmettere, mai che qualcuno abbia
ricevuto).

**Gap strutturale confermato comunque valido, corretto**: il lock
introdotto in §20 viveva in `IPCServer`, quindi serializzava solo le
richieste **IPC** (trace/advert) tra loro — non copriva `BotModule`,
che invia comandi direttamente (event-driven, non passa da IPC). Un
comando IPC in corso e una risposta del bot innescata nello stesso
istante potevano quindi finire per essere inviati in concorrenza sulla
stessa connessione condivisa, senza alcuna protezione.

**Fix**: il lock si è spostato da `IPCServer` a `Engine`
(`engine.command_lock`, condiviso), unico punto di verità per tutto
ciò che invia comandi sulla connessione:
- `IPCServer.handle_client()` lo usa attorno a `dispatcher.dispatch()`
  (come prima, ma ora sull'istanza condivisa).
- `BotModule._send_reply()` lo usa attorno a **entrambe**
  `set_flood_scope()` + `send_chan_msg()` insieme — devono restare
  atomiche una rispetto all'altra, non solo protette singolarmente,
  altrimenti un comando IPC potrebbe intercalarsi tra "imposto lo
  scope" e "invio", applicando lo scope sbagliato al messaggio
  sbagliato.

`services/daemon.py` aggiornato di conseguenza: `IPCServer` riceve ora
anche `engine` nel costruttore.

**Nota conclusiva (2026-08-06)**: dopo l'applicazione del lock
condiviso, persisteva un fenomeno di perdita occasionale delle
risposte del bot su un device specifico. Indagato con un test a
scambio di ruoli tra due device (Vigevano-Osservatore, firmware stock,
mittente/ricevente in entrambe le direzioni vs IK2XYP-Armando,
firmware custom con sleep per risparmio energetico): il primo non ha
mai perso una risposta, in nessun ruolo. Il secondo ha perso risposte
**anche restando puramente in ricezione** — il che esclude qualunque
causa nella logica di invio del bot (che tratta tutti i destinatari
allo stesso modo).

**Spiegazione più probabile (aggiornata dopo ulteriori test DM,
vedi §21)**: non un difetto del device, ma **perdita statistica dovuta
al ciclo di sleep** del firmware custom — un pacchetto in arrivo
mentre il radio è addormentato va semplicemente perso, indipendente da
quale device specifico. Coerente con l'osservazione che anche
`Base-IK2XYP-Armando` (stesso firmware custom) ha mostrato lo stesso
tipo di comportamento in un test successivo sui DM (un retry "perso"
apparentemente, più plausibilmente un mancato ascolto durante sleep
piuttosto che una deduplica).

**CONFERMATO DEFINITIVAMENTE (2026-08-06)**: firmware identificato
come `IoTThinks/EasySkyMesh` (release `PowerSaving16`, basato su
MeshCore 1.16), power saving abilitato di default per i companion BLE
— autonomia dichiarata "5 giorni" con hibernate a 16uA, struttura che
richiede necessariamente un duty-cycling del radio LoRa (l'ascolto
continuo costerebbe 10-20mA, incompatibile con quell'autonomia).
**Test A/B eseguito dall'utente**: `IK2XYP-Armando` riflashato con
firmware stock 1.16.0 (no power saving) → scambio messaggi
sensibilmente più affidabile, molte meno risposte perse. In parallelo,
`Base-IK2XYP-Armando` lasciato sul firmware power-saving → continua a
perdere molte più risposte. Stesso bot, stesse condizioni, unica
variabile cambiata: risultato netto in entrambe le direzioni.
**Causa confermata**: duty-cycling del radio per risparmio energetico.
Le perdite residue minori restano attribuibili a normali fattori RF
(non ulteriormente indagate). **Chiuso definitivamente**: nessuna
azione lato backend, è un trade-off batteria/affidabilità del
firmware, non un bug.

---

## 20. Revisione cron/scheduler e systemd (2026-08-06)

**Cron come trigger per trace/advert/floodadv — confermato, nessuna
modifica.** Il vantaggio strutturale del daemon (connessione esclusiva
gestita in modo affidabile) è già pienamente ottenuto dal passaggio
via IPC, indipendentemente da chi programma l'esecuzione — spostare la
schedulazione dentro il daemon non aggiungerebbe robustezza,
solo un luogo diverso in cui gestirla. Cron resta la scelta giusta per
questo progetto.

Nota di pulizia (chiarita, 2026-08-06): `trace.interval` è il tempo di
pausa (in secondi) tra un path e il successivo **nello stesso batch**,
usato in `mesh_modules/trace/engine.py` (`TraceEngine.run()`, lato
client lanciato da `main_trace.py` via cron) — non ha nulla a che
fare con la programmazione di cron. Confermato dall'utente e dal
codice. Rilevata una piccola inefficienza non bloccante nello stesso
metodo: il `sleep(interval)` scatta anche dopo l'ultimo path del
batch, allungando inutilmente ogni esecuzione — irrilevante con la
schedulazione attuale (ogni 30 minuti), fix disponibile se richiesto
in futuro (condizionare il `sleep` a "non ultimo path" via
`enumerate`).

**Systemd (`systemd/trace-mon.service`) — verificato, già solido.**
`Restart=always` con `RestartSec=5` copre sia i crash a runtime sia il
riavvio dell'host (non solo quest'ultimo). `After=/Wants=
network-online.target` corretto per connessione TCP. Nessuna modifica
necessaria al file di unit.

**Trovato un margine di rischio reale, corretto**: `IPCServer` non
serializzava le richieste in arrivo — `asyncio.start_unix_server`
invoca `handle_client()` concorrentemente per ogni connessione, quindi
due richieste IPC sovrapposte (es. batch trace ancora in corso quando
un altro cron scatta) avrebbero potuto inviare comandi in
concorrenza sulla stessa connessione MeshCore condivisa, con rischio
di confondere le risposte correlate via `expected_ack`. **Fix
applicato**: `asyncio.Lock()` attorno a `dispatcher.dispatch()` in
`IPCServer.handle_client()` — le richieste IPC vengono ora processate
in sequenza. Il `BotService` (event-driven, non passa da IPC) non è
interessato dal lock — continua a rispondere sul canale anche con una
richiesta IPC in coda.

**Verificato anche**: pulizia del socket IPC orfano già gestita
correttamente in `IPCServer.start()` (rimozione preventiva prima del
bind) — nessun rischio di crash-loop con `Restart=always` in caso di
arresto non pulito.

---

## 21. Estensione ai DM (2026-08-06)

**Decisioni prese** (confermate con l'utente prima del codice):
- Comandi **condivisi** tra canale e DM tramite `CommandContext`
  normalizzato (`path_hex`/`path_len`/`sender_name`/`rssi`/`snr`),
  popolato da fonti diverse a seconda dell'origine:
  - Canale: `path_hex`/`path_len` da `CHANNEL_MSG_RECV.path`.
  - DM: `path_hex`/`path_len` da **`contact['out_path']`/
    `out_path_len`** (non dal messaggio in arrivo — `CONTACT_MSG_RECV`
    non porta un elenco hop, solo un hop-count grezzo per l'arrivo di
    quel messaggio specifico). `out_path_len == 255` (`OUT_PATH_UNKNOWN`)
    → path non ancora noto, routing in flood.
- **Mittente DM non in contact list → nessun evento, non solo
  "ignorato".** Confermato con test reale (`debug=True`,
  2026-08-07, vedi `docs/CONTACT_MANAGEMENT.md` §12): il pacchetto
  arriva a livello radio (`RX_LOG_DATA` scatta regolarmente, anche
  per i retry), ma senza la chiave pubblica del mittente il device
  non riesce a decifrarlo — **`CONTACT_MSG_RECV` non scatta mai** per
  questo caso. Di conseguenza `_on_contact_message` non viene
  nemmeno invocato: nessuna riga di log "mittente sconosciuto", vero
  silenzio, non un ignorare esplicito. Limite crittografico
  strutturale, non applicativo — in evoluzione in versioni future del
  firmware/app.
- **Dedup DM esplicito** necessario (a differenza del canale): i
  retry del mittente prima dell'ACK hanno `pkt_hash` diverso ogni
  volta (§14) ma **stesso `sender_timestamp`** — cache
  `(pubkey_prefix, sender_timestamp)`, TTL 60s.
- **Risposta DM con conferma ACK** (`send_msg_with_retry`), a
  differenza del canale (fire-and-forget). **Limite noto e accettato**:
  su percorsi radio **asimmetrici**, un ACK può non tornare al mittente
  anche se il destinatario ha ricevuto correttamente — un mancato ACK
  viene quindi loggato come tale ("nessun ACK, possibile percorso
  asimmetrico"), mai come "invio fallito" in senso stretto. Per lo
  stesso motivo, un mancato ACK **non** chiama
  `engine.report_possible_failure()` — stessa logica già applicata al
  timeout di `TRACE_DATA` (fenomeno radio, non segnale di guasto del
  link locale).
- `RSSI` può risultare `None` sui DM (non sempre esposto
  dall'evento `CONTACT_MSG_RECV`) — gestito esplicitamente, non un bug.

**Nota di incertezza dichiarata**: non c'è conferma definitiva su
quale `EventType`/`payload.reason` torni `send_msg_with_retry()` nel
caso specifico "tentativi esauriti senza ACK" vs un errore genuino sul
link locale — verrà calibrato con i test sul campo.

**Primi test (2026-08-06)**: 3/3 comandi DM (`!ping`, `!path` x2)
confermati con ACK ricevuto, tempi di risposta 1-2s. Rilevata e
**confermata come comportamento atteso, non bug** una sfumatura
importante: forzando il device mittente a instradare il comando verso
il bot via un ripetitore (`0d28`), la risposta del bot ha comunque
mostrato `DIRECT` — perché il bot, essendo fisicamente vicino,
riceveva comunque anche la copia diretta del messaggio, e
`contact['out_path']` riflette **l'instradamento del bot verso il
contatto** (indipendente e potenzialmente diverso da come è arrivato
un comando specifico, su un canale radio asimmetrico).

**Test di validazione superato (2026-08-06)**: invece di bloccare la
ricezione diretta, l'utente ha forzato direttamente sul device del bot
lo stato del contatto verso `Base-IK2XYP-Armando` a 1 hop via
ripetitore (`0d28`) — isolando la variabile in modo più diretto.
Risultato: `!path` ha correttamente risposto `Path:0d28` (non più
`DIRECT`), confermando che `contact['out_path']` è la fonte corretta e
che la formattazione funziona bene anche nel caso realmente indiretto,
non solo in quello diretto già visto. Osservato anche nel log un retry
reale della libreria (`"Retry sending msg: 2"`) prima della conferma
ACK, ~9s totali su un percorso a un hop — buon riferimento per
valutare in futuro se un tempo di risposta DM è nella norma.

**Parte DM considerata validata end-to-end** per lo scope attuale
(`!path`, `!ping`, condivisi con il canale tramite `CommandContext`
normalizzato).

## 22. Indagine "path del DM sempre DIRECT" (2026-08-07)

**Osservazione iniziale**: forzando `IK2XYP-Armando` a instradare
verso il bot via `0d28`, e verificando lo stesso stato direttamente
sull'app del device del bot, `!path` continuava comunque a rispondere
`DIRECT`.

**Percorso di indagine** (riassunto, diagnosi metodica passo-passo):
1. Sospettata cache non aggiornata in `get_contact_by_key_prefix()` →
   aggiunto refresh esplicito (`get_contacts()`) prima di ogni lookup
   in `BotModule._on_contact_message`.
2. Creato `tools/test_contact.py` + comando IPC `system.contact` per
   interrogare lo stato di un contatto senza dover fermare il daemon
   e collegarsi da un altro device — strumento di diagnostica
   riutilizzabile, non solo per questo bug.
3. Trovato e corretto un bug reale nel tool stesso
   (`engine.mesh.contacts` è un dict `{public_key: contact}`, andava
   iterato con `.values()`, non direttamente).
4. Con il tool funzionante, il valore restava comunque stantio →
   ispezionato il sorgente installato (`meshcore_py`) fino al livello
   del gestore eventi che scrive la cache (`_update_contacts`,
   agganciato a `EventType.CONTACTS`) — merge corretto, nessun bug
   evidente nella libreria.
5. **Verifica definitiva con `debug=True`** (script sperimentale
   `experiments/exp04_contact_debug.py`, daemon fermo): catturato il
   traffico grezzo byte-per-byte dal device. Il payload binario del
   contatto (`out_path_hash_mode`+`out_path_len` codificati nel byte
   `0x40` = hash_mode 1, path_len 0) **confermava che il DEVICE
   STESSO** riportava `DIRECT` in quel momento — non un problema di
   parsing/cache lato nostro. Lo stesso dump mostrava correttamente
   `out_path: '0d28'` per un altro contatto (`Base-IK2XYP-Armando`),
   confermando che il meccanismo di lettura è corretto in generale.

**Causa reale, confermata con un test a finestra temporale stretta**:
non un bug, ma una questione di **tempistica fisica reale**.
`get_contacts()` interroga il device in tempo reale ad ogni chiamata
(dimostrato). Quando un comando arriva **subito dopo** un cambio di
routing sul mittente, il device del bot può non aver ancora
completato l'apprendimento del nuovo path (richiede uno scambio radio
reale, es. l'ACK della risposta stessa) nel preciso istante in cui il
bot fa il lookup — restituendo quindi lo stato vero-in-quel-momento,
che risulta "vecchio di pochi secondi" rispetto a un cambiamento
ancora in corso. Un controllo manuale pochi secondi dopo mostra
correttamente il valore aggiornato, perché nel frattempo il device ha
completato l'apprendimento.

**Nessun fix di codice necessario o possibile**: `!path` per i DM
mostra correttamente un'istantanea onesta dello stato del device
nell'istante dell'interrogazione — non c'è un modo sensato di
"aspettare" un apprendimento di path la cui durata non è nota a
priori. Comportamento accettato come caratteristica nota del sistema,
non un difetto.

**Sottoprodotto utile**: `tools/test_contact.py` +
`system.contact` (IPC) restano come strumento di diagnostica
permanente per interrogare lo stato di routing di qualsiasi contatto
senza fermare il daemon.

**Confermato sul campo (2026-08-07)**: test reale con distanza fisica
vera tra i device (non più forzature manuali via app) ha riprodotto
esattamente lo stesso pattern osservato in laboratorio. In più,
emerso un meccanismo del protocollo utile da avere a verbale:
**dopo 5 tentativi falliti su un routing path/direct stabilito, il
firmware commuta automaticamente a flood come fallback**, per poi
eventualmente ri-apprendere un path funzionante dal nuovo ACK
ricevuto. Nel test osservato, il comando `!path` stesso ha innescato
questa transizione (DIRECT → fallback flood dopo 5 tentativi falliti
per allontanamento → nuovo path appreso via `0d28`) — la sua risposta
(`DIRECT 0hop`) rifletteva correttamente lo stato **immediatamente
prima** della transizione che il comando stesso stava causando; il
comando successivo, a stato ormai assestato, ha mostrato
correttamente il nuovo path. Nessun'altra sorpresa: il comportamento
è coerente al 100% con quanto già isolato e spiegato sopra.

**Dedup DM confermata in uso reale (2026-08-06)**: durante i test A/B
sul firmware, osservato in log un caso organico (non forzato) di
retry pre-ACK del mittente, correttamente riconosciuto e ignorato
dalla cache `(pubkey_prefix, sender_timestamp)` (`"BOT: DM duplicato
(retry pre-ACK) ignorato da ..."`) — prima conferma della dedup in
condizioni reali, non solo in test mirati.

Nota per la lettura dei log: la ricezione/elaborazione dei comandi DM
non è serializzata (solo l'invio effettivo lo è, tramite
`command_lock`) — comandi ravvicinati da mittenti diversi (o dallo
stesso mittente con retry) possono essere in lavorazione in parallelo,
quindi le righe "comando ricevuto"/"reply confermata" non sono sempre
strettamente alternate 1-a-1 in ordine. Non c'è oggi un ID di
correlazione esplicito nei log per ricostruire con certezza quale
risposta corrisponda a quale comando in caso di sovrapposizione.

## 23. Comandi con argomento: `CommandContext.arg` (2026-08-08)

Fino a questo punto il dispatch prendeva **tutto** il testo dopo `!`
come nome del comando (`text[len(prefix):].strip().lower()`) — `!path`
e `!ping` non avevano mai avuto bisogno di un argomento. Introducendo
`!meteo <città>` è emersa la necessità di separare nome comando e
argomento.

**Soluzione**: nuova funzione `_parse_command(text)` in `bot.py`,
usata sia in `_on_channel_message` sia in `_on_contact_message`:

```python
def _parse_command(text):
    command, _, arg = text.strip().partition(" ")
    return command.lower(), (arg.strip() or None)
```

Solo il nome comando è normalizzato in minuscolo — l'argomento resta
così come digitato (case preservato), utile per comandi futuri che ne
avessero bisogno (es. un nome proprio). `arg` è `None` se il comando
non ha argomento — comportamento invariato per `!path`/`!ping`/
`!info`, nessuna modifica richiesta a loro.

`CommandContext` esteso con `arg: Optional[str] = None` (default,
retrocompatibile — nessuna chiamata esistente al costruttore va
aggiornata). Verificato con test funzionale isolato: parsing corretto
anche con argomenti multi-parola (`!meteo New York`) e con
spaziatura irregolare.

## 24. Comando `!info` (2026-08-08)

Risponde con l'elenco dei nomi dei comandi disponibili (solo nomi,
con prefisso `!`, es. `!info !meteo !path !ping !status`), letto
**dinamicamente** da `COMMANDS` in `registry.py` — nessuna lista
hardcoded da tenere sincronizzata a mano, un comando nuovo registrato
in `registry.py` compare automaticamente in `!info`.

Import di `COMMANDS` fatto dentro `handle()` (non a livello di
modulo) perché `registry.py` deve importare `info.py` per registrarlo
— un import a livello di modulo creerebbe un import circolare diretto
(`info.py` → `registry.py` → `info.py`). Verificato con un test di
import isolato che il pattern risolve correttamente il ciclo.

Stesso stile di troncamento sicuro entro `reply_budget` già usato da
`format_path()` in `path.py` (elenco progressivo con indicatore
`+N` se il budget non basta per tutti i nomi).

## 25. Comando `!meteo <città>` (2026-08-08)

Primo comando del progetto che fa una chiamata di **rete esterna**
(finora `trace-mon` parlava solo col device via `meshcore_py`, nessun
client HTTP era mai stato introdotto).

**Servizio**: [Open-Meteo](https://open-meteo.com/) — scelto rispetto
a `wttr.in` per robustezza dell'infrastruttura e perché restituisce
JSON strutturato (permette di scegliere esattamente i campi voluti,
niente parsing di testo/emoji). Nessuna API key richiesta, nessun
limite di richieste rilevante per questo caso d'uso.

**Client HTTP**: `aiohttp` (async) — scelta obbligata dato che
`handle()` gira dentro l'event loop del daemon: un client sincrono
come `requests` bloccherebbe l'intero processo durante la chiamata di
rete. **Dipendenza da aggiungere a `requirements.txt`** (non ancora
fatto) + `pip install` sul Raspberry prima del deploy.

**Flusso**: geocoding (`geocoding-api.open-meteo.com/v1/search` —
nome città → lat/lon) poi forecast
(`api.open-meteo.com/v1/forecast?current=temperature_2m,
relative_humidity_2m,wind_speed_10m`). Timeout esplicito 8s su tutta
la sessione (`aiohttp.ClientTimeout(total=8)`).

**Gestione errori**: qualsiasi fallimento (città non trovata, rete
irraggiungibile, errore HTTP, risposta JSON malformata) produce la
stessa risposta generica `"Informazioni non trovate"` — nessun
dettaglio tecnico esposto sul canale/DM, il dettaglio finisce solo nei
log (`log.warning(..., exc_info=True)`). Caso "nessun argomento"
(`ctx.arg is None`) gestito a parte con un messaggio d'uso
(`"Uso: !meteo <città>"`), non trattato come errore.

**Nota di design**: una `aiohttp.ClientSession` nuova viene aperta a
ogni chiamata del comando (non una sessione condivisa a lungo termine
come `Engine` fa con la connessione mesh) — scelta di semplicità
adeguata a un comando bot a bassa frequenza; da rivalutare se `!meteo`
(o altri comandi di rete futuri) diventasse molto usato.

Verificato con test funzionale end-to-end via mock di `aiohttp`
(nessuna chiamata di rete reale in questo ambiente di sviluppo): tutti
gli scenari passano (successo, troncamento a budget ridotto, tutti i
casi di errore, argomento mancante). **Non ancora testato con
chiamate reali sul Raspberry.**

## 26. Comando `!status` (2026-08-08)

Risponde con tensione batteria e memoria libera del device, letti in
tempo reale via `get_bat()` — comando locale al companion (non passa
dal link radio), sicuro da interrogare a ogni invocazione.

**Payload confermato empiricamente** (`experiments/exp07_get_bat.py`,
eseguito sul Raspberry, non dedotto da documentazione):

```python
{'level': 4279, 'used_kb': 215, 'total_kb': 1404}
```

- `level` è la tensione batteria in **millivolt** nonostante il nome
  (NON una percentuale — 4279 sarebbe impossibile come %, valore
  plausibile per una LiPo carica: 4.28V).
- `used_kb`/`total_kb` sono lo storage del device — `total_kb` (1404)
  coincide con lo storage totale già visto nell'app durante
  l'indagine su CONTACT_MANAGEMENT.md §6 (screenshot Device Info).
  Memoria libera = `total_kb - used_kb`.

Output: `"Status: batt {volts:.2f}V mem {free_kb}/{total_kb}KB
libera"` (es. `"Status: batt 4.28V mem 1189/1404KB libera"`).

**Nota architetturale**: `get_bat()` tocca il device sulla connessione
condivisa — a differenza di `!path`/`!ping`/`!info` (che leggono solo
dati già presenti in `ctx`, popolati da `BotModule` prima del
dispatch), `!status` è il primo comando che interroga il device dal
vivo dall'interno di `handle()`. Per coerenza con l'architettura a
connessione esclusiva (stesso principio già applicato a
`IPCServer.handle_client()` e `BotModule._send_*_reply`, vedi §19), la
chiamata è serializzata con `ctx.engine.command_lock`.

Fallback uniforme `"Informazioni non trovate"` su device non connesso,
evento di tipo `ERROR`, eccezione, o payload con campi mancanti.
Verificato con test funzionale end-to-end via mock di
`engine`/`mesh`/`command_lock` su tutti gli scenari (output reale del
caso "ok" identico a quello riportato sopra). **Non ancora testato con
chiamate reali sul Raspberry.**

Con questo il bot ha 5 comandi: `!info`, `!meteo`, `!path`, `!ping`,
`!status`.

## 27. Revisione d'insieme del progetto Nodo (2026-08-08)

Fornito l'intero codice del Nodo (non solo i file toccati di volta in
volta) per un'analisi complessiva — utile perché fa emergere pattern
trasversali invisibili guardando un modulo alla volta.

**Criticità trovata**: `Engine.command_lock` (§19) serializza i
comandi sulla connessione condivisa, ma tre punti pre-esistenti la
toccavano senza acquisirlo: `Engine._run_heartbeat_check()`
(`get_bat()` ogni `heartbeat_interval`), `ContactSyncModule._full_sync()`
(`get_contacts()`, sync iniziale e periodico), e tre chiamate
`get_contacts()` in `bot.py` (`start()`, `_rebind_async()`,
`_on_contact_message()` — solo l'invio della risposta era già
protetto). Corretti tutti e tre avvolgendoli in
`async with engine.command_lock:`, stesso pattern già in uso altrove.

**Eccezione deliberata**: l'heartbeat è stato poi **riportato
volutamente fuori dal lock**, su intuizione dell'utente confermata in
analisi. `command_lock` non ha timeout sull'acquisizione — se un
comando qualsiasi resta bloccato in attesa di risposta da un device
già silenziosamente disconnesso (lo scenario stesso che l'heartbeat
esiste per rilevare, vedi §13), tiene il lock indefinitamente. Se
l'heartbeat dovesse aspettare lo stesso lock per eseguire `get_bat()`,
non riuscirebbe mai a far scattare il recovery loop —
`asyncio.wait_for(timeout=heartbeat_timeout)` protegge solo la
chiamata una volta ottenuto il lock, non l'attesa del lock stesso.
L'heartbeat deve poter verificare lo stato della connessione
indipendentemente da cosa la sta eventualmente bloccando altrove,
quindi ha priorità e resta l'unico comando sulla connessione
volutamente non serializzato da `command_lock` — commentato
esplicitamente nel codice per non farlo sembrare una svista in futuro.

I fix su `ContactSyncModule` e `BotModule` restano invece dentro il
lock (nessuna esigenza di priorità analoga per loro). **Non ancora
testato sul Raspberry.**

**Addendum — rischio residuo verificato nel sorgente di `meshcore_py`
(2026-08-08)**: la correlazione comando→risposta della libreria
(`commands/base.py`, metodo `send()`) è puramente **per tipo di
evento** — si sottoscrive `expected_events` prima di inviare, poi
aspetta il primo evento di quel tipo. Nessun ID di correlazione
per-richiesta esiste nel protocollo implementato. La consegna
(`events.py`, `EventDispatcher._process_events()`) è un vero
broadcast: ogni evento in arrivo viene recapitato a **tutti** i
subscriber di quel tipo, non solo al "primo in coda". Gli eventi
`ERROR` (generati in `reader.py`) portano solo un `reason` generico,
nessun riferimento al comando che li ha causati.

Implicazione concreta: `EventType.ERROR` è atteso da praticamente
ogni comando della libreria. Se un comando sotto `command_lock`
genera legittimamente un `ERROR` mentre l'heartbeat sta aspettando la
risposta al proprio `get_bat()` (che attende `[BATTERY, ERROR]`),
quello stesso evento risolve anche l'attesa dell'heartbeat, che lo
scambia per un proprio fallimento — reconnect completo non
necessario. Il rischio è però **asimmetrico**: `EventType.BATTERY` è
atteso solo da `get_bat()` (verificato, nessun altro comando lo
include), quindi l'heartbeat non può mai risolversi erroneamente come
"successo" per colpa di un altro comando, e non può mai mascherare o
"rubare" la risposta destinata a un altro comando in attesa — l'unico
esito possibile dell'interferenza è un reconnect di troppo, mai una
disconnessione reale non rilevata. Nessuna mitigazione economica
possibile restando dentro questa libreria (richiederebbe patchare
`meshcore_py` per una correlazione per-richiesta, sproporzionato).
Rischio accettato consapevolmente, non più solo per analogia con §19
ma verificato riga per riga nel codice della libreria.

**Osservazioni minori, nessuna azione**: naming collision tra
`system.status` via IPC (`{"connected": bool}`) e `!status` del bot
(batteria/memoria) — stesso nome, concetti diversi, solo da tenere a
mente leggendo il codice. Il tar fornito include `node_modules`/
`__pycache__` (nessun `.gitignore` trovato nel progetto) — solo
un'osservazione di housekeeping, nessun impatto architetturale.

## 28. Servizio `neighbor_monitor` (2026-08-08)

Sesto servizio pluggable del daemon, a fianco di
system/trace/advert/bot/contact_sync (§sezione servizi). Interroga
via richiesta radio diretta (non trace/advert) i repeater elencati in
`config.yaml` per ottenerne status (batteria, statistiche traffico,
uptime), lista neighbours — cosa il repeater stesso sente intorno a
sé, utile per valutare a quale repeater collegarsi — e telemetria
(canali sensore Cayenne LPP; per IK2XYP-RPT: tensione batteria e
temperatura). Stesso schema
architetturale di trace/advert: script cron sottile
(`main_neighbor_monitor.py`) → IPC → `NeighborMonitorService` →
`NeighborMonitorModule`, comando eseguito dentro `Engine.command_lock`
(garantito dal wrapping di `IPCServer.handle_client()` sull'intero
dispatch, nessun lock esplicito nel modulo — stesso principio di
`TraceModule`).

Scrive in tre tabelle di `contacts.db` (`repeater_status`,
`repeater_neighbours`, `repeater_telemetry`) — stesso file di
`nodes`/`path_observations`,
non un DB separato, per poter risolvere i neighbour (chiavi
pubbliche troncate a prefisso) in nomi noti via JOIN. Verificato
empiricamente (non solo per analisi del codice) che un repeater privo
dei permessi ACL necessari e un repeater irraggiungibile per
condizioni radio sono indistinguibili a ogni livello dello stack —
nessun frame di rifiuto esplicito, silenzio radio in entrambi i casi.
Verificato anche nel sorgente che status/neighbours/telemetria
condividono tutti lo stesso meccanismo gated da ACL (`BinaryReqType`)
— nessun login richiesto, a differenza del canale separato
`send_login`/`send_cmd` (shell remota amministrativa, non usato qui).

Aggiunta anche una quarta tabella (`repeater_region`) per le regioni
supportate dal repeater (`req_regions_sync()`, `AnonReqType` — ancora
più aperto della `BinaryReqType`: nessun ACL richiesto affatto).
Unica tra le quattro tabelle a non essere accoppiata a
`status.queried_at`: può riuscire anche quando status fallisce per
un problema ACL, quindi ha una propria `MAX(queried_at)`
indipendente, verificato esplicitamente con un DB privo di righe
status.

Aggiunta anche una quinta tabella (`repeater_config`) per parametri
di configurazione ottenibili solo via login CLI (`send_login_sync()`
con password vuota — confermato che un repeater con bit admin
nell'ACL non richiede una password reale, esattamente come osservato
dall'utente nell'uso quotidiano via app — poi comandi testuali
`ver`/`get <parametro>`, non richieste strutturate). Requisito di
permesso ancora più stringente delle altre quattro tabelle (login +
admin, non solo ACL di lettura o nessun permesso come per region) —
stessa tabella indipendente, propria `MAX(queried_at)`. Principio
esplicitato dall'utente e applicato in tutto il modulo: su LoRa un
comando senza risposta non è mai prova che il comando non esista,
solo `None` per quella singola interrogazione.

Terzo tab "Neighbours" nel frontend (Nodo e Collettore), stesso stile
di Trace/Nodes.

Dettagli completi (schema DB, verifica ACL, decisioni di
configurazione, note sul frontend): `docs/NEIGHBOR_MONITORING.md`.

---

## Come usare questo documento con Claude Code

Claude Code carica automaticamente all'avvio di ogni sessione un file
`CLAUDE.md` posto nella root del progetto (o `./.claude/CLAUDE.md`) — è
il meccanismo nativo per non dover rispiegare il contesto ogni volta.

Passi consigliati:

1. Salva questo file come `docs/ARCHITECTURE.md` nella root di
   `trace-mon/`.
2. Crea (o aggiorna) `CLAUDE.md` nella root del progetto con un import:
   ```markdown
   # trace-mon

   @docs/ARCHITECTURE.md

   ## Note operative
   - Ambiente: Raspberry Pi (rpi4b), utente meshcore
   - Prima di ogni modifica architetturale, aggiorna docs/ARCHITECTURE.md
   ```
   La sintassi `@path` importa il file nel contesto a ogni sessione.
3. Ogni volta che si chiude una fase o si prende una decisione, chiedi a
   Claude Code direttamente "aggiorna docs/ARCHITECTURE.md con questa
   decisione" — lo terrai aggiornato senza doverlo fare a mano.
4. Verifica che il file sia effettivamente caricato lanciando `/context`
   in una sessione: deve comparire sotto "Memory files".
5. Claude Code ha anche una **auto memory** separata (note che scrive da
   solo su bug/pattern scoperti lavorando) — utile ma complementare: le
   decisioni architetturali esplicite vanno comunque in questo documento,
   non lasciate all'auto memory.
