# Neighbor Monitoring — status/neighbours/telemetria/regioni/config dei repeater

Ultimo aggiornamento: 2026-08-08

Stato: **implementato — validato sul campo per il nucleo
status/neighbours/telemetria/regioni; l'estensione config via login
(§12) implementata e testata solo con mock/sintetico, non ancora
deployata sul Raspberry**. Questo documento resta come riferimento
tecnico delle decisioni prese e verificate, sullo stesso spirito di
CONTACT_MANAGEMENT.md.

## 1. Obiettivo

Interrogare periodicamente uno o più repeater MeshCore configurati
(via richiesta radio diretta, non tramite advert/trace) per ottenere:

- **Status del repeater**: batteria, code interne, statistiche di
  traffico (pacchetti inviati/ricevuti, flood vs direct, duplicati,
  errori), uptime.
- **Elenco neighbours**: gli altri nodi che il repeater interrogato
  sente direttamente, con SNR e tempo dall'ultima osservazione.
- **Telemetria**: canali sensore in formato Cayenne LPP (per
  IK2XYP-RPT: tensione batteria e temperatura, entrambi sul canale 1
  — nomenclatura del device, non nostra). Aggiunta dopo la prima
  versione (§10), stesso meccanismo di richiesta di status/neighbours.

Motivazione pratica: capire, per un repeater a cui ci si vuole
collegare, quali altri nodi noti sono raggiungibili nella sua
prossimità — un'informazione che gli advert/trace da soli non danno
(quelli mostrano solo la rete vista dal *nostro* nodo, non dal punto
di vista del repeater stesso).

**Indipendente dalla tab Nodes esistente**: i repeater da interrogare
NON vengono scelti dalla tabella Nodi — sono definiti esplicitamente
in configurazione (§4). L'unico punto di contatto con `contacts.db` è
la risoluzione dei nomi: le chiavi pubbliche (troncate) restituite
nell'elenco neighbours vengono confrontate con `nodes.public_key` per
mostrare un nome invece di un prefisso esadecimale, nient'altro.

## 2. Prerequisito operativo: ACL sul repeater (nessun codice coinvolto)

A differenza di trace (un pacchetto che rimbalza e produce sempre una
misura, indipendentemente da permessi) e di advert (broadcast), le
richieste di status/neighbours sono **request/response con controllo
d'accesso**: il repeater interrogato le accetta solo se chi le invia
è nella sua ACL (access control list) con permesso di lettura.

Inserire la chiave pubblica del nostro nodo (Vigevano-Tracciatore)
nell'ACL del repeater da interrogare è un'operazione **manuale**,
fatta direttamente sul repeater da chi lo amministra — nel caso
attuale, già fatta dall'utente su IK2XYP-RPT. **Il nostro codice non
implementa né gestisce questo passaggio**, lo assume come prerequisito
già soddisfatto per ogni repeater elencato in configurazione.

Conseguenza pratica per la gestione errori (§8): una richiesta senza
i permessi necessari e una richiesta che si perde per condizioni
radio sono **indistinguibili — confermato empiricamente, non solo
per analisi del codice** (vedi addendum sotto).

**Addendum — verificato con test reale sul campo (2026-08-08)**:
confronto diretto tramite cattura del traffico grezzo (`debug=True`)
tra una query verso IK2XYP-RPT con ACL attiva e la stessa query con
ACL disattivata, stesso repeater, stessa sessione. Con ACL attiva,
dopo l'invio arrivano `MSG_SENT` (conferma locale di trasmissione),
`RX_LOG_DATA` (traffico grezzo in arrivo), `STATUS_RESPONSE` e
`NEIGHBOURS_RESPONSE`. Con ACL disattivata, **arriva solo
`MSG_SENT`** — zero occorrenze di `RX_LOG_DATA`, zero `ERROR`, nessun
frame di alcun tipo dal repeater. Il repeater non invia alcun
rifiuto esplicito: ignora silenziosamente la richiesta. Confermato
che non esiste alcun segnale distintivo a nessun livello dello stack
(dai byte grezzi in su) — la domanda è chiusa definitivamente, non
solo per assunzione ragionevole.

