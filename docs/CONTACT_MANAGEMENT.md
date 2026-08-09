# trace-mon — Contact Management

> Documento di analisi e lavoro per una fase strutturale del progetto.
> Redatto progressivamente insieme all'utente, in accompagnamento a
> `ARCHITECTURE.md`.

Ultimo aggiornamento: 2026-08-08

---

## 1. Obiettivo

Costruire una gestione dei contatti che non dipenda dalla memoria
limitata del device companion (`Vigevano-Tracciatore`), per due scopi
distinti:

1. **Operativo**: il `BotService` (in particolare `!path` sui DM) deve
   poter funzionare senza che i contatti utili vengano espulsi dalla
   `contact list` del device per fare spazio a nuovi advert ricevuti.
2. **Nuova funzionalità frontend**: una pagina che mostri i contatti
   noti con il **path completo con cui è arrivato il loro advert**
   (concetto diverso da `out_path` — vedi §4) — informazione utile a
   prescindere da qualsiasi interazione col bot.

## 2. Problema attuale

- Il device ha una `contact list` interna a memoria limitata (limite
  hardware, non solo un valore arbitrario — l'utente lo cita attorno a
  350, ma va verificato quello reale riportato dal device stesso).
- MeshCore (app/firmware) distingue una **discovery list** (contatti
  visti via advert, non necessariamente salvati) da una **contact
  list** (sottoinsieme effettivamente in memoria, promosso dalla
  discovery list — automaticamente o manualmente, a seconda delle
  opzioni dell'app).
- Se il device gestisce l'auto-add senza filtro, la `contact list` si
  riempie anche di contatti irrilevanti (es. repeater, room server —
  ruoli che non possono partecipare a DM) a scapito di contatti chat
  realmente utili.
- Oggi il `BotService` legge lo stato di routing (`out_path`) **solo**
  dalla `contact list` del device in tempo reale (vedi
  `ARCHITECTURE.md` §14, §21, §22) — se un contatto non è (più) in
  memoria sul device, il bot non ha modo di rispondere a `!path` per
  quel contatto.

## 3. Prior art: come lo risolve Remote-Terminal-for-MeshCore

Analizzato `app/radio_sync.py` (repo già scaricato durante
l'indagine sul flood-scope, vedi `ARCHITECTURE.md` §16). RT tratta il
device come una **cache limitata e gestita attivamente**, non come
sorgente di verità:

- **Capacità letta dal device**, non assunta fissa
  (`radio_manager.max_contacts`, valore hardware riportato alla
  connessione).
- **Due soglie**: `refill_target` (~80% della capacità) e
  `full_sync_trigger` (soglia più alta, es. 90%+) — quando i contatti
  sul device raggiungono il trigger, scatta un ciclo di
  offload-completo-poi-ricarica-selettiva.
- **Politica di riempimento con priorità esplicite**, sempre
  escludendo i repeater dal pool "da tenere sul device":
  1. Contatti preferiti (`favorites`), fino a piena capacità.
  2. Contatti **non-repeater** con attività DM recente (inviata o
     ricevuta), fino al refill target.
  3. Contatti **non-repeater** con advert ricevuto di recente, fino
     al refill target.
- Tutti i contatti (anche quelli non caricati sul device in un dato
  momento) restano persistiti nel proprio DB (SQLite, con migration
  vere e proprie — schema completo con storico nomi, path noti,
  telemetria per contatto, override di routing).

Non è ancora chiaro (da approfondire) se RT intervenga anche
sull'auto-add del device stesso (disattivandolo per gestire tutto
lato applicazione) o se si limiti a leggere/rimuovere via comando dopo
che il device ha già promosso un contatto di sua iniziativa — punto
rilevante per capire se il tuo approccio B (device filtra, noi
sincronizziamo) è compatibile con questo modello o richiede una
strategia diversa.

## 4. Due concetti di "path" da non confondere

Emerso già durante l'indagine sui DM (`ARCHITECTURE.md` §21-22), ma
centrale per questo lavoro:

- **`out_path`/`out_path_len`** (sul contatto, letto da
  `get_contacts()`): il percorso **attualmente noto per raggiungere**
  quel contatto in uscita — stato mantenuto e aggiornato nel tempo dal
  device, può cambiare (flood→direct→path, vedi §25).
- **Path dell'advert** (quello richiesto per la pagina frontend):
  il percorso con cui è arrivato **un advert specifico** — payload di
  tipo `ADVERT` (`payload_typename: 'ADVERT'`), già intercettato una
  volta per puro caso durante l'esperimento `exp03_dm_receive.py`
  (vedi `ARCHITECTURE.md` §14), con i suoi propri `path`/`path_len`
  nello stesso formato hash-concatenati visto per i messaggi di
  canale — **non** lo stesso dato di `out_path`, va catturato
  separatamente via `RX_LOG_DATA` filtrato su `payload_typename ==
  'ADVERT'`.

## 5. Approcci considerati

**A — Offload totale, stile Remote Terminal**: `trace-mon` prende il
controllo completo della gestione contatti (auto-add lato app
disattivato o ignorato), tutto passa dal nostro store interno, col
device usato solo come cache limitata sincronizzata attivamente con
una politica di priorità.

**B — Device filtra, noi sincronizziamo**: si lascia al device/app la
selezione iniziale (auto-add limitato ai soli contatti di tipo chat,
tramite le opzioni già disponibili nell'app), e `trace-mon` si limita
a specchiare/offloadare quello che il device ha già deciso di
accettare, liberando poi memoria quando un contatto è già al sicuro
nello store interno.

**Non ancora deciso tra i due** — da chiudere dopo aver risposto alle
domande aperte in §6, in particolare capire se il device espone un
comando per **rimuovere** un contatto dalla propria memoria (necessario
per l'approccio B, dato che serve liberare spazio attivamente man mano
che i contatti vengono "salvati" nello store esterno) e se le opzioni
di auto-add filtrato per tipo esistono davvero a livello di
comando/companion o solo nell'app.

## 6. Domande aperte / da studiare prima di scegliere

- [x] **Il filtro auto-add per tipo esiste davvero**, confermato con
      screenshot dell'app (`Contact Settings`): modalità `Auto Add
      All` vs `Auto Add Selected`, con quest'ultima che espone
      checkbox separate per **Chat Users / Repeaters / Room Servers /
      Sensors** — quattro tipi distinti. C'è anche un filtro
      aggiuntivo per hop count (`Auto Add Max Hops`) e una eviction
      nativa (`Overwrite Oldest` — sovrascrive il contatto
      non-preferito più vecchio a lista piena).
- [x] **RISOLTA CON CERTEZZA (2026-08-07)**: la logica di auto-add è
      **lato firmware**, non lato app. Test empirico: opzioni attivate
      su `Vigevano-Tracciatore`, poi app **completamente
      disconnessa**; nell'arco di ~50 minuti il device ha aggiunto da
      solo 3 nuovi contatti di **tre tipi diversi** (chat: `Valerio`;
      repeater: `IT-LIG-PianiInvrea-R`; room server: `🌊 Atlantis`),
      verificato leggendo direttamente dal device via un tool nostro
      (`tools/test_contacts_list.py`), mai passando dall'app.
      **Conseguenza pratica**: l'approccio B è pienamente percorribile
      senza dover replicare alcuna logica di filtro in `trace-mon` —
      basta configurare una volta le opzioni sul device (via app), il
      firmware fa il resto in autonomia.
- [x] **Il "push" per nuovo contatto non richiede simulare le
      notifiche dell'app**: `meshcore_py` si iscrive già
      internamente a `EventType.NEW_CONTACT` e
      `EventType.ADVERTISEMENT` (visto in `_setup_data_tracking` nel
      sorgente della libreria) — lo stesso segnale che alimenta la
      notifica "New Contact Discovered" sul telefono è disponibile
      direttamente al nostro daemon sulla stessa connessione.
- [x] **Capacità reale del device confermata da app**: `Contacts:
      10/350` (schermata Device Info) — 350 è un limite hardware
      reale, non un valore approssimativo. Stesso schermo conferma
      anche `Channels: 14/40` e storage totale `1404kb` (30% in uso a
      quel momento).
- [x] **Mappa dei valori `type` estesa con dati reali**: `1` = chat,
      `2` = repeater, **`3` = room server** (confermato con `🌊
      Atlantis` nel test). Ancora da confermare: valore per `sensor`
      (quarto tipo visto nell'app, mai osservato nei nostri dati).
- [x] **Trovata distinzione importante: "discovery list" app ≠ dato
      recuperabile dal device.** La schermata `Discover` dell'app
      mostra 877 contatti anche a device **offline** — ma lo storage
      totale del device è solo 1404kb, fisicamente insufficiente per
      quella mole di dati. È quasi certamente una **cache lato
      telefono**, costruita nel tempo dall'app stessa via BLE — non
      un dato interrogabile dal device a posteriori. **Conseguenza
      per l'obiettivo §1.2** (pagina frontend con path degli advert):
      non esiste un comando "dammi la cronologia scoperte" da
      chiedere al device — va costruita da `trace-mon` stesso,
      ascoltando in continuo `ADVERTISEMENT`/`RX_LOG_DATA` (payload
      `ADVERT`) e persistendo via via, esattamente come fa l'app sul
      telefono ma lato Raspberry.
- [ ] **BUG TROVATO (da correggere)**: `tools/test_contacts_list.py`
      assume `out_path_len == 255` per "path sconosciuto"
      (`OUT_PATH_UNKNOWN`), ma i dati reali del test mostrano `-1`
      per più contatti (`Vigevano-Osservatore`, `Valerio`,
      `IT-LIG-PianiInvrea-R`, `Atlantis`) — probabile che la libreria
      interpreti il byte come **signed** (`0xFF` unsigned = `-1`
      signed), quindi il confronto `== 255` non scatta mai per questi
      casi. Va corretto ad accettare anche `-1`.
- [ ] Esiste in `meshcore_py` un comando per **rimuovere** un contatto
      dal device (`remove_contact` o simile)? RT ha
      `_evict_removed_contact_from_library_cache` — da capire se è
      solo una pulizia della cache locale della libreria o se comanda
      davvero il device. Meno urgente ora che sappiamo che il device
      ha già una propria eviction nativa (`Overwrite Oldest`).
- [ ] Formato di storage per il nostro store interno: file gestito
      direttamente da `trace-mon` (es. JSON) vs SQLite leggero — la
      necessità di uno storico nel tempo (non solo stato corrente),
      emersa per l'obiettivo §1.2, orienta più verso SQLite.
- [ ] Che granularità di storico serve per la pagina frontend: solo
      l'ultimo path noto per advert, o uno storico nel tempo
      (utile per vedere se un contatto cambia spesso percorso)?

## 7. Decisione: formato di storage

**SQLite**, deciso il 2026-08-07. Ragionamento (non solo la scelta, il
perché):

- Lo scopo reale di `trace-mon` — dichiarato esplicitamente
  dall'utente in questa sessione — è **analisi nel tempo** di come i
  path dei nodi cambiano/falliscono/si stabilizzano, non un semplice
  elenco statico di nodi conosciuti. Il dato naturale è quindi
  **osservazioni ripetute per nodo nel tempo** (un punto dati per
  advert ricevuto: timestamp, path, hop count, RSSI/SNR), non un
  record singolo per nodo.
- Con 1000+ nodi attesi e raccolta su mesi, un JSON/JSONL degrada su
  query storiche (richiede scansione completa ogni volta) — SQLite
  offre query indicizzate a quella scala senza logica di
  parsing/filtro scritta a mano.
- **SQLite non è un DB "pesante"**: file singolo, nessun processo
  server, incluso nella libreria standard Python (`sqlite3`) — sul
  piano dell'ingombro operativo è equivalente a un file JSON, non un
  salto di complessità.
- **Esplicitamente NON si clona lo schema di Remote Terminal**: RT
  usa SQLite per uno scopo molto più ampio (messaggi, canali,
  telemetria, preferiti, storico nomi — decine di tabelle). Per lo
  scopo di `trace-mon` bastano **due tabelle**, coerente con lo stesso
  principio di sobrietà già applicato nel resto del progetto.
- Ispezionabilità via SSH: non è grep-abile come JSON, ma il CLI
  `sqlite3` (preinstallato su Raspbian/Debian) rende una query al volo
  altrettanto immediata di un `grep`, con filtro strutturato in più —
  compromesso accettato consapevolmente dall'utente, che gestisce già
  altri progetti con interrogazioni SQL dirette.

### Schema definitivo

Rifinito alla luce del test di dedup (§6): `path_observations` è
alimentata da `RX_LOG_DATA`, non da `ADVERTISEMENT` — lo schema
riflette i campi realmente disponibili da quella sorgente.

```sql
CREATE TABLE nodes (
    public_key    TEXT PRIMARY KEY,
    adv_name      TEXT,
    node_type     INTEGER,       -- 1=chat, 2=repeater, 3=room server
    adv_lat       REAL,
    adv_lon       REAL,
    out_path_len  INTEGER,       -- ultimo valore noto da get_contacts(); NULL/255/-1 = sconosciuto
    out_path      TEXT,
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL
);

CREATE TABLE path_observations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key     TEXT NOT NULL REFERENCES nodes(public_key),
    observed_at    INTEGER NOT NULL,   -- recv_time: quando l'abbiamo ricevuto noi
    adv_timestamp  INTEGER,            -- timestamp dichiarato dal mittente nell'advert
    pkt_hash       INTEGER,            -- identifica la trasmissione originale
    path_hex       TEXT,
    hop_count      INTEGER NOT NULL,
    route_type     TEXT,               -- es. TC_FLOOD
    transport_code TEXT,
    rssi           REAL,
    snr            REAL
);

CREATE INDEX idx_path_obs_node_time ON path_observations(public_key, observed_at);
CREATE INDEX idx_path_obs_pkt_hash  ON path_observations(pkt_hash);
```

**Scelte non ovvie, spiegate:**

- **`out_path`/`out_path_len` su `nodes`** sono stato corrente
  (upsert a ogni sync), non storico — dato concettualmente diverso da
  `path_observations` (routing per rispondere OGGI vs path con cui è
  arrivato UN advert specifico, distinzione già chiarita in §4). Uno
  storico di questo dato, se servisse in futuro, è una terza tabella
  piccola da aggiungere — non prevista ora, evita scope creep.
- **`pkt_hash`**: confermato dai dati di `exp05` che resta identico
  anche quando lo stesso advert arriva per percorsi diversi (diretto
  + via `0d28`, stesso valore in entrambe le osservazioni) — non
  dipende dal path, solo dal contenuto. Identificativo naturale per
  raggruppare in analisi future "quante volte/da che percorsi è stata
  sentita la stessa trasmissione", senza doverlo dedurre a posteriori.
- **`adv_timestamp` separato da `observed_at`**: il primo è quando il
  mittente ha generato l'advert, il secondo è quando lo abbiamo
  ricevuto noi — un advert vecchio ripetuto in ritardo da un
  repeater avrebbe `adv_timestamp` fisso ma `observed_at` diverso a
  ogni ricezione.
- **Nessun vincolo `UNIQUE`**, come deciso in §6 — ogni riga è una
  ricezione fisica distinta, comprese le ripetizioni via percorsi
  diversi.

**Nota implementativa** (non schema, da tenere a mente nel codice):
SQLite non applica i vincoli `FOREIGN KEY` di default — va abilitato
esplicitamente per connessione (`PRAGMA foreign_keys = ON`). Il
flusso di scrittura dovrà sempre fare l'upsert su `nodes` **prima**
di inserire in `path_observations` per lo stesso `public_key`.

## 8. Prossimi passi

- [x] Configurare sul device (via app, una tantum) `Auto Add
      Selected` con Chat/Repeater/Room Server abilitati — **fatto**
      (2026-08-07).
- [x] **Dedup/unicità delle osservazioni — RISOLTA con test empirico
      (2026-08-07)**: confermato che `EventType.ADVERTISEMENT`
      deduplica a monte, stesso meccanismo dei messaggi di canale
      (stesso `pkt_hash` → un solo evento, indipendentemente da
      quante volte il pacchetto arriva per strade diverse). **Ma**
      emerso un dettaglio che cambia la sorgente dati corretta:
      `ADVERTISEMENT` **non porta alcuna informazione di path**
      (payload = solo `{'public_key': ...}`) — tutto il dato utile
      (`path`, `path_len`, `rssi`, `snr`) sta esclusivamente in
      `RX_LOG_DATA` (filtrato su `payload_typename == 'ADVERT'`),
      che **non** deduplica le ricezioni multiple per lo stesso
      advert.
      **Decisione presa**: `path_observations` va alimentata da
      `RX_LOG_DATA`, non da `ADVERTISEMENT` — e le ricezioni multiple
      dello stesso advert per percorsi fisici diversi (es. diretto +
      ripetuto da `0d28`, osservato nel test) sono **dati voluti, non
      rumore da filtrare**: rappresentano la ridondanza reale della
      rete, coerente con lo scopo analitico di `trace-mon` (§1).
      Nessun vincolo `UNIQUE` su `path_observations`, confermato.
      `ADVERTISEMENT` resta utile solo come segnale leggero
      ("è arrivato un advert nuovo") per eventualmente innescare un
      refresh di `get_contacts()`, non come sorgente dei dati di
      path.
- [x] **Meccanismo di acquisizione — aggiornato dopo il test di
      dedup.** Due canali distinti, non intercambiabili:
      - `RX_LOG_DATA` (filtrato `ADVERT`) in ascolto live — sorgente
        dei dati di path (`path`, `path_len`, `rssi`, `snr`) per
        `path_observations`, una riga per ogni ricezione fisica
        (percorsi multipli = dati distinti, non deduplicare).
      - `NEW_CONTACT`/`ADVERTISEMENT` in ascolto live — segnale
        leggero per aggiornare `nodes` (nome, tipo, `last_seen`) e
        per eventualmente innescare un refresh mirato.
      - Sync periodico (`get_contacts()`, es. ogni ora) come rete di
        sicurezza — cattura eventi persi durante downtime del daemon
        e tiene aggiornato `out_path` anche per contatti silenziosi,
        stesso principio già usato per trace/advert (schedulazione
        primaria + rete di sicurezza).
- [x] **Liberare memoria sul device — deciso: non serve intervento
      attivo in questa prima versione.** Il device ha già una propria
      eviction nativa (`Overwrite Oldest`, confermata in §6) — si
      lascia che il firmware gestisca la propria capacità come
      progettato, il nostro store persistente cattura tutto prima
      di un'eventuale sovrascrittura grazie all'ascolto in tempo
      reale. Meno codice, meno rischio di rimuovere per errore un
      contatto che il bot sta ancora usando per `out_path`. Rivedibile
      in futuro se si rivela insufficiente.
- [x] **Design del servizio — deciso**: nuovo `ContactSyncService`,
      stesso stile di `TraceService`/`AdvertService`/`BotService`
      (modulo di infrastruttura con sottoscrizione eventi + sync
      periodico + scrittura SQLite). Il frontend Node.js legge il
      file SQLite **direttamente**, senza passare da IPC — stesso
      pattern già in uso oggi con `trace.json`. Comandi IPC dedicati
      solo per diagnostica (stile `system.contacts`), non per la
      lettura applicativa dei dati.

## 9. Nota per il futuro: ristrutturazione directory frontend

Decisione presa (non ancora eseguita, rimandata deliberatamente):
quando si arriverà a lavorare sui dati da visualizzare, la parte
frontend Node.js esistente (`server.js`, `parser.js`, `public/`,
`package.json`, `node_modules/`) verrà spostata dentro una nuova
directory `frontend/` alla root di `trace-mon/`, invece di restare
sparsa nella root del progetto insieme al backend Python.

**Esplicitamente NON bloccante ora**: la parte trace attuale resta
com'è, invariata, finché il backend (`ContactSyncService` +
schema SQLite) non è pronto — nessuna modifica al frontend prima
di allora.

**Completata (2026-08-07)**: `server.js`, `parser.js`,
`mesh-nodes.json`, `public/` spostati in `frontend/` sulla root di
`trace-mon/`. Unica modifica di codice necessaria: in
`frontend/server.js`, `FILE` (trace.json) e `BACKUP_DIR` risalgono di
una cartella (`../data/`, `../backup/`, restati nella root del
progetto), mentre `MESH_NODES_FILE` resta invariato (spostato insieme
a `server.js` dentro `frontend/`). `parser.js` non ha richiesto
modifiche (riceve i path come parametro, nessun riferimento
assoluto). Verificato funzionante senza regressioni (`/api/data`,
`/api/meshnodes`).

## 10. Lettura di `contacts.db` da Node.js — decisione tecnica

**`node:sqlite` nativo**, non `better-sqlite3`/altre dipendenze npm.
Confermato dalla documentazione ufficiale (Node 24): *"SQLite is no
longer behind `--experimental-sqlite` but still experimental.
Stability: 1.2 — Release candidate."* — funziona senza flag su Node
24 (nodo: 24.19.0, collettore: 24.16.0, da allineare a 24.x).
Resta formalmente sperimentale, ma per uno strumento interno è una
scelta ragionevole coerente con l'approccio a dipendenze minime già
tenuto nel resto del progetto — un solo punto di codice da aggiornare
in futuro se l'API cambiasse.

`DatabaseSync` (sincrona, si sposa con lo stile già usato in
`server.js`), da aprire in **sola lettura** — il processo Node non
deve mai scrivere su `contacts.db`, resta compito esclusivo del
daemon Python. Opzione esatta per l'apertura read-only da verificare
al momento di scrivere il codice (non ancora confermata con
certezza).

**Non ancora implementato**: l'integrazione vera e propria (nuove
API in `server.js`, pagine frontend) è rimandata a quando si
discuteranno i dati da mostrare — qui si è chiusa solo la parte
tecnica abilitante (dove vivono i file, come leggere SQLite da
Node).

## 11. Implementazione v1 (2026-08-07)

`ContactSyncService` implementato:

```
mesh_modules/contact_sync/
  db.py           # ContactDB: schema, upsert_node, insert_path_observation
  contact_sync.py # ContactSyncModule: sottoscrizioni + sync periodico
  service.py      # ContactSyncService (wrapper per il daemon)
```

**Scostamento dal piano originale (§8), scoperto scrivendo il
codice**: niente sottoscrizione separata a `NEW_CONTACT`/
`ADVERTISEMENT` — `RX_LOG_DATA` (filtrato `ADVERT`) porta già tutti i
campi di identità del nodo (nome, tipo, posizione) necessari per
aggiornare `nodes`, oltre ai dati di path per `path_observations`.
Sottoscrivere anche gli altri due eventi sarebbe stato ridondante per
i nostri scopi — semplificazione, non una funzionalità mancante.

Config aggiunta: sezione `contacts:` (`db_file`, `sync_interval`) +
voce `contact_sync` in `services:`.

Il frontend leggerà `data/contacts.db` direttamente, senza IPC —
stesso pattern già in uso con `trace.json`. Nessun comando IPC
applicativo esposto in questa versione (solo diagnostica già
esistente, `system.contacts`, che legge dal device, non dal DB).

**Da testare**: avvio pulito, scrittura corretta su ricezione advert
reale, sync periodico, comportamento dopo un reconnect completo
(verifica che il rebind ri-sottoscriva correttamente).

**Validato in produzione (2026-08-07)**: primo avvio, sync iniziale
106 nodi scritti correttamente in `nodes` (verificato via `sqlite3`
CLI, dati coerenti con `test_contacts_list.py`). `path_observations`
confermata funzionante in tempo reale: un advert flood di test ha
prodotto le due righe attese (diretto + via `0d28`, stesso pattern di
`exp05`). Bonus: il DB ha già catturato passivamente path reali di
nodi esterni fino a 7-8 hop — conferma che l'obiettivo analitico
originale (§1) funziona anche oltre i soli device di test.

Ancora da verificare: comportamento dopo un reconnect completo del
daemon (rebind).

## 12. Nuova domanda aperta: ripristino su richiesta di contatti espulsi

Emersa da un dubbio dell'utente, verificata nel sorgente di RT
(`radio_sync.py`, funzione `ensure_contact_on_radio` +
`_load_contacts_to_radio`): **RT non lascia mai un contatto
definitivamente escluso dal DM** — quando serve parlarci, ricarica
quel contatto specifico sul device su richiesta (dal proprio DB),
usando `mc.commands.add_contact(radio_contact_payload)`, con
throttling per non abusare del canale radio.

**Risponde anche a una domanda lasciata aperta in §6**: sì, esiste un
comando `add_contact()` in `meshcore_py` per aggiungere esplicitamente
un contatto al device.

**Implicazione per il nostro `BotService`**: oggi (v1, deciso in
`ARCHITECTURE.md` §21) un DM da un `pubkey_prefix` non presente nella
`contact list` del device viene **ignorato** — se quel nodo è stato
espulso dal device per eviction nativa (`Overwrite Oldest`, inevitabile
prima o poi con centinaia di nodi), non potrà più fare DM col bot,
anche se il nostro DB SQLite ha ancora tutta la sua storia.

**Possibile estensione (non ancora decisa)**: quando il lookup sul
device fallisce, cercare il `pubkey_prefix` nel nostro DB e, se
trovato, ricaricarlo sul device al volo prima di rispondere —
pattern identico a `ensure_contact_on_radio` di RT.

**Cosa manca per farlo**: lo schema `nodes` attuale (§7) non ha tutti
i campi necessari per ricostruire il payload di `add_contact()` —
mancano almeno `flags`, `out_path_hash_mode`, `last_advert`,
`lastmod` (visti nel dump reale di un contatto, sessione precedente).
Andrebbero aggiunti se si sceglie questa strada.

**Decisione da prendere con l'utente**: implementare questo
ripristino su richiesta (v2 del bot DM), o accettare come limite noto
che un nodo espulso dal device non possa più fare DM finché non
manda un nuovo advert che lo riporta in contact list naturalmente?

**Deciso e implementato (2026-08-07)**: sì, con cautela — tutto dietro
un flag di config **spento di default**
(`bot.restore_chat_contacts: false`), limitato ai soli nodi
**CHAT** (`node_type=1`), attivabile per verifiche senza impattare il
comportamento esistente.

Modifiche:
- **Schema `nodes` esteso**: `flags`, `out_path_hash_mode`,
  `last_advert`, `lastmod` — popolati **solo** dal sync periodico
  completo (`get_contacts()`), non da `RX_LOG_DATA` (che non porta
  questi campi). Migrazione additiva (`ALTER TABLE ... ADD COLUMN`)
  applicata automaticamente all'avvio, sicura su un database già
  popolato.
- **`ContactDB.find_chat_contact_for_restore(prefix)`**: cerca un
  nodo CHAT con dati completi (solo se già passato per almeno un
  sync periodico prima di essere espulso — un nodo mai sincronizzato
  per intero non è ripristinabile).
- **`BotModule`**: quando un DM arriva da un `pubkey_prefix` non
  presente nella contact list del device, se il flag è attivo cerca
  il mittente nel DB e, se trovato, lo ricarica con
  `mesh.commands.add_contact(payload)` prima di procedere — altrimenti
  il comportamento resta quello di v1 (ignora il DM).
- Connessione al DB creata in `BotModule` **solo se il flag è
  attivo** — a flag spento, nessun tocco a SQLite da parte del bot.

**Non ancora testato sul campo** — da verificare quando un nodo CHAT
reale viene espulso e manda un DM col flag attivo.

**TESTATO E CONFERMATO NON FUNZIONANTE per lo scopo previsto
(2026-08-07)**: test con `debug=True` e contatto rimosso manualmente
dal device. Il pacchetto DM arriva davvero a livello radio — `RX_LOG_DATA`
scatta regolarmente per tutti e tre i tentativi di retry (visti anche
via `0d28`) — ma **`CONTACT_MSG_RECV` non scatta mai**. Il device
riceve il pacchetto ma non riesce a decifrarlo (non ha più la chiave
pubblica del mittente) — l'evento di alto livello a cui `BotModule`
è iscritto **non esiste** per questo caso, non arriva vuoto: non
arriva proprio.

**Causa strutturale, non un bug**: per decifrare un DM serve già
conoscere il mittente — non si può usare la ricezione del DM come
innesco per "scoprire" chi è e ripristinarlo, l'ordine logico è
invertito. Aggravante: anche volendo agganciarsi al pacchetto grezzo
(`RX_LOG_DATA`) invece che a `CONTACT_MSG_RECV`, l'unico dato
identificativo del mittente presente nel payload cifrato è **un solo
byte** troncato — insufficiente per un lookup affidabile su migliaia
di nodi possibili.

**Coerente con come RT usa realmente `ensure_contact_on_radio()`**:
solo **in uscita**, quando l'app inizia lei una conversazione verso
un contatto scelto dal proprio DB — mai in reazione a un DM in arrivo
da uno sconosciuto, perché a quel punto la decifratura è già fallita.

**Unica via di recupero reale**: l'advert naturale del nodo rimosso —
quando arriva, l'auto-add del device (già configurato) lo fa
rientrare da solo in contact list, e da quel momento i DM tornano a
funzionare. Nessun intervento software può accelerarlo, il vincolo è
crittografico, non applicativo.

**Stato del codice**: resta nel progetto, flag spento di default
(`bot.restore_chat_contacts: false`) — **innocuo ma di fatto
irraggiungibile** per lo scenario "DM in arrivo da contatto rimosso",
perché `_on_contact_message` non viene mai invocato in quel caso.
Non rimosso dal codice per ora (potrebbe tornare utile per uno scopo
diverso — es. ripristino proattivo prima di un invio iniziato da noi,
non reattivo a un DM in arrivo — ma è un caso d'uso diverso da quello
per cui era stato scritto, da riconsiderare se mai servisse).

**Corollario confermato dall'utente (2026-08-07)**: la stessa causa
rende irraggiungibile anche il log "DM da mittente sconosciuto...
ignorato" già presente dalla v1 del bot (`ARCHITECTURE.md` §21) — non
solo il ripristino. Per un contatto realmente assente dal device, il
bot non produce **nessuna** riga di log, non un "ignorato" esplicito:
vero silenzio, perché l'evento che lo permetterebbe
(`CONTACT_MSG_RECV`) non scatta mai. Corretto anche in
`ARCHITECTURE.md` §21 per riflettere questo.

**Pulizia del codice (2026-08-07)**: rimossi da `BotModule`
`_try_restore_contact()`, l'import di `ContactDB`, e il flag
`bot.restore_chat_contacts` (config.yaml) — tutta la logica di
ripristino reattivo, confermata inutile. Rimosso anche
`ContactDB.find_chat_contact_for_restore()` in `db.py`, usato solo da
quella logica. **Le quattro colonne dello schema `nodes`** (`flags`,
`out_path_hash_mode`, `last_advert`, `lastmod`) **restano** — decisione
esplicita dell'utente: arrivano gratis dal sync periodico
(`get_contacts()`) e hanno valore analitico a prescindere dal
ripristino ormai abbandonato (es. `last_advert`/`lastmod` per capire
quando un nodo si è fatto sentire l'ultima volta).

**Nota sui preferiti (2026-08-07)**: il concetto di contatto
"preferito", impostabile dall'app direttamente sul device, è
indipendente da questo meccanismo e resta valido — un nodo preferito
**non viene mai espulso** dall'eviction nativa (`Overwrite Oldest`
salta esplicitamente i preferiti, confermato nello screenshot di
`Contact Settings`). In pratica: curando manualmente un set di
preferiti tra i nodi CHAT più rilevanti, quelli non avranno mai
bisogno del ripristino — la funzione appena implementata copre solo
il caso "imprevisto", nodi CHAT non preferiti espulsi senza
preavviso.

## 13. Query utili per ispezionare il DB

Raccolta di query dirette (`sqlite3` CLI) per verificare i dati
raccolti — utile sia per controlli occasionali sia come riferimento
quando si scrivono le query del futuro frontend.

**Struttura e conteggio generale:**

```bash
sqlite3 data/contacts.db ".schema"
sqlite3 data/contacts.db "SELECT COUNT(*) AS nodi FROM nodes;"
sqlite3 data/contacts.db "SELECT COUNT(*) AS osservazioni FROM path_observations;"
```

**`nodes` — vista leggibile con timestamp convertiti:**

```bash
sqlite3 data/contacts.db "
SELECT
    adv_name,
    CASE node_type WHEN 1 THEN 'chat' WHEN 2 THEN 'repeater' WHEN 3 THEN 'room server' ELSE 'sconosciuto('||node_type||')' END AS tipo,
    out_path_len,
    out_path,
    datetime(last_advert, 'unixepoch', 'localtime') AS ultimo_advert,
    datetime(last_seen, 'unixepoch', 'localtime') AS ultimo_visto
FROM nodes
ORDER BY last_seen DESC
LIMIT 20;
"
```

**`path_observations` — le osservazioni più recenti, leggibili
(join con `nodes` per il nome):**

```bash
sqlite3 data/contacts.db "
SELECT
    n.adv_name,
    datetime(p.observed_at, 'unixepoch', 'localtime') AS ricevuto,
    p.hop_count,
    p.path_hex,
    p.rssi,
    p.snr,
    p.route_type
FROM path_observations p
JOIN nodes n ON n.public_key = p.public_key
ORDER BY p.observed_at DESC
LIMIT 20;
"
```

**Storico completo di un nodo specifico** (utile per vedere se il
path è stabile o cambia spesso nel tempo — sostituire il prefisso
con quello della chiave pubblica di interesse):

```bash
sqlite3 data/contacts.db "
SELECT
    datetime(observed_at, 'unixepoch', 'localtime') AS ricevuto,
    hop_count,
    path_hex,
    rssi,
    snr
FROM path_observations
WHERE public_key LIKE '4f3acedf%'
ORDER BY observed_at DESC;
"
```

**Quanti nodi per tipo:**

```bash
sqlite3 data/contacts.db "
SELECT
    CASE node_type WHEN 1 THEN 'chat' WHEN 2 THEN 'repeater' WHEN 3 THEN 'room server' ELSE 'sconosciuto' END AS tipo,
    COUNT(*) AS conteggio
FROM nodes
GROUP BY node_type;
"
```

**Formattazione più leggibile da terminale** (header + colonne
allineate invece della barra verticale di default):

```bash
sqlite3 -header -column data/contacts.db "SELECT adv_name, node_type, out_path_len FROM nodes LIMIT 10;"
```

## 14. Prima pagina frontend: tabella nodi (2026-08-07)

Implementata e validata sul nodo (`Vigevano-Tracciatore`):

- **Navigazione**: tab dentro la stessa pagina (`tracePage`/`nodesPage`),
  nessun ricaricamento — stesso stile visivo di `.rangeButton`
  riusato per `.tabButton`.
- **`GET /api/nodes`** (`frontend/server.js`): legge `nodes` da
  `../data/contacts.db` via `node:sqlite` (`DatabaseSync`, apertura
  `{ readOnly: true }`), ordinati per `last_seen` decrescente.
- **Tabella** (`frontend/public/app.js`, `loadNodesTab()`/
  `renderNodesTable()`): nome, tipo (mappato da `node_type`),
  ultimo advert, path — stessa logica di formattazione del path già
  vista lato Python (`out_path_len` 255/-1 → "FLOOD non ancora noto",
  0 → "DIRECT", altrimenti split degli hop).

**Nota per la versione collettore** (da fare quando questa versione
sarà considerata stabile): stessa tabella/formattazione, ma
`/api/nodes` dovrà accettare un parametro `?node=node_01` per
selezionare quale `data/node_XX/contacts.db` leggere (stesso pattern
già in uso per `trace.json` sul collettore), più un selettore di nodo
nell'interfaccia — non presente sul nodo (dove c'è un solo database).

**Prossimo**: valutare se aggiungere ordinamento cliccabile per
colonna, filtro per tipo, o ricerca per nome — da decidere guardando
la tabella con dati reali.

## 15. Correzioni tabella nodi + vista dettaglio (2026-08-07)

**Correzioni alla tabella nodi**: timestamp in formato 24h esplicito
(`toLocaleString("it-IT", {hour12:false})`), colonna path corretta
per mostrare il path REALE dell'ultimo advert osservato
(`path_observations`/`RX_LOG_DATA`, via `LEFT JOIN` nella query
server) invece di `out_path` (stato di routing per rispondere, dato
diverso — vedi §4).

**Vista dettaglio nodo**: nome del nodo nella tabella diventa un
link, apre una terza "pagina" (`nodeDetailPage`, raggiungibile solo
da click, nessun pulsante di tab dedicato) con:
- Info nodo (tipo, chiave pubblica, posizione, ultimo advert/attività).
- Grafico Chart.js **RSSI/SNR nel tempo, doppio asse Y** (RSSI a
  sinistra, SNR a destra — scale diverse, non comparabili su un
  solo asse).
- Tabella storico osservazioni, più recente in cima.
- Link "torna alla lista".

**Nuova API**: `GET /api/nodes/:publicKey` — info nodo +
`path_observations` in ordine cronologico crescente (comodo per il
grafico, la tabella lato client la inverte per mostrare le più
recenti in cima).

**Nota tecnica**: usato `db.prepare(...).all(publicKey)` (non
`.get()`) per il nodo singolo — prudenza per non scommettere su un
metodo di `node:sqlite` mai verificato, dato che `.all()` è già
confermato funzionante.

**Episodio di corruzione da copia-incolla (2026-08-07)**: un
carattere `<` perso durante il trasferimento manuale di un blocco di
codice dalla chat ha causato un `SyntaxError` che ha bloccato
l'intero script (non solo la parte nuova) — diagnosticato tramite
Console del browser. Risolto ridistribuendo i file come download
diretti (verificati con `node --check` prima della consegna) invece
di testo da copiare — **workflow adottato da qui in poi per tutti i
file di codice di questo progetto**, non solo per questo episodio.

**Tutte e due le viste del frontend nodo (tabella + dettaglio)
validate e funzionanti in produzione.**

## 16. Versione collettore: pagine Nodi (2026-08-07)

**Implementata e validata**, speculare alla versione nodo, riusando
il meccanismo di selezione multi-nodo già esistente (`#nodeSelector`,
popolato da `/api/node/list`, persistito in `localStorage`
`selectedNode`) — nessun nuovo meccanismo di selezione inventato.

