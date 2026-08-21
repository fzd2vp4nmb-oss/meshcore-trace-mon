# Guida all'installazione — MeshCore trace-mon (Nodo)

Questa guida ti accompagna passo passo nell'installazione di
trace-mon su un Raspberry Pi (o qualunque macchina Linux Debian-based
equivalente). Ogni passaggio include: come verificare se è già a
posto, e cosa fare se non lo è — pensata per chi non ha molta
familiarità con Linux.

Copre: configurazione del companion MeshCore, prerequisiti di
sistema, Python, Node.js, git, sqlite3, il clone del progetto,
generazione guidata dei file di configurazione (`setup.sh`),
attivazione dei servizi e crontab.

---

## 1. Configurazione del companion MeshCore

`trace-mon` richiede un device con firmware caricato per il ruolo
**Companion** — non gira su repeater né su room server.

Prima di collegare il companion a `trace-mon`, alcune impostazioni
vanno fatte **dall'app MeshCore stessa**, sul companion che userai —
`trace-mon` non può impostarle da remoto, sono passaggi manuali da
fare una tantum in fase di setup del device.

### 1.1 Default region

In **Experimental settings**, imposta la **default region** su `it`
— evita di trasmettere traffico di tipo *unscoped* sulla mesh.

### 1.2 Path hash size

Sempre in **Experimental settings**, imposta l'**hash path size** ad
almeno **2 byte**.

### 1.3 Canale del bot

Perché il modulo BOT possa rispondere ai comandi, il canale su cui
opera deve esistere come canale hashtag a cui il companion è
iscritto. Di default `trace-mon` usa `#bot` — crea questo canale
nell'app se non esiste già.

Se preferisci usare un canale diverso da `#bot`, crealo comunque
nell'app **e** aggiorna di conseguenza `bot.channel_name` in
`config/config.yaml` (generato da `setup.sh`, §10) — i due devono
corrispondere.

### 1.4 Impostazioni contatti (per il servizio Nodes)

Perché `trace-mon` possa ricevere tutti i tipi di nodo (necessario
per il servizio Nodes), vai nelle impostazioni contatti dell'app e
imposta:

- **Auto Add Selected**: attivo
- **Auto Add Chat Users**: attivo
- **Auto Add Repeaters**: attivo
- **Auto Add Room Servers**: attivo
- **Overwrite oldest**: attivo

Salva le impostazioni prima di procedere.

Con questa configurazione la lista contatti resta sempre piena e i
contatti più vecchi vengono cancellati automaticamente per fare
posto ai nuovi. Se un contatto ti serve stabilmente (ad esempio per
usare il BOT in DM con un utente specifico), impostalo come
**preferito** — i preferiti non vengono cancellati dalla pulizia
automatica.

### 1.5 Invio messaggi

Nelle impostazioni di invio messaggi:

- **Auto Retry**: selezionato
- **Auto Reset Path**: selezionato
- **Direct Message Acks**: `2`

### 1.6 Permessi ACL sul repeater (per il servizio Repeaters)

Per interrogare un repeater dalla tab Repeaters (status, neighbours,
telemetria, regioni, configurazione — vedi
`docs/NEIGHBOR_MONITORING.md` se hai accesso alla documentazione di
sviluppo più approfondita), il companion collegato a `trace-mon` deve
avere **permessi admin** nell'access list (ACL) di quel repeater.

Non puoi impostarlo dal companion che userai con `trace-mon` stesso
— serve un **secondo companion**, che abbia già accesso al repeater,
per aggiungere il primo:

1. Collegati al repeater con un companion diverso da quello che
   userai per `trace-mon` (purché abbia già accesso al repeater
   stesso).
2. Vai in **Settings → Access Control**.
3. Aggiungi il nodo che userai con `trace-mon`.
4. Assegnagli i permessi **admin**.

Senza questo passaggio, i dati di status/neighbours/telemetria
restano comunque parzialmente accessibili (alcuni non richiedono
ACL affatto), ma la tab Repeaters funzionerà solo in parte — vedi la
documentazione di sviluppo per il dettaglio di quali dati richiedono
quale livello di permesso.

---
## 2. Prerequisiti di sistema

### 2.1 Un utente dedicato

trace-mon gira sotto un utente Linux dedicato, chiamato `meshcore`
in tutta questa guida e nella documentazione del progetto — non
condiviso con altri usi della macchina.

**Verifica se esiste già:**

```bash
id meshcore
```

Se risponde con qualcosa come `uid=1000(meshcore) gid=1000(meshcore) ...`,
l'utente esiste già — salta al paragrafo 2.2.