## 3. Funzioni `meshcore_py` — verificate nel sorgente (non dedotte dalla CLI)

Libreria ispezionata direttamente (`commands/binary.py`,
`parsing.py`, `reader.py`, `events.py`):

- `mesh.commands.req_status_sync(contact, timeout=0, min_timeout=0)`
  — restituisce un dict con chiavi identiche 1:1 all'output JSON di
  `meshcore-cli req_status` (`pubkey_pre`, `bat`, `tx_queue_len`,
  `noise_floor`, `last_rssi`, `nb_recv`, `nb_sent`, `airtime`,
  `uptime`, `sent_flood`, `sent_direct`, `recv_flood`, `recv_direct`,
  `full_evts`, `last_snr`, `direct_dups`, `flood_dups`, `rx_airtime`,
  `recv_errors` — quest'ultimo `None` su firmware ante-1.12.0, frame
  più corto).
- `mesh.commands.fetch_all_neighbours(contact, order_by=0, pubkey_prefix_length=4, timeout=0, min_timeout=0)`
  — preferibile a `req_neighbours_sync()` da sola: pagina
  automaticamente se il repeater avesse più neighbours di quanti ne
  stiano in una risposta (costo aggiuntivo nullo quando, come
  nell'esempio fornito, tutti i 19 neighbours arrivano in un'unica
  risposta). Restituisce `{pubkey_prefix, pubkey_prefix_length,
  neighbours_count, results_count, neighbours: [{pubkey, secs_ago,
  snr}, ...]}` — anche qui, campi identici alla CLI.
- `mesh.commands.req_telemetry_sync(contact, timeout=0, min_timeout=0)`
  — aggiunta nella Fase 10 (§10). Restituisce direttamente una lista
  (non incapsulata in un dict come `fetch_all_neighbours`) di canali
  `{"channel": N, "type": "voltage"|"temperature"|..., "value": <numero>}`,
  formato Cayenne LPP già decodificato dalla libreria
  (`lpp_json_encoder.py`).

**`TELEMETRY` è nello stesso enum di `STATUS`/`NEIGHBOURS`**:
`BinaryReqType` (`packets.py`) contiene `STATUS = 0x01`,
`TELEMETRY = 0x03`, `NEIGHBOURS = 0x06` — stessa famiglia di
richiesta, stesso gate ACL, nessun login. Chiarito perché inizialmente
si sospettava (per analogia con uno script di test della libreria
basato su `send_login`/`send_cmd`) che la telemetria richiedesse
un'autenticazione via password: quel meccanismo è in realtà tutt'altra
cosa — una shell remota amministrativa (comandi testuali tipo `"ver"`
eseguiti sul repeater), non correlata a status/neighbours/telemetria,
che restano tutte richieste binarie strutturate gated solo da ACL.
`req_owner_sync()` (owner/nome del repeater) usa invece un terzo
meccanismo ancora più aperto (`AnonReqType`, nessun ACL richiesto per
design — la libreria lo consulta esplicitamente anche verso nodi non
ancora noti come contatti) — non aggiunto: valutato e scartato per
scelta esplicita, l'utente non è interessato a mostrarlo in pagina.

**`contact` è solo una chiave pubblica**: `_validate_destination()`
(`commands/base.py`) accetta una stringa esadecimale (o bytes) — non
serve che il repeater sia nella lista contatti del device né un
oggetto contatto completo da `get_contacts()`. Basta la chiave
pubblica **completa** (32 byte) del repeater. `nodes.public_key` nel
nostro schema la contiene già per intero (proviene da `adv_key`
negli eventi advert / `public_key` da `get_contacts()`, sempre
completa per protocollo MeshCore) — verificato in
`mesh_modules/contact_sync/contact_sync.py`.