**Rotte aggiunte a `server.js`** (`GET /api/nodes?node=X`,
`GET /api/nodes/:publicKey?node=X`): stesso schema del nodo singolo,
con **controllo esplicito `fs.existsSync()`** prima di aprire
`data/<node>/contacts.db` — se il file non esiste (nodo non ancora
aggiornato al nuovo software), risposta vuota (`[]`) o `404` pulito,
**mai errore 500**. A differenza del pattern esistente per
`trace.json` (che invece propaga un 500 se il file manca) — scelta
deliberata, dato lo scenario reale di rollout parziale su più nodi.

**Client (`app.js`)**: stesse funzioni della versione nodo, con
`?node=` aggiunto a ogni chiamata leggendo `localStorage`. Messaggio
esplicito ("Nessun dato disponibile per questo nodo — verifica che
l'aggiornamento sia stato applicato") invece di tabella vuota
silenziosa.

**Bug trovato e corretto in produzione**: il listener esistente sul
cambio nodo (`nodeSelector`) ricaricava solo i dati della tab Trace,
non quelli della tab Nodi — cambiare nodo restando sulla tab Nodi non
aggiornava nulla finché non si ricaricava la pagina o si passava da
un'altra tab. Corretto: il listener ora controlla quale tab è
visibile e ricarica di conseguenza; se si è nel dettaglio di un nodo
specifico, si torna alla lista (la chiave pubblica visualizzata si
riferiva al nodo precedente, non ha senso restarci sopra).

**Metodo di lavoro adottato per file esistenti grandi** (`app.js` del
collettore, 1401 righe): invece di ricostruire il file a memoria,
modifiche fatte programmaticamente sulla copia reale del file
(script Python/sed su file locali), verificate con `node --check`
prima di consegnarle come download — stesso principio del workflow
"file scaricabili" già adottato, esteso anche a come vengono
*prodotte* le modifiche, non solo a come vengono *consegnate*.

**Script di sincronizzazione** (`contact_sync.sh`, cron ogni 5
minuti): `VACUUM INTO` per lo snapshot consistente + `scp` verso
`data/node_01/contacts.db` sul collettore, stesso pattern di
porta/utente/host già in uso per `trace.json`/`mesh-nodes.json`.

**Stato attuale**: `node_01` aggiornato e funzionante su tutta la
catena (daemon → sync → collettore). `node_02`/`node_03` da
aggiornare quando l'utente deciderà — nel frattempo il collettore li
gestisce correttamente mostrando "nessun dato disponibile" invece di
errori.

## 17. Filtri client-side sulla tabella Nodi (2026-08-08)

Implementati e validati su entrambe le versioni frontend (Nodo e
Collettore), sopra la tabella esistente, senza aggiungere nuove
chiamate al backend — filtrano i dati già caricati in
`nodesDataCache` (`app.js`/`collector_app.js`), lato client:

- **Filtro testo "Path contains"** (`#nodePathFilterInput`): substring
  case-insensitive su `path_hex` — es. digitando `3075` la tabella
  mostra solo i record il cui path (quello reale dell'ultimo advert,
  vedi §4) contiene quell'hash in una qualsiasi posizione della
  catena. Aggiornamento live a ogni carattere digitato, pulsante
  "Clear" per azzerarlo.
- **Filtro "Path length"** (`#nodePathLengthFilter`): All / 1 byte (2
  caratteri hex) / 2 byte (4) / 3 byte (6), calcolato dividendo
  `path_hex.length` per `hop_count` — stessa logica già usata da
  `formatAdvertPath()`. I record `DIRECT` (0 hop, nessun path) o senza
  osservazioni sono esclusi da questo filtro, dato che non hanno un
  path definito da misurare.

Le selezioni si salvano in `localStorage` (stesso pattern degli altri
selettori esistenti) e si riapplicano automaticamente a ogni refresh
(manuale o auto-refresh a 5 min). Il conteggio nell'intestazione
("Known Nodes - N ...") riflette solo i record filtrati, non il totale
assoluto.