Se invece risponde `id: 'meshcore': no such user`, va creato. Serve
un utente con permessi di amministrazione (root, o un altro utente
con `sudo`) per questo passaggio:

```bash
sudo adduser meshcore
```

Ti verrà chiesta una password per il nuovo utente (da usare per
accedervi, es. via SSH) e alcune informazioni opzionali (nome
completo, ecc. — puoi lasciarle vuote premendo invio).

Da qui in avanti, tutti i comandi di questa guida vanno eseguiti
**come utente `meshcore`**, non come root. Se hai creato l'utente
ora, passa a operare con quello:

```bash
su - meshcore
```

(oppure disconnettiti e riconnettiti via SSH direttamente come
`meshcore`)

### 2.2 Permessi sudo per l'utente meshcore

Alcuni passaggi di questa guida (installazione di pacchetti di
sistema) richiedono che `meshcore` possa usare `sudo`.

**Verifica:**

```bash
sudo -l
```

Se non ti chiede una password che non conosci e ti elenca i comandi
permessi (o dice "may run the following commands"), sei già a posto.
Se invece ti dice che l'utente non è nel file sudoers, va aggiunto —
serve di nuovo un utente amministratore diverso da `meshcore` per
farlo:

```bash
sudo usermod -aG sudo meshcore
```

Dopo questo comando, disconnettiti e riconnettiti come `meshcore`
perché il cambiamento abbia effetto (l'appartenenza ai gruppi si
legge al login, non si aggiorna su una sessione già aperta).

### 2.3 Accesso alle porte seriali (solo se userai una connessione seriale/USB)

Se il tuo companion MeshCore si collega via TCP (il caso più comune,
e quello di default in questo progetto), **puoi saltare questo
paragrafo**. Se invece prevedi di collegarti via USB/seriale
(`/dev/ttyUSB0` o simili), l'utente `meshcore` deve appartenere al
gruppo `dialout`.

**Verifica:**

```bash
groups meshcore
```

Se `dialout` compare nell'elenco, sei a posto. Altrimenti:

```bash
sudo usermod -aG dialout meshcore
```

Anche qui, serve disconnettersi e riconnettersi perché il cambiamento
abbia effetto.

---

## 3. Python

Il daemon principale è scritto in Python.

### 3.1 Verifica

```bash
python3 --version
```

Serve **Python 3.9 o superiore**. Se la versione mostrata è già
`3.9.x` o più recente, salta al paragrafo 3.3.

### 3.2 Installazione (solo se mancante o troppo vecchio)

```bash
sudo apt update
sudo apt install -y python3 python3-pip python3-venv
```

Rilancia `python3 --version` per confermare.

### 3.3 Il modulo `venv`

```bash
python3 -m venv --help
```

Se stampa un messaggio d'aiuto, sei a posto. Se dà errore
(`No module named venv`):

```bash
sudo apt install -y python3-venv
```

**Nota**: la creazione effettiva dell'ambiente virtuale (`.venv`)
avviene più avanti (paragrafo 8), dentro la cartella del progetto —
che esiste solo dopo il clone (paragrafo 7).

---

## 4. Node.js e npm

Il frontend web è un server Node.js/Express.

### 4.1 Verifica

```bash
node --version
npm --version
```

Serve **Node.js 22.5 o superiore** (usa `node:sqlite` per interrogare
il database). Se `node --version` mostra già `v22.5.0` o superiore
(idealmente `v24.x`), salta al paragrafo 5 — `npm` è già incluso.

### 4.2 Installazione (solo se mancante o troppo vecchio)

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

Rilancia `node --version` e `npm --version` per confermare. Se dopo
questo comando `node --version` mostra ancora una versione vecchia,
probabilmente esiste un'altra installazione di Node.js (es. tramite
`nvm`) che ha priorità nel `PATH`:

```bash
which node
```

Se il percorso mostrato contiene `.nvm` (installazione tramite
`nvm`, il caso più comune), rimuovilo:

```bash
rm -rf ~/.nvm
```

Poi apri `~/.bashrc` con un editor di testo, rimuovi le righe che
menzionano `NVM_DIR` o `nvm.sh`, e apri una nuova sessione di
terminale (o esegui `source ~/.bashrc`). Ripeti `which node`: ora
dovrebbe puntare a `/usr/bin/node`.

---

## 5. git

### 5.1 Verifica

```bash
git --version
```

Se stampa un numero di versione, sei già a posto — salta al
paragrafo 6.

### 5.2 Installazione (solo se mancante)

```bash
sudo apt update
sudo apt install -y git
```

---

## 6. sqlite3