**Correlazione robusta**: entrambe le richieste usano un tag casuale
per-richiesta via `attribute_filters={"tag": ...}` — il dispatcher
(`events.py`, `_process_events()`) scarta esplicitamente gli eventi
il cui tag non corrisponde. A differenza di `get_bat()` (solo
correlazione per tipo di evento, broadcast — vedi Fase 6 in
ARCHITECTURE.md), qui non c'è rischio di cross-talk tra richieste
diverse. La libreria ha anche un proprio `_mesh_request_lock` interno
che serializza le sue richieste binarie tra loro, ma non conosce le
nostre altre operazioni sul device — resta necessario avvolgere
queste chiamate in `Engine.command_lock`, coerente con la policy
già stabilita per ogni comando sulla connessione condivisa.

Sono richieste radio verso un repeater remoto (non query locali come
`get_bat()`) — tempi di risposta plausibilmente di alcuni secondi,
auto-calcolati dalla libreria via `suggested_timeout` nella risposta
(`timeout=0` lascia che sia la libreria a deciderlo).

## 4. Configurazione (`config.yaml`)

Elenco di repeater da interrogare, con più di un elemento supportato
fin da subito (anche se oggi ne è configurato uno solo):

```yaml
neighbor_monitoring:
    repeaters:
        - name: "IK2XYP-RPT"
```

Il nome è quello esatto con cui il repeater compare nella lista
contatti del device (l'utente lo ha già salvato come preferito,
"never expire"). La risoluzione nome → chiave pubblica avviene a
runtime tramite `get_contacts()` (già usato altrove nel progetto,
stesso pattern di risoluzione contatti in `bot.py`) — nessuna chiave
esadecimale da trascrivere a mano in configurazione, e nessuna nuova
dipendenza introdotta (`get_contacts()` è già una chiamata di routine
del progetto).

Nessun parametro di intervallo/cadenza in configurazione: la cadenza
di interrogazione è quella dell'unica entry di crontab che innesca
lo script (vedi §6, decisione presa: un solo script che itera in
sequenza su tutti i repeater configurati, stesso stile di
`trace.sh`).

## 5. Schema DB — nuove tabelle in `contacts.db`

Stesso DB di `nodes`/`path_observations` (non un DB separato) per lo
stesso motivo per cui path_observations vive lì: il JOIN per
risolvere i prefissi neighbour in nomi noti richiede che le due
tabelle siano nello stesso file.

Entrambe le nuove tabelle sono un **log temporale** (ogni query è una
riga con timestamp), non un "ultimo stato" sovrascritto — stesso
spirito di `path_observations`: costo di storage trascurabile (le
query sono periodiche via cron, non per-advert come le osservazioni
di path) e permette in futuro un'analisi di tendenza nel tempo senza
dover ripensare lo schema (esattamente il problema già affrontato in
Fase 7 per la crescita di `contacts.db` — qui however la tabella
resta piccola per costruzione, non serve pensare fin da subito a una
rotazione mensile).

```sql
CREATE TABLE repeater_status (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key    TEXT NOT NULL REFERENCES nodes(public_key),
    queried_at    INTEGER NOT NULL,
    bat           INTEGER,
    tx_queue_len  INTEGER,
    noise_floor   INTEGER,
    last_rssi     INTEGER,
    nb_recv       INTEGER,
    nb_sent       INTEGER,
    airtime       INTEGER,
    uptime        INTEGER,
    sent_flood    INTEGER,
    sent_direct   INTEGER,
    recv_flood    INTEGER,
    recv_direct   INTEGER,
    full_evts     INTEGER,
    last_snr      REAL,
    direct_dups   INTEGER,
    flood_dups    INTEGER,
    rx_airtime    INTEGER,
    recv_errors   INTEGER   -- NULL su firmware ante-1.12.0
);

CREATE TABLE repeater_neighbours (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key        TEXT NOT NULL REFERENCES nodes(public_key),
                      -- il repeater INTERROGATO, non il neighbour
    queried_at        INTEGER NOT NULL,
    neighbour_prefix  TEXT NOT NULL,   -- prefisso (4 byte di default), NON FK diretta
    secs_ago          INTEGER,
    snr               REAL
);
```

