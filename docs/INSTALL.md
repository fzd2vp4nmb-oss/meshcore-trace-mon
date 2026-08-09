# Guida all'installazione — MeshCore trace-mon (Nodo)

Questa guida ti accompagna passo passo nell'installazione di
trace-mon su un Raspberry Pi (o qualunque macchina Linux Debian-based
equivalente). Ogni passaggio include: perché serve, come verificare
se è già a posto, e cosa fare se non lo è — pensata per chi non ha
molta familiarità con Linux.

**Stato di questa guida**: copre prerequisiti di sistema, strumenti
di base (Python, Node.js, git) e la prima inizializzazione del
progetto (clone + ambienti Python/Node). La configurazione vera e
propria (file `config.yaml`, script di manutenzione, servizio
systemd) è oggetto di una sezione successiva, non ancora presente in
questa guida.

---

## 1. Prerequisiti di sistema

### 1.1 Un utente dedicato

trace-mon gira sotto un utente Linux dedicato, chiamato `meshcore`
in tutta questa guida e nella documentazione del progetto — non
condiviso con altri usi della macchina.

**Verifica se esiste già:**

```bash
id meshcore
```

Se risponde con qualcosa come `uid=1000(meshcore) gid=1000(meshcore) ...`,
l'utente esiste già — salta al paragrafo 1.2.

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

### 1.2 Permessi sudo per l'utente meshcore

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

### 1.3 Accesso alle porte seriali (solo se userai una connessione seriale/USB)

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

## 2. Python

### 2.1 Perché serve

Il daemon principale di trace-mon (connessione al companion MeshCore,
i vari moduli di acquisizione dati) è scritto in Python, usando
`asyncio` in modo estensivo.

### 2.2 Verifica

```bash
python3 --version
```

Serve **Python 3.9 o superiore**. Se la versione mostrata è già
`3.9.x` o più recente, salta al paragrafo 2.4 (creazione
dell'ambiente virtuale) — non serve installare nulla.

Su Raspberry Pi OS in una versione recente (Bookworm o successive),
Python 3 è già preinstallato con una versione adeguata: è molto
probabile che questo passaggio sia già a posto.

### 2.3 Installazione (solo se mancante o troppo vecchio)

```bash
sudo apt update
sudo apt install -y python3 python3-pip python3-venv
```

`python3-venv` è il pacchetto che permette di creare ambienti
virtuali isolati (paragrafo 2.4) — su alcune distribuzioni non è
incluso di default nell'installazione base di Python, va richiesto
esplicitamente.

Rilancia `python3 --version` per confermare.

### 2.4 Il modulo `venv`

Anche se Python era già installato, verifica che il modulo `venv`
sia disponibile (potrebbe non esserlo anche con Python già presente,
se `python3-venv` non era mai stato installato):

```bash
python3 -m venv --help
```

Se stampa un messaggio d'aiuto, sei a posto. Se dà errore
(`No module named venv`), installa il pacchetto come sopra:

```bash
sudo apt install -y python3-venv
```

**Nota**: la creazione effettiva dell'ambiente virtuale (`.venv`)
avviene più avanti (paragrafo 5), perché va creata *dentro* la
cartella del progetto — che a sua volta esiste solo dopo aver
clonato il repository (paragrafo 4). Per ora basta aver verificato
che gli strumenti necessari ci siano.

---

## 3. Node.js e npm

### 3.1 Perché serve

Il frontend web (l'interfaccia che vedi nel browser) è un piccolo
server Node.js/Express, con una libreria nativa (`node:sqlite`) per
leggere il database SQLite del progetto.

### 3.2 Verifica

```bash
node --version
npm --version
```

Serve **Node.js 22.5 o superiore** — è la versione minima in cui
`node:sqlite` (usata dal frontend per interrogare il database) è
comparsa. Su versioni intermedie potrebbe servire un'opzione
sperimentale che questo progetto non imposta: per evitare complicazioni,
questa guida installa direttamente una versione recente (24, LTS
attuale al momento della stesura), che include il supporto completo
senza flag aggiuntivi.

Se `node --version` mostra già `v22.5.0` o superiore (idealmente
`v24.x`), puoi saltare al paragrafo 4. `npm` viene installato insieme
a Node.js, non richiede un passaggio separato.

### 3.3 Installazione (solo se mancante o troppo vecchio)

Il modo più affidabile per avere una versione recente su Raspberry
Pi OS (che nei repository di sistema standard spesso ha una versione
di Node.js più vecchia) è tramite il repository ufficiale NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

Il primo comando aggiunge il repository NodeSource al sistema (serve
`sudo` perché modifica la configurazione di `apt`), il secondo
installa effettivamente Node.js e npm da quel repository.

Rilancia `node --version` e `npm --version` per confermare.

---

## 4. git

### 4.1 Perché serve

L'intero progetto è distribuito tramite un repository git su GitHub
— serve per scaricarlo (`git clone`) e per ricevere eventuali
aggiornamenti futuri (`git pull`).

### 4.2 Verifica

```bash
git --version
```

Se stampa un numero di versione, sei già a posto — salta al
paragrafo 5.

### 4.3 Installazione (solo se mancante)

```bash
sudo apt update
sudo apt install -y git
```

---

## 5. Scaricare il progetto (git clone)

Con tutti gli strumenti di base pronti, puoi scaricare il codice.
Questo passaggio crea la struttura di cartelle del progetto (incluse
`frontend/`, dove al paragrafo 7 installeremo le dipendenze Node) —
è per questo che viene prima degli ultimi due passaggi di questa
guida, non dopo.

```bash
cd ~
git clone https://github.com/<utente>/meshcore-trace-mon.git trace-mon
cd trace-mon
```

(sostituisci `<utente>` con il nome utente/organizzazione GitHub del
repository — te lo forniamo insieme al link di questa guida)

Da qui in avanti, tutti i comandi di questa guida assumono che tu sia
dentro `~/trace-mon` (cioè `/home/meshcore/trace-mon`), salvo dove
indicato diversamente.

---

## 6. Ambiente virtuale Python e dipendenze

### 6.1 Creazione dell'ambiente virtuale

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

### 6.2 Attivazione e installazione delle dipendenze

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

### 6.3 Verifica

```bash
pip list
```

Dovresti vedere `meshcore`, `PyYAML` e `aiohttp` nell'elenco. Se
manca qualcosa, ripeti `pip install -r requirements.txt` e controlla
eventuali messaggi di errore mostrati durante l'installazione.

**Nota**: l'ambiente virtuale va riattivato (`source .venv/bin/activate`)
ogni volta che apri una nuova sessione di terminale e vuoi eseguire
manualmente uno script Python del progetto. Gli script di cron e il
servizio systemd (che vedremo in una sezione successiva) puntano
direttamente all'interprete dentro `.venv/`, quindi per quelli non è
necessario attivare nulla a mano.

---

## 7. Dipendenze Node.js del frontend

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

*(la guida prosegue con la configurazione di `config.yaml`, gli
script di manutenzione e l'avvio del servizio — sezioni successive,
non ancora incluse in questo documento)*