`contact_sync.sh` usa il comando a riga di comando `sqlite3` per
sincronizzare `contacts.db` verso il Collettore.

### 6.1 Verifica

```bash
sqlite3 --version
```

Se stampa un numero di versione, sei già a posto — salta al
paragrafo 7.

### 6.2 Installazione (solo se mancante)

```bash
sudo apt update
sudo apt install -y sqlite3
```

---

## 7. Scaricare il progetto (git clone)

```bash
cd ~
git clone https://github.com/fzd2vp4nmb-oss/meshcore-trace-mon.git trace-mon
cd trace-mon
```

Da qui in avanti, tutti i comandi di questa guida assumono che tu sia
dentro `~/trace-mon` (cioè `/home/meshcore/trace-mon`), salvo dove
indicato diversamente.

---

## 8. Ambiente virtuale Python e dipendenze

### 8.1 Creazione dell'ambiente virtuale

Un ambiente virtuale (`venv`) è una copia isolata di Python dove
installare le librerie del progetto senza toccare l'installazione di
sistema — evita conflitti con altri programmi Python eventualmente
presenti sulla macchina.

```bash
cd ~/trace-mon
python3 -m venv .venv
```

Questo crea la cartella `.venv/` dentro il progetto (non serve
crearla a mano, il comando la genera da solo).

### 8.2 Attivazione e installazione delle dipendenze

```bash
source .venv/bin/activate
pip install -r requirements.txt
```

Dopo `source .venv/bin/activate` il prompt del terminale dovrebbe
mostrare `(.venv)` all'inizio — conferma che stai operando dentro
l'ambiente virtuale, non con il Python di sistema.

`pip install -r requirements.txt` installa le tre librerie che il
progetto richiede:
- `meshcore` (>= 2.3.8) — la libreria client per comunicare col
  companion MeshCore
- `PyYAML` — per leggere `config.yaml`
- `aiohttp` — usata dal comando bot `!meteo`

### 8.3 Verifica

Controlla che il prompt mostri ancora `(.venv)` all'inizio (§8.2) —
se manca, `source .venv/bin/activate` prima di continuare: i comandi
seguenti, eseguiti fuori dall'ambiente virtuale, mostrerebbero i
pacchetti del Python di sistema invece di quelli del progetto, senza
alcun avviso.

```bash
pip list
```

Dovresti vedere `meshcore`, `PyYAML` e `aiohttp` nell'elenco. Se
manca qualcosa, ripeti `pip install -r requirements.txt` e controlla
eventuali messaggi di errore mostrati durante l'installazione.

Se invece `.venv` esisteva già da un'installazione precedente,
controlla che le dipendenze siano aggiornate (sempre con `(.venv)`
visibile nel prompt):

```bash
pip list --outdated
pip install --upgrade -r requirements.txt
```

**Nota**: l'ambiente virtuale va riattivato (`source .venv/bin/activate`)
ogni volta che apri una nuova sessione di terminale e vuoi eseguire
manualmente uno script Python del progetto. Gli script di cron e il
servizio systemd (che vedremo in una sezione successiva) puntano
direttamente all'interprete dentro `.venv/`, quindi per quelli non è
necessario attivare nulla a mano.

---

## 9. Dipendenze Node.js del frontend

```bash
cd ~/trace-mon/frontend
npm install
```

Questo legge `package.json` (già presente nel repository) e installa
Express — l'unica dipendenza del frontend — dentro
`frontend/node_modules/`.

### Verifica

```bash
ls node_modules/express
```

Se la cartella esiste (con dentro vari file), l'installazione è
andata a buon fine.

---

## 10. Generare i file specifici della tua installazione (`setup.sh`)

Per completare l'installazione esegui `setup.sh`, un breve
questionario interattivo:

```bash
cd ~/trace-mon
./setup.sh
```

Lo script è diviso in tre parti, in quest'ordine:

1. **Script di manutenzione** — ti chiede il **Node ID** e l'**IP del
   server** a cui gli script inviano backup/sincronizzazioni via
   `scp`. Questi due valori non li scegli tu: te li assegna l'admin
   del server Collector — contattalo prima di arrivare a questo
   punto (§14.2) se non li hai già. Genera `backup.sh`,
   `contact_sync.sh`, `rotate_contacts.sh`, `trace.sh`, tutti già
   eseguibili.
2. **`config.yaml`** — ti chiede il tipo di connessione al companion
   MeshCore (TCP, Seriale o BLE) e i dettagli coerenti con la scelta
   (host+porta per TCP, device+baudrate per Seriale, indirizzo per
   BLE), un path da tracciare, e il nome del repeater da interrogare
   per lo status remoto (tab Repeaters).