**Nuance importante**: `neighbours[].pubkey` nella risposta è solo un
**prefisso** (4 byte di default, configurabile via
`pubkey_prefix_length`), non la chiave completa. Il JOIN con `nodes`
per risolvere "questo neighbour è un nodo noto?" è quindi un
confronto di prefisso (`nodes.public_key LIKE neighbour_prefix ||
'%'`), non un'uguaglianza — e con prefissi corti su una rete con
centinaia di nodi la probabilità di collisione non è trascurabile.
Il frontend (§7) dovrà mostrare "possibile corrispondenza" quando il
prefisso combacia con più di un nodo noto, non dare per scontata
un'identificazione univoca.

Aggiunta nella Fase 10 (§10), stesso spirito log-temporale:

```sql
CREATE TABLE repeater_telemetry (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key    TEXT NOT NULL REFERENCES nodes(public_key),
    queried_at    INTEGER NOT NULL,
    channel       INTEGER NOT NULL,  -- numero canale LPP (nomenclatura del device)
    type          TEXT NOT NULL,     -- "voltage", "temperature", ... già risolto in stringa
    value         REAL NOT NULL
);
```

Una riga per canale per query — su IK2XYP-RPT, sempre due righe
(voltage + temperature, entrambe canale 1).

## 6. Architettura del modulo di acquisizione

Stesso schema già in uso per trace/advert: script di cron sottile →
IPC → servizio pluggable nel daemon, che esegue le chiamate vere sul
device dentro `Engine.command_lock`.

- Nuovo `mesh_modules/neighbor_monitor/` (nome di lavoro), con
  `service.py` (interfaccia IPC, stesso pattern di `TraceService`)
  e la logica di query vera e propria — per ogni repeater in
  configurazione: risolve il nome in chiave pubblica via
  `get_contacts()`, poi `req_status_sync()` e `fetch_all_neighbours()`
  in sequenza, tutto dentro il lock condiviso.
- Nuovo script cron (`neighbor_monitor.sh` o simile), stesso stile
  di `trace.sh`/`advert.sh`.
- Nessuna modifica a `ContactSyncModule`: la tabella `nodes` resta
  responsabilità sua, il nuovo modulo la legge/referenzia ma non la
  scrive.

**Deciso**: un solo cron/script che itera in sequenza su tutti i
repeater configurati (stesso stile di `trace.sh`, non una entry di
crontab per repeater). Conseguenza diretta: la cadenza di
interrogazione è quella dell'unica entry di crontab, non un
parametro per-repeater in config — coerente con quanto già fatto
per trace/advert, nessuna nuova astrazione introdotta. Con più
repeater configurati in futuro, il tempo totale per giro cresce
linearmente (ogni query è una richiesta radio di alcuni secondi, in
sequenza dentro lo stesso lock) — da tenere presente nello scegliere
la cadenza della entry di crontab quando il numero di repeater
configurati cresce, ma non richiede alcuna scelta architetturale ora
con un solo repeater.

## 7. Frontend — nuovo tab "Neighbors"

- Nuovo tab a fianco di Trace e Nodes, sia sul Nodo che sul
  Collettore (stesso doppio frontend già esistente).
- Selettore repeater popolato **dal DB** (endpoint
  `GET /api/neighbors/repeaters`, `SELECT DISTINCT` su
  `repeater_status JOIN nodes`) — non da `config.yaml` come
  originariamente ipotizzato: il frontend Node.js non ha un parser
  YAML tra le dipendenze, ed è comunque più corretto mostrare solo i
  repeater con almeno una query riuscita piuttosto che l'intera
  lista configurata (che potrebbe includerne uno mai risposto). Sul
  Collettore l'endpoint propaga `?node=` come tutti gli altri.