3. **`trace-web.service`** — rileva automaticamente dove hai
   installato Node.js (`which node`) e genera il file di servizio
   systemd con il path corretto.

Se rilanci `setup.sh` in un secondo momento, ti chiede conferma
prima di sovrascrivere qualunque file già generato — puoi rilanciarlo
in sicurezza anche solo per rigenerare un pezzo specifico. Fai
attenzione però a non sovrascrivere mai `config.yaml` in questi casi,
per non perdere informazioni importanti.

### Tutti i servizi sono abilitati di default

Al primo setup la sezione `services:` attiva tutti i servizi di
default; per poterli disattivare esiste un editor dedicato mostrato
in seguito.

---

## 11. Attivare i servizi systemd

```bash
sudo cp systemd/trace-mon.service systemd/trace-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trace-mon trace-web
```

Il primo comando richiede `sudo` perché `/etc/systemd/system/` non è
scrivibile dall'utente `meshcore` — è l'unico passaggio di questa
guida che tocca file di sistema al di fuori di `~/trace-mon`.

### Verifica

```bash
systemctl status trace-mon
systemctl status trace-web
```

Entrambi dovrebbero mostrare `active (running)` in verde. Se uno dei
due mostra `failed`, i log si consultano con:

```bash
journalctl -u trace-mon -n 50
journalctl -u trace-web -n 50
```

---

## 12. Crontab

Alcune attività (tracciamento, monitoraggio repeater, manutenzione)
non girano come parte del servizio systemd continuo, ma vengono
lanciate periodicamente via `cron` — lo stesso daemon comunica con
questi script tramite IPC (vedi `docs/ARCHITECTURE.md` nel repository
di sviluppo, se hai accesso a quella documentazione più approfondita).

```bash
crontab -e
```

(**come utente `meshcore`** — se apri questo comando da un altro
utente, modifichi il crontab sbagliato)

Esempio di configurazione, con cadenze di partenza ragionevoli:

```
# MeshCore Path Explorer
#
*/30 * * * * /home/meshcore/trace-mon/trace.sh > /dev/null 2>&1
5 */2 * * * /home/meshcore/trace-mon/neighbor_monitor.sh > /dev/null 2>&1
15 3 * * * /home/meshcore/trace-mon/floodadv.sh > /dev/null 2>&1
#
# Maintenance
#
*/5 * * * * /home/meshcore/trace-mon/contact_sync.sh > /dev/null 2>&1
2 0 1 * * /home/meshcore/trace-mon/backup.sh > /dev/null 2>&1
3 0 1 * * /home/meshcore/trace-mon/rotate_contacts.sh > /dev/null 2>&1
10 3 * * 0 /usr/sbin/logrotate --state /home/meshcore/trace-mon/run/logrotate.status /home/meshcore/trace-mon/config/logrotate.conf
```

Cosa fa ciascuna riga:
- **`trace.sh`** (ogni 30 minuti) — traccia il path configurato e
  invia il risultato al Collettore.
- **`neighbor_monitor.sh`** (ogni 2 ore, al minuto 5) — interroga i
  repeater configurati (status, neighbours, telemetria, regioni,
  configurazione — tab Repeaters). Il minuto 5, distanziato da quello
  di `trace.sh` (che gira a `:00`/`:30`), riduce il rischio che le due
  esecuzioni si sovrappongano nel caso peggiore di `neighbor_monitor.sh`
  (v. `docs/ARCHITECTURE.md`, code review 2026-08-20 §1.3).
- **`floodadv.sh`** (una volta al giorno, alle 3:15) — invia un
  advertisement flood.
- **`contact_sync.sh`** (ogni 5 minuti) — sincronizza un'istantanea
  di `contacts.db` verso il Collettore.
- **`backup.sh`** / **`rotate_contacts.sh`** (il giorno 1 di ogni
  mese) — archiviano ed espellono dal database live i dati del mese
  appena concluso (trace, path osservati, neighbours dei repeater).
- **logrotate** (ogni domenica alle 3:10) — ruota i log applicativi.

**Le cadenze di `trace.sh`/`neighbor_monitor.sh`/`floodadv.sh` sono
solo un punto di partenza**, non un valore prescritto: ogni
interrogazione passa per lo stesso canale radio condiviso con il
resto della mesh — cadenze più strette aumentano il traffico che
generi sulla rete. Osserva il comportamento della tua rete e stringi
o allarga questi intervalli di conseguenza; le voci di manutenzione
(`contact_sync.sh`, backup/rotate, logrotate) invece non generano
traffico radio, la cadenza qui data va bene praticamente sempre.