- Per il repeater selezionato: tabella status (ultimo `queried_at`
  disponibile, formato key-value come `nodeDetailInfoTable`) +
  tabella telemetria (Fase 10 — Voltage in V, Temperature in °C,
  qualunque altro tipo LPP futuro mostrato con valore grezzo senza
  unità inventata) + tabella neighbours con nome risolto via
  `LEFT JOIN` per prefisso su `nodes` — un campo `match_count`
  distingue nodo sconosciuto (0), match univoco (1), o possibile
  collisione di prefisso (>1, etichettato "(ambiguous)" in tabella).

## 8. Gestione errori

Stesso principio già adottato altrove nel progetto (`!meteo`,
`!status`): fallimento silenzioso e loggato, nessun dettaglio tecnico
esposto se non nei log — qui applicato a livello di riga DB piuttosto
che di risposta bot. Una query fallita (timeout, permesso ACL
mancante/rimosso, repeater irraggiungibile) semplicemente non produce
una nuova riga in `repeater_status`/`repeater_neighbours` per quel
giro; il frontend mostrerà l'ultima query riuscita disponibile con il
suo timestamp, così l'"età" del dato resta sempre visibile.

## 9. Prossimi passi

1. ~~Implementare `mesh_modules/neighbor_monitor/` + migrazione schema
   DB~~ — FATTO, verificato sul campo su IK2XYP-RPT (1 riga status +
   19 righe neighbours, coerente con l'esempio di riferimento).
2. ~~Test empirico ACL vs timeout~~ — FATTO, confermato empiricamente
   che sono indistinguibili (§2, addendum). Nessuna azione ulteriore
   possibile o necessaria su questo punto.
3. ~~Frontend: nuovo tab "Neighbours"~~ — FATTO su entrambi Nodo e
   Collettore, stesso stile delle altre due tab. Un bug emerso in
   deploy sul Collettore: il listener del selettore nodo fisico in
   alto (`#nodeSelector`) ricaricava solo le tab che conosceva al
   momento in cui era stato scritto (Trace/Nodes/dettaglio nodo) —
   non sapeva nulla della nuova tab Neighbours, quindi cambiando
   nodo fisico da quella tab restavano visibili i dati del nodo
   precedente. Risolto aggiungendo lo stesso controllo per
   `neighborsPage`. Confermato funzionante dall'utente su entrambi
   Nodo e Collettore.

## 10. Estensione: telemetria (2026-08-08)

Aggiunta successiva alla chiusura iniziale della fase, su richiesta
esplicita: estrarre anche la telemetria del repeater (per
IK2XYP-RPT, tramite l'app ufficiale: canale 1, tensione batteria e
temperatura).

**Chiarimento importante**: inizialmente si sospettava, per analogia
con uno script di test della libreria basato su `send_login`/
`send_cmd`, che la telemetria richiedesse un login via password.
Verificato nel sorgente (§3) che non è così: `req_telemetry_sync()`
usa lo stesso `send_binary_req()` e lo stesso enum `BinaryReqType` di
status/neighbours — stesso gate ACL già concesso, nessuna
autenticazione aggiuntiva. Il meccanismo `send_login`/`send_cmd` è
in realtà una shell remota amministrativa (comandi testuali come
`"ver"`), non correlata a status/neighbours/telemetria.

**Scope deciso**: solo telemetria. Owner info (`req_owner_sync()`,
disponibile con un meccanismo ancora più aperto — `AnonReqType`,
nessun ACL richiesto per design) valutata e scartata su scelta
esplicita, non interessa mostrarla in pagina.

Implementazione: nuova tabella `repeater_telemetry` (§5), terza
richiesta radio in `NeighborMonitorModule.query()` accanto a
status/neighbours (fallimento indipendente dalle altre due — stesso
principio di parzialità già in uso), nuova tabella "Telemetry" nella
pagina Neighbours (§7) tra Status e Neighbours, con Voltage in V e
Temperature in °C (uniche unità note, per gli unici due tipi
attualmente riportati da IK2XYP-RPT — qualunque altro tipo LPP futuro
mostrato con valore grezzo, nessuna unità inventata).

Verificato con server Node.js reale + DB sintetici su Nodo e
Collettore (payload realistico, fallimento parziale della sola
telemetria, endpoint HTTP, sintassi di tutti i file). **Non ancora
testato dal vivo su IK2XYP-RPT** — la forma del payload si basa su
analisi statica rigorosa del codice sorgente della libreria (tracciato
l'intero percorso da `req_telemetry_sync()` a `lpp_parse()` in
`parsing.py`), non su una cattura reale. Confermato funzionante
dall'utente dopo il primo deploy reale (2026-08-08).

## 11. Estensione: regioni supportate (2026-08-08)

Aggiunta successiva alla §10, nella stessa sessione di lavoro. Scope
originale più ampio (versione firmware, `path.hash.mode`,
`txdelay`/`flood.max`/ecc.) ridotto a sola conferma di fattibilità
via CLI login+comando testuale — l'utente ha deciso esplicitamente di
**non** usare il login per queste info, quindi implementata solo la
parte raggiungibile con lo stesso meccanismo già in uso.

**Verifica login vs ACL**: analisi del sorgente (`reader.py`,
parsing di `LOGIN_SUCCESS`) mostra un campo `acl_permissions`
distinto da `permissions`/`is_admin` nel payload di login — a livello
di libreria client, login e ACL-di-lettura sembrano meccanismi
separati, e login richiede una password esplicita
(`send_login_sync(dst, password, ...)`). L'utente ha però riportato
un'osservazione diretta contraria (login riuscito via app reale senza
inserire password, con solo l'ACL già concesso) — osservazione più
affidabile di quanto la sola lettura statica del client possa
confermare, dato che l'autorizzazione effettiva vive nel firmware del
repeater, non nel client Python. Punto lasciato aperto (non ha
impedito la decisione, che è comunque di non usare il login).

**Regioni**: `req_regions_sync(contact)` esiste come funzione diretta
già pronta in `commands/binary.py` — usa `AnonReqType.REGIONS`, stesso
meccanismo anonimo di `req_owner_sync()` (§3): **nessun ACL, nessun
login**. Restituisce il dump testuale grezzo (stringa unica, non una
lista come neighbours/telemetry), non parsato — struttura interna del
dump non nota a priori, quindi mostrato così com'è, non spacchettato
in campi.

**Scelta architetturale — tabella indipendente, non una colonna di
`repeater_status`**: a differenza di telemetry/neighbours (stesso
gate ACL di status, esito tipicamente condiviso), regions non
richiede alcun ACL — può quindi riuscire anche quando status fallisce
per un problema di permessi. Accoppiarla a `status.queried_at` (come
fatto per neighbours/telemetry, §10) avrebbe reintrodotto lo stesso
limite già accettato lì, stavolta con probabilità più concreta di
verificarsi. Nuova tabella `repeater_region` (public_key, queried_at,
region_dump — una sola riga per query, non una lista), con una
propria `MAX(queried_at)` indipendente sia nella scrittura sia
nell'endpoint `/api/neighbors/:publicKey`.

Verificato esplicitamente con un test end-to-end mirato proprio a
questo scenario: un DB con **solo** una riga `repeater_region` e
**nessuna** riga `repeater_status` per lo stesso repeater — l'endpoint
restituisce correttamente `status: null` insieme a `region` popolata,
su entrambi Nodo e Collettore.

Frontend: nuova sezione "Region" tra Telemetry e Neighbours (§7),
resa come blocco `<pre>` (testo grezzo, non tabella) con stile
esplicito aggiunto in `style.css` — coerente con la palette già
usata per select/input/pulsanti dei filtri, per non affidarsi allo
sfondo bianco di default del browser per `<pre>` (illeggibile in dark
mode).

**Fase chiusa** salvo l'estensione successiva, §12.

## 12. Estensione: configurazione via login CLI (2026-08-08)

Aggiunta successiva alla §11, nella stessa sessione di lavoro.
Motivata dal test diagnostico con `experiments/exp09_login_cli_test.py`
(login con password vuota + `ver`/`get <parametro>` per gli otto
valori identificati nell'esplorazione iniziale).

**Login confermato definitivamente**: l'osservazione dell'utente era
corretta — un repeater con permesso admin nell'ACL (non solo lettura)
accetta login con password vuota. Payload `LOGIN_SUCCESS` reale:
`permissions=1, is_admin=True, acl_permissions=3, fw_ver_level=2`.

**Risultato del test reale** — 7 comandi su 8 riusciti al primo giro:

| Comando | Esito primo test | Valore |
|---|---|---|
| `ver` | ok | `v1.16.0-07a3ca9 (Build: 06-Jun-2026)` |
| `get path.hash.mode` | timeout | — |
| `get txdelay` | ok | `0.75` |
| `get direct.txdelay` | ok | `1.0` |
| `get rxdelay` | ok | `0.0` |
| `get flood.max` | ok | `64` |
| `get flood.max.unscoped` | ok | `20` |
| `get flood.max.advert` | ok | `64` |

**Punto metodologico importante, esplicitato dall'utente**: il
timeout su `path.hash.mode` NON significava comando inesistente —
l'utente ha verificato manualmente via app che il comando esiste e
avrebbe risposto `1`. Su un canale radio LoRa un mancato invio è
normale amministrazione, mai una prova che il comando non esista.
Principio applicato ovunque nel codice: ogni valore non ricevuto è
`None` per quella singola interrogazione, senza alcuna inferenza
sulla causa (stesso principio già stabilito per ACL vs timeout, §2).

**Formato risposte scoperto**: ogni risposta CLI arriva come
messaggio di testo libero (`get_msg()`, non JSON strutturato) con il
valore nel campo `text` — i valori numerici sono preceduti da `"> "`
(echo in stile CLI), la versione firmware no. Parsing: strip del
prefisso `>` e degli spazi, poi cast al tipo atteso (str/int/float
per campo).

**Architettura**: `send_login_sync(public_key, "", timeout=10.0)`
seguito in sequenza da `send_cmd()` + `wait_for_event(MESSAGES_WAITING)`
+ `get_msg()` per ciascuno degli otto comandi (10s di timeout per
risposta, stesso valore validato nel test diagnostico), poi
`send_logout()` esplicito a fine sessione — eseguito sempre,
indipendentemente da quali comandi siano riusciti (igiene della
sessione, non condiziona la validità dei dati già raccolti). Se il
login stesso fallisce, l'intero blocco è saltato e la funzione
ritorna `None` — senza sessione attiva nessun comando ha senso di
essere tentato.

Requisito di permesso più stringente di tutte le altre richieste
(login + bit admin nell'ACL, non solo lettura) — stessa logica di
`repeater_region` (§11): nuova tabella `repeater_config` indipendente
da `repeater_status`, propria `MAX(queried_at)`, verificato
esplicitamente con un DB privo di `repeater_status` e con
`repeater_config` popolata (incluso un valore `NULL` isolato per
`path_hash_mode`) — l'endpoint restituisce correttamente `status:
null` insieme a `config` popolata, su entrambi Nodo e Collettore.

Schema: stesso spirito di `repeater_status` — **una riga per query
con tutte le colonne**, non una riga per parametro (a differenza di
neighbours/telemetry), coerente con la richiesta esplicita di
mostrarla in tabella con lo stesso stile key-value di Status.

Frontend: nuova sezione "Config" tra Telemetry e Region (§7/§11),
stesso formato tabellare key-value di Status.

Verificato con mock completo (tutti gli otto comandi, login fallito,
comando singolo in timeout con logout comunque eseguito) e con server
Node.js reale + DB sintetico su Nodo e Collettore. **Non ancora
deployato sul Raspberry.**

**Fase chiusa.** Nessun prossimo passo aperto.