**Dove finiscono i log**: nessuno di questi script scrive messaggi
utili nell'output catturato da cron (per questo l'esempio sopra usa
`> /dev/null 2>&1` ovunque, contact_sync.sh incluso) — ogni script di
manutenzione scrive da sé, con timestamp, in due file dentro `logs/`:
`logs/cron-errors.log` per gli errori (`tail -f` lì per un fallimento
di uno qualunque di questi script) e `logs/cron-status.log` per i
messaggi informativi (lock già in corso, condizioni di skip attese,
ecc.). Entrambi ruotati da logrotate insieme a `logs/trace-mon.log`
(il log del daemon, distinto da questi — v.
`config/logrotate.conf`).

---

## 13. Modificare la configurazione in seguito (`config.sh`)

Per cambiare `config.yaml` dopo l'installazione — connessione, path
tracciati, canale/regioni del bot, repeater interrogati, quali
servizi sono attivi — non serve un editor di testo:

```bash
cd ~/trace-mon
./config.sh
```

Un menu guida la modifica in modo puntuale e sicuro: ogni salvataggio
crea automaticamente un backup del file precedente e verifica che il
risultato sia valido prima di considerarlo definitivo. Al termine,
propone di riavviare `trace-mon.service` per applicare le modifiche.

Qualora fosse necessario allineare un nuovo parametro di
configurazione, esiste l'opzione **"8) Allinea al template"** che
aggiunge a `config.yaml` solo i parametri mancanti, senza modificare
le altre scelte già salvate in precedenza.

---

## 14. Collegarsi al server Collector

Il Nodo locale può inviare periodicamente i propri dati (trace,
contatti, repeater monitorati) a un server centrale (Collector) che
li aggrega con quelli di altri nodi della rete. Questo passaggio non
fa parte del setup di base di trace-mon — il Nodo funziona
autonomamente anche senza — ma estende ciò che puoi vedere
aggregando le tue rilevazioni con quelle di altri.

### 14.1 Genera una chiave SSH

```bash
ssh-keygen -t ed25519 -C "etichetta"
```

Sostituisci `etichetta` con un nome che ti aiuti a riconoscere questa
chiave in futuro (es. il nome del tuo companion nell'app MeshCore) —
serve solo a te e all'admin per distinguerla da altre chiavi, **non**
è il `node_XX` che userai nel resto di questa guida: quello lo
assegna l'admin al passo successivo. Lascia vuota la passphrase se
prevedi di usare la chiave da script automatici.

### 14.2 Contatta l'admin del servizio

Scrivi a:

```
fzd2vp4nmb [at] privaterelay [dot] appleid [dot] com
```

allegando la chiave pubblica generata al passo precedente
(`~/.ssh/id_ed25519.pub`). L'admin ti risponderà con le istruzioni
per completare l'accesso, il **Node ID** (`node_XX`) da usare per
questa installazione, e l'IP del server da usare al passo
successivo — sono entrambi assegnati dall'admin, non vanno decisi
autonomamente.

### 14.3 Configura Node ID e IP del server

Il Node ID e l'IP del server (`IP_SERVER`) vengono impostati dal
questionario di `setup.sh` (§10) — rilancialo:

```bash
cd ~/trace-mon
./setup.sh
```

Ti chiederà conferma prima di sovrascrivere gli script di
manutenzione già generati (`backup.sh`, `contact_sync.sh`,
`rotate_contacts.sh`, `trace.sh`) — rispondi di sì. Quando
richiesto, inserisci esattamente il Node ID e l'IP del server
comunicati dall'admin al passo 14.2.

Quando il tool ti chiederà di proseguire con i cambiamenti a
`config/config.yaml` (Parte 2) e a `trace-web.service` (Parte 3)
rispondi in entrambi i casi "n" per non sovrascrivere nient'altro.

---

## 15. Collegarsi alla Dashboard locale

Con `trace-web.service` attivo (§11), l'interfaccia web è
raggiungibile da qualunque dispositivo sulla stessa rete LAN del
Raspberry, aprendo nel browser:

```
http://localhost:3000
```

Questo indirizzo funziona così com'è solo se il resolver della tua
rete risolve `localhost` verso l'IP del Raspberry — non è la
configurazione predefinita della maggior parte delle reti. Se non
si apre nulla, usa direttamente l'IP del Raspberry sulla LAN:

```
http://<ip-raspberry>:3000
```

L'IP lo trovi lanciando `hostname -I` direttamente sul Raspberry,
o dalla pagina dei dispositivi connessi del tuo router.
