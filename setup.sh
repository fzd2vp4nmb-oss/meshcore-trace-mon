#!/bin/bash
#
# setup.sh — genera da zero tutti i file specifici della tua
# installazione (script di manutenzione, config.yaml,
# trace-web.service). Il contenuto di questi file vive interamente
# dentro questo script (heredoc) — nel repository NON esistono copie
# "template" separate: git clone non ti dà backup.sh, trace.sh,
# contact_sync.sh, rotate_contacts.sh, config.yaml, trace-web.service,
# li crea questo script (elenco completo corretto in code review
# 2026-08-20, Rev.6 — mancavano contact_sync.sh/rotate_contacts.sh,
# generati dallo stesso loop write_maint_script() degli altri due).
#
# Va eseguito UNA VOLTA dopo il git clone, dalla root del progetto
# (~/trace-mon). trace-mon.service invece è già nel repository così
# com'è (systemd/trace-mon.service) — non richiede alcun adattamento,
# nessun coinvolgimento di questo script.
#

set -e

cd "$(dirname "$0")"

echo "=== MeshCore trace-mon — Setup ==="
echo

#
# Chiede conferma prima di sovrascrivere un file già esistente.
#
confirm_overwrite() {

    local target="$1"

    if [ ! -f "$target" ]; then
        return 0
    fi

    read -p "  $target esiste già. Sovrascrivere? [y/N] " answer

    case "$answer" in
        [Yy]*) return 0 ;;
        *) return 1 ;;
    esac
}

#
# ============================================================
# Parte 1: script di manutenzione (node_XX / IP_SERVER)
# ============================================================
#
echo "--- Parte 1: script di manutenzione ---"
echo

#
# Validazione formato, non solo "non vuoto" (code review 2026-08-20,
# §3.7) — NODE_ID e IP_SERVER vengono sostituiti più sotto con sed
# usando '/' come delimitatore (righe "sed -i s/.../.../"): un valore
# con '/' rompe la sintassi del comando sed stesso (errore, non
# corruzione silenziosa, ma comunque un fallimento poco chiaro da
# diagnosticare); un valore con '&' verrebbe invece silenziosamente
# interpretato da sed come "il testo trovato dal pattern" nella
# sostituzione, producendo uno script di manutenzione con un valore
# sbagliato SENZA alcun errore visibile. Validare il formato atteso
# (identificativo per NODE_ID, IPv4 per IP_SERVER) esclude entrambi i
# casi a monte, invece di dover elencare i singoli caratteri
# pericolosi per sed.
#
NODE_ID_PATTERN='^[A-Za-z0-9_-]+$'

read -p "Node ID (es. node_01, node_02, node_03): " NODE_ID

if [ -z "$NODE_ID" ]; then
    echo "ERRORE: il Node ID non può essere vuoto."
    exit 1
fi

if ! [[ "$NODE_ID" =~ $NODE_ID_PATTERN ]]; then
    echo "ERRORE: Node ID non valido — sono ammessi solo lettere, cifre, '_' e '-' (es. node_01)."
    exit 1
fi

#
# IPv4 dotted-quad, ogni ottetto 0-255 — non un pattern generico "solo
# cifre e punti" (accetterebbe anche valori fuori range come
# 999.999.999.999).
#
IPV4_OCTET='(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])'
IPV4_PATTERN="^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\$"

read -p "IP del server Collettore: " IP_SERVER

if [ -z "$IP_SERVER" ]; then
    echo "ERRORE: l'IP del server non può essere vuoto."
    exit 1
fi

if ! [[ "$IP_SERVER" =~ $IPV4_PATTERN ]]; then
    echo "ERRORE: IP del server non valido — atteso un indirizzo IPv4 (es. 172.20.1.1)."
    exit 1
fi

echo

#
# Scrive il contenuto letterale (heredoc con delimitatore tra
# apici — 'MAINTSCRIPT_EOF', NON MAINTSCRIPT_EOF — così $YEAR,
# $MONTH, $FILEOUT ecc. restano testo letterale, non vengono
# espansi ORA da setup.sh: sono variabili dello script generato,
# che verranno valutate quando POI backup.sh/trace.sh ecc.
# verranno eseguiti da cron, non ora), poi sostituisce solo i due
# placeholder con sed.
#
write_maint_script() {

    local output="$1"

    if ! confirm_overwrite "$output"; then
        echo "  $output — saltato."
        return
    fi

    case "$output" in

        backup.sh)
            cat > "$output" << 'MAINTSCRIPT_EOF'
#!/bin/bash

#
# set -u/set -o pipefail (code review 2026-08-20, §3.7) — un comando
# con una variabile non definita per errore di battitura, o una pipe
# il cui primo stadio fallisce silenziosamente, non passavano
# inosservati. set -e NON è usato deliberatamente: più sotto lo
# script continua di proposito oltre singoli comandi falliti (ogni
# passaggio ha già il proprio controllo esplicito if [ $? -ne 0 ]
# con log_err+exit, scritto a mano proprio per gestire ogni fallimento
# in modo specifico) — set -e romperebbe quella logica terminando lo
# script alla prima riga fallita invece di eseguire la gestione
# errori prevista.
#
set -u
set -o pipefail

#
# Variabile unica per la directory di installazione (code review
# 2026-08-20, §4) — prima "/home/meshcore/trace-mon" era ripetuto
# come letterale in più punti dello stesso script (LOCKFILE, cd,
# LOGFILE, il secondo cd verso backup/): un'installazione con un
# percorso diverso da quello di default richiedeva modificarlo a mano
# in ognuno di quei punti, col rischio concreto di dimenticarne uno.
# Un'unica variabile la rende un solo punto di modifica.
#
INSTALL_DIR="/home/meshcore/trace-mon"

#
# Log su file — errori (log_err) e messaggi informativi/di stato
# (log_info) in due file separati dentro logs/, indipendenti da come
# cron redirige lo stdout dello script (rafforzamento log cron,
# 2026-08-20 — v. docs/CHANGES_log_errori_cron_su_file.md per la
# motivazione originale e questo aggiornamento). Definiti qui, PRIMA
# del lock e del cd verso INSTALL_DIR, così anche quei due messaggi
# (lock già preso, cd fallita) finiscono su file — prima erano solo su
# stdout, quindi persi su qualunque crontab con `> /dev/null` (come
# nella configurazione di produzione attuale per questo script). Path
# assoluti (non relativi alla cwd) perché questo script cambia
# directory (`cd backup/`) più avanti, dopo l'ultimo controllo utile.
#
# Limite noto (code review 2026-08-20, §4): in caso di disco pieno,
# l'append su $LOGFILE/$INFOFILE può fallire silenziosamente (il suo
# codice di uscita non è controllato) — nello scenario peggiore
# l'errore che si sta cercando di loggare potrebbe non raggiungere il
# file. L'echo su stdout resta comunque il canale primario (raggiunge
# l'email di cron se MAILTO è configurato): accettato come limite
# noto, non risolto qui — irrobustirlo richiederebbe verificare lo
# spazio libero prima di ogni scrittura, complessità sproporzionata
# per un file di log che nel caso peggiore perde solo la propria copia
# locale di un evento già visibile altrove.
#
LOGFILE="$INSTALL_DIR/logs/cron-errors.log"
INFOFILE="$INSTALL_DIR/logs/cron-status.log"
mkdir -p "$(dirname "$LOGFILE")"

log_err() {
    echo "$1"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$1" >> "$LOGFILE"
}

log_info() {
    echo "$1"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$1" >> "$INFOFILE"
}

#
# Lock anti-sovrapposizione (code review 2026-08-20, §3.7) — prima
# nessuno script generato aveva flock: se un'esecuzione richiede più
# tempo del previsto (rete lenta, i tre sleep 10 sommati qui sotto) e
# cron rilancia lo script prima che il precedente sia terminato, due
# istanze sovrapposte potevano correre in race su cp/gzip/rm dello
# stesso file. Lock non bloccante (-n): se un'altra istanza è già in
# corso, questa esce subito senza fare nulla invece di accodarsi —
# preferibile per uno script cron periodico (il giro successivo
# arriva comunque a breve) piuttosto che accumulare istanze in attesa.
#
LOCKFILE="$INSTALL_DIR/run/backup.sh.lock"
mkdir -p "$(dirname "$LOCKFILE")"
exec 9> "$LOCKFILE"

if ! flock -n 9; then
    log_info "$(basename "$0"): un'altra istanza è già in esecuzione, uscita senza fare nulla."
    exit 0
fi

cd "$INSTALL_DIR" || {
    log_err "ERRORE: cd $INSTALL_DIR fallita, uscita."
    exit 1
}

NODE="node_XX"
IP_SERVER="Y.Y.Y.Y"

YEAR=$(date +"%Y")
MONTH=$(date +"%m")
MONTH=$((10#$MONTH - 1))

if [ $MONTH -eq 0 ]; then
    MONTH=12
    YEAR=$((YEAR - 1))
fi

MONTH=$(printf "%02d" "$MONTH")
FILEOUT="trace-$YEAR-$MONTH.json"
FILEOUTZIP="trace-$YEAR-$MONTH.json.gz"

#
# Ogni passaggio va confermato riuscito PRIMA di quello successivo —
# in particolare data/trace.json non va mai rimosso finché non esiste
# già una copia .gz valida in backup/. Senza questi controlli, un cp
# o un gzip falliti (disco pieno, permessi, file assente) porterebbero
# comunque alla rimozione del file live più sotto: dati persi in modo
# irreversibile, senza che il backup sia stato fatto davvero.
#

if [ ! -f data/trace.json ]; then
    log_err "Errore: data/trace.json non trovato, backup annullato."
    exit 1
fi

cp data/trace.json "backup/$FILEOUT"

if [ $? -ne 0 ]; then
    log_err "Errore durante la copia di data/trace.json in backup/$FILEOUT"
    exit 1
fi

sleep 10

gzip "backup/$FILEOUT"

if [ $? -ne 0 ] || [ ! -f "backup/$FILEOUTZIP" ]; then
    log_err "Errore durante la compressione di backup/$FILEOUT"
    exit 1
fi

sleep 10

#
# Solo ora, con backup/$FILEOUTZIP confermato presente, è sicuro
# azzerare il file live.
#
rm -f data/trace.json
sleep 10
touch data/trace.json
sleep 10
cd "$INSTALL_DIR/backup" || {
    log_err "Errore: cd $INSTALL_DIR/backup fallita."
    exit 1
}

#
# Variabili remote quotate insieme come un unico argomento (code
# review 2026-08-20, §4) — IP_SERVER/NODE non erano protette da word
# splitting/glob se mai avessero contenuto uno spazio o un carattere
# speciale di shell; validate a monte da setup.sh quando lo script è
# generato da lì, ma questo file può anche essere modificato a mano.
#
scp -P 15450 "$FILEOUTZIP" "trace-mon@${IP_SERVER}:/home/trace-mon/backup/${NODE}"

if [ $? -ne 0 ]; then
    log_err "Errore durante l'invio di $FILEOUTZIP al Collettore (il backup locale resta comunque disponibile in backup/)."
    exit 1
fi

exit 0
MAINTSCRIPT_EOF
            ;;

        contact_sync.sh)
            cat > "$output" << 'MAINTSCRIPT_EOF'
#!/bin/bash

#
# set -u/set -o pipefail (code review 2026-08-20, §3.7) — v.
# backup.sh per la motivazione completa. set -e NON è usato
# deliberatamente, stesso motivo: i controlli if [ $? -ne 0 ] sotto
# gestiscono già ogni fallimento in modo esplicito.
#
set -u
set -o pipefail

#
# Variabile unica per la directory di installazione (code review
# 2026-08-20, §4) — v. stessa nota in backup.sh.
#
INSTALL_DIR="/home/meshcore/trace-mon"

#
# Log su file — errori (log_err) e messaggi informativi/di stato
# (log_info) in due file separati dentro logs/, indipendenti da come
# cron redirige lo stdout dello script (rafforzamento log cron,
# 2026-08-20 — v. docs/CHANGES_log_errori_cron_su_file.md per la
# motivazione originale e questo aggiornamento). Definiti qui, PRIMA
# del lock e del cd verso INSTALL_DIR, così anche quei due messaggi
# (lock già preso, cd fallita) finiscono su file — v. backup.sh per la
# nota completa sul limite noto (disco pieno) e sui path assoluti.
#
LOGFILE="$INSTALL_DIR/logs/cron-errors.log"
INFOFILE="$INSTALL_DIR/logs/cron-status.log"
mkdir -p "$(dirname "$LOGFILE")"

log_err() {
    echo "$1"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$1" >> "$LOGFILE"
}

log_info() {
    echo "$1"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$1" >> "$INFOFILE"
}

#
# Lock anti-sovrapposizione (code review 2026-08-20, §3.7) — v.
# backup.sh per la motivazione completa. Particolarmente rilevante
# qui: contact_sync.sh gira ogni 5 minuti (il job più frequente in
# assoluto), la finestra per una sovrapposizione con un'esecuzione
# precedente insolitamente lenta (VACUUM INTO su un DB grande) è la
# più stretta di tutti gli script.
#
LOCKFILE="$INSTALL_DIR/run/contact_sync.sh.lock"
mkdir -p "$(dirname "$LOCKFILE")"
exec 9> "$LOCKFILE"

if ! flock -n 9; then
    log_info "$(basename "$0"): un'altra istanza è già in esecuzione, uscita senza fare nulla."
    exit 0
fi

cd "$INSTALL_DIR" || {
    log_err "ERRORE: cd $INSTALL_DIR fallita, uscita."
    exit 1
}

NODE="node_XX"
IP_SERVER="Y.Y.Y.Y"
SNAPSHOT="data/contacts_export.db"

#
# File di stato per la fix "salta il giro se nulla è cambiato"
# (valutazione usura storage, 2026-08-20) — v. commento sopra
# rm -f "$SNAPSHOT" più sotto per il dettaglio completo. Stessa
# directory run/ già usata per i lockfile.
#
VERSION_FILE="$INSTALL_DIR/run/contact_sync.last_synced_version"

#
# Mutua esclusione con rotate_contacts.sh (code review 2026-08-20,
# §4) — l'ordine "rotate_contacts.sh PRIMA del prossimo giro di
# contact_sync.sh" era finora solo un commento nella documentazione
# (v. tools/rotate_path_observations.py), non imposto da nessuno
# script: nulla impediva realmente a un giro di contact_sync.sh
# (ogni 5 minuti) di eseguire VACUUM INTO su data/contacts.db mentre
# rotate_contacts.sh ha in corso il proprio DELETE+VACUUM sulla
# stessa tabella (raro: 1 volta al mese, ma non impossibile con un
#'oneshot' manuale o un cron leggermente disallineato). WAL +
# busy_timeout già proteggono dalla corruzione in quel caso (v.
# stessa nota nei due tools/rotate_*.py), ma il risultato sarebbe
# comunque uno snapshot inviato al Collettore a metà rotazione. Un
# tentativo di lock non bloccante sullo STESSO lockfile di
# rotate_contacts.sh rende l'ordine effettivo: se la rotazione è in
# corso, questo giro di sync viene saltato — il prossimo, 5 minuti
# dopo, la troverà già conclusa (la rotazione impiega tipicamente
# secondi, non minuti).
#
ROTATE_LOCKFILE="$INSTALL_DIR/run/rotate_contacts.sh.lock"
mkdir -p "$(dirname "$ROTATE_LOCKFILE")"
exec 8> "$ROTATE_LOCKFILE"

if ! flock -n 8; then
    log_info "$(basename "$0"): rotate_contacts.sh e' in corso, salto questo giro di sync."
    exit 0
fi

#
# Il lock (fd 8) resta acquisito per tutta la durata dello script
# (rilasciato automaticamente all'uscita, alla chiusura del file
# descriptor) — non solo al momento del controllo iniziale, altrimenti
# rotate_contacts.sh potrebbe partire subito dopo il controllo ma
# prima del VACUUM INTO qui sotto, vanificando la protezione.
#

#
# Se il daemon non ha ancora creato il DB (es. subito dopo
# l'installazione), non c'è nulla da sincronizzare — esce senza
# errore, stesso principio difensivo già usato lato server web.
#
#
# Messaggio anche sul percorso di skip (code review 2026-08-20, §4) —
# prima usciva con successo (0) senza scrivere nulla, né su stdout né
# nel log: indistinguibile, guardando solo i log, da un giro in cui
# lo script non fosse proprio partito (es. cron disabilitato per
# errore) — entrambi i casi non producono alcuna traccia. Un log
# esplicito rende visibile che lo script È girato ed è uscito presto
# per una condizione attesa, non per un problema a monte.
#
if [ ! -f data/contacts.db ]; then
    log_info "$(basename "$0"): data/contacts.db non ancora presente, nulla da sincronizzare."
    exit 0
fi

#
# Salta VACUUM INTO + scp se nulla è cambiato dall'ultimo invio
# RIUSCITO (valutazione usura storage, 2026-08-20) — VACUUM INTO
# riscrive per intero il database ogni volta, indipendentemente da
# quanto sia cambiato: con contacts.db a qualche MB e questo script
# ogni 5 minuti, è il singolo maggior contributo di scrittura sul
# supporto fisico di tutto il progetto, la maggior parte delle volte
# per nulla (la rete mesh non genera sempre nuovi dati ogni 5 minuti).
#
# NOTA (verifica dinamica, 2026-08-20): la prima versione di questa
# fix confrontava `PRAGMA data_version` tra un'esecuzione e l'altra.
# Verificato SPERIMENTALMENTE che non funziona per questo caso d'uso:
# data_version è definito da SQLite come valore relativo alla
# transazione di lettura CORRENTE di UNA connessione che resta aperta
# — "la primissima invocazione per una connessione restituisce sempre
# il valore di partenza". Qui ogni invocazione di `sqlite3` da riga di
# comando apre una connessione nuova e la chiude subito, quindi è
# SEMPRE una "primissima invocazione": il valore letto risultava
# identico a ogni giro anche con scritture reali avvenute nel
# frattempo (riprodotto con test ripetuti, sia in modo rollback-journal
# che WAL). Va bene per rilevare modifiche fatte da ALTRE connessioni
# mentre la STESSA connessione resta aperta (uso per cui esiste), non
# per confrontare tra processi `sqlite3` separati lanciati in momenti
# diversi come fa questo script.
#
# Sostituito con una "firma" basata su mtime+dimensione di
# data/contacts.db e — se presente — data/contacts.db-wal. Le
# scritture del daemon (via ContactDB, connessione WAL persistente)
# vanno quasi sempre ad accodare frame nel file -wal, che quindi
# cambia dimensione/mtime ad ogni scrittura anche prima di un
# checkpoint; un eventuale checkpoint nel frattempo cambia comunque
# mtime/dimensione del file .db principale. La combinazione dei due
# cambia quindi in modo affidabile ad ogni scrittura reale,
# indipendentemente da quando avvenga il prossimo checkpoint WAL.
# Nostro VACUUM INTO (sotto) legge solo data/contacts.db in una
# transazione di lettura, non lo modifica: non altera questa firma.
#
db_signature() {
    local db_stat wal_stat

    db_stat="$(stat -c '%Y:%s' data/contacts.db 2>/dev/null)" || return 1
    if [ -f data/contacts.db-wal ]; then
        wal_stat="$(stat -c '%Y:%s' data/contacts.db-wal 2>/dev/null)"
    else
        wal_stat="none"
    fi

    echo "${db_stat}:${wal_stat}"
}

#
# Il valore scritto in $VERSION_FILE è quello dell'ULTIMO INVIO
# RIUSCITO (scritto solo a fine script, dopo scp confermato), non
# quello dell'ultimo giro semplicemente eseguito — così un tentativo
# fallito (VACUUM o scp) non fa perdere il prossimo retry: se i dati
# non sono cambiati da un invio riuscito precedente, il Collettore ha
# comunque già la versione corretta, saltare non perde nulla; se sono
# cambiati (anche a cavallo di un tentativo fallito), il confronto non
# corrisponde e si procede normalmente.
#
# Fail-safe deliberato: se stat fallisce (es. permessi) o è il primo
# giro in assoluto (nessun $VERSION_FILE ancora), il valore risulta
# vuoto/assente e si procede SEMPRE con la sincronizzazione normale
# sotto — non si salta mai per un dubbio, solo quando il confronto è
# certo.
#
CURRENT_VERSION="$(db_signature)"

if [ -n "$CURRENT_VERSION" ] && [ -f "$VERSION_FILE" ]; then

    LAST_VERSION="$(cat "$VERSION_FILE" 2>/dev/null)"

    if [ "$CURRENT_VERSION" = "$LAST_VERSION" ]; then
        log_info "$(basename "$0"): nessuna modifica a contacts.db dall'ultimo invio riuscito, salto VACUUM+invio."
        exit 0
    fi
fi

#
# VACUUM INTO produce uno snapshot consistente e a sé stante, sicuro
# da copiare anche mentre il daemon scrive attivamente sul DB
# originale — MAI copiare data/contacts.db direttamente (vedi
# docs/CONTACT_MANAGEMENT.md).
#
# Il file di destinazione non deve esistere già: lo rimuoviamo prima,
# altrimenti VACUUM INTO fallisce.
#
rm -f "$SNAPSHOT"

sqlite3 data/contacts.db "VACUUM INTO '$SNAPSHOT'"

if [ $? -ne 0 ]; then
    log_err "Errore durante la creazione dello snapshot di contacts.db"
    exit 1
fi

#
# Variabili remote quotate insieme (code review 2026-08-20, §4) — v.
# stessa nota in backup.sh.
#
scp -P 15450 "$SNAPSHOT" "trace-mon@${IP_SERVER}:/home/trace-mon/data/${NODE}/contacts.db"

if [ $? -ne 0 ]; then
    log_err "Errore durante l'invio di $SNAPSHOT al Collettore"
    exit 1
fi

#
# Invio confermato riuscito: aggiorna il marcatore SOLO ora (v.
# commento sopra) — se CURRENT_VERSION non è stato ottenuto (stat
# fallito in questo stesso giro), non scrive nulla: il prossimo giro
# semplicemente ripete la sincronizzazione, stesso comportamento di
# prima di questa fix, nessuna regressione.
#
if [ -n "$CURRENT_VERSION" ]; then
    echo "$CURRENT_VERSION" > "$VERSION_FILE"
fi

exit 0
MAINTSCRIPT_EOF
            ;;

        rotate_contacts.sh)
            cat > "$output" << 'MAINTSCRIPT_EOF'
#!/bin/bash

#
# set -u/set -o pipefail (code review 2026-08-20, §3.7) — v.
# backup.sh per la motivazione completa. set -e NON è usato
# deliberatamente: oltre ai soliti if [ $? -ne 0 ], questo script in
# particolare continua di proposito oltre un fallimento del primo scp
# per tentare comunque il secondo (SCP_FAILED sotto) — set -e
# romperebbe esattamente questa logica.
#
set -u
set -o pipefail

#
# Variabile unica per la directory di installazione (code review
# 2026-08-20, §4) — v. stessa nota in backup.sh.
#
INSTALL_DIR="/home/meshcore/trace-mon"

#
# Log su file — errori (log_err) e messaggi informativi/di stato
# (log_info) in due file separati dentro logs/, indipendenti da come
# cron redirige lo stdout dello script (rafforzamento log cron,
# 2026-08-20 — v. docs/CHANGES_log_errori_cron_su_file.md per la
# motivazione originale e questo aggiornamento). Definiti qui, PRIMA
# del lock e del cd verso INSTALL_DIR, così anche quei due messaggi
# (lock già preso, cd fallita) finiscono su file — v. backup.sh per la
# nota completa sul limite noto (disco pieno) e sui path assoluti.
#
LOGFILE="$INSTALL_DIR/logs/cron-errors.log"
INFOFILE="$INSTALL_DIR/logs/cron-status.log"
mkdir -p "$(dirname "$LOGFILE")"

log_err() {
    echo "$1"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$1" >> "$LOGFILE"
}

log_info() {
    echo "$1"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$1" >> "$INFOFILE"
}

#
# Lock anti-sovrapposizione (code review 2026-08-20, §3.7) — v.
# backup.sh per la motivazione completa. Qui in particolare protegge
# da un DELETE+VACUUM (dentro i due tools/rotate_*.py) rieseguito
# mentre il precedente è ancora in corso.
#
LOCKFILE="$INSTALL_DIR/run/rotate_contacts.sh.lock"
mkdir -p "$(dirname "$LOCKFILE")"
exec 9> "$LOCKFILE"

if ! flock -n 9; then
    log_info "$(basename "$0"): un'altra istanza è già in esecuzione, uscita senza fare nulla."
    exit 0
fi

cd "$INSTALL_DIR" || {
    log_err "ERRORE: cd $INSTALL_DIR fallita, uscita."
    exit 1
}

NODE="node_XX"
IP_SERVER="Y.Y.Y.Y"

#
# Rotazione: esporta il mese appena concluso da path_observations
# (dentro data/contacts.db) in backup/path_observations-YYYY-MM.json.gz,
# rimuove quelle righe dalla tabella live, compatta il DB. Va eseguito
# PRIMA del prossimo giro di contact_sync.sh (stesso ordine già in uso
# tra backup.sh e trace.sh), così il Collettore riceve un contacts.db
# già compattato.
#
./tools/rotate_path_observations.py

if [ $? -ne 0 ]; then
    log_err "Errore durante la rotazione di path_observations"
    exit 1
fi

#
# Stessa logica per repeater_neighbours (docs/NEIGHBOR_MONITORING.md
# §13) — unica tra le tabelle di neighbor_monitor a rappresentare
# stato accumulato in RAM dal repeater, azzerato ad ogni suo reboot e
# non recuperabile da nessun'altra fonte una volta perso.
#
./tools/rotate_repeater_neighbours.py

if [ $? -ne 0 ]; then
    log_err "Errore durante la rotazione di repeater_neighbours"
    exit 1
fi

#
# Se non è stato prodotto alcun archivio (es. nessuna osservazione
# nel mese appena concluso), non c'è nulla da inviare — esce senza
# errore.
#
YEAR=$(date +"%Y")
MONTH=$(date +"%m")
MONTH=$((10#$MONTH - 1))

if [ $MONTH -eq 0 ]; then
    MONTH=12
    YEAR=$((YEAR - 1))
fi

MONTH=$(printf "%02d" "$MONTH")
FILEOUTZIP="path_observations-$YEAR-$MONTH.json.gz"
FILEOUTZIP2="repeater_neighbours-$YEAR-$MONTH.json.gz"

cd "$INSTALL_DIR/backup" || {
    log_err "Errore: cd $INSTALL_DIR/backup fallita."
    exit 1
}

#
# I due file sono indipendenti (path_observations e
# repeater_neighbours provengono da tabelle diverse, ruotate sopra da
# due script python separati): un fallimento sul primo scp NON deve
# impedire il tentativo del secondo. SCP_FAILED tiene traccia di un
# eventuale fallimento e lo script esce con errore solo alla fine,
# dopo aver comunque tentato entrambi gli invii.
#
SCP_FAILED=0

#
# Variabili remote quotate insieme (code review 2026-08-20, §4) — v.
# stessa nota in backup.sh; qui anche $FILEOUTZIP/$FILEOUTZIP2 sono
# ora quotati (erano già "safe" nella pratica, nomi generati
# internamente da YEAR/MONTH numerici, ma non c'è motivo di lasciarli
# come unica eccezione allo stile ormai adottato in tutto il progetto).
#
if [ -f "$FILEOUTZIP" ]; then
    scp -P 15450 "$FILEOUTZIP" "trace-mon@${IP_SERVER}:/home/trace-mon/backup/${NODE}"

    if [ $? -ne 0 ]; then
        log_err "Errore durante l'invio di $FILEOUTZIP al Collettore"
        SCP_FAILED=1
    fi
fi

if [ -f "$FILEOUTZIP2" ]; then
    scp -P 15450 "$FILEOUTZIP2" "trace-mon@${IP_SERVER}:/home/trace-mon/backup/${NODE}"

    if [ $? -ne 0 ]; then
        log_err "Errore durante l'invio di $FILEOUTZIP2 al Collettore"
        SCP_FAILED=1
    fi
fi

if [ $SCP_FAILED -ne 0 ]; then
    exit 1
fi

exit 0
MAINTSCRIPT_EOF
            ;;

        trace.sh)
            cat > "$output" << 'MAINTSCRIPT_EOF'
#!/bin/bash

#
# set -u/set -o pipefail (code review 2026-08-20, §3.7) — v.
# backup.sh per la motivazione completa. set -e NON è usato
# deliberatamente, stesso motivo: i controlli if [ $? -ne 0 ] sotto
# gestiscono già ogni fallimento in modo esplicito.
#
set -u
set -o pipefail

#
# Variabile unica per la directory di installazione (code review
# 2026-08-20, §4) — v. stessa nota in backup.sh.
#
INSTALL_DIR="/home/meshcore/trace-mon"

#
# Log su file — errori (log_err) e messaggi informativi/di stato
# (log_info) in due file separati dentro logs/, indipendenti da come
# cron redirige lo stdout dello script (rafforzamento log cron,
# 2026-08-20 — v. docs/CHANGES_log_errori_cron_su_file.md per la
# motivazione originale e questo aggiornamento). Definiti qui, PRIMA
# del lock e del cd verso INSTALL_DIR, così anche quei due messaggi
# (lock già preso, cd fallita) finiscono su file — v. backup.sh per la
# nota completa sul limite noto (disco pieno) e sui path assoluti.
#
LOGFILE="$INSTALL_DIR/logs/cron-errors.log"
INFOFILE="$INSTALL_DIR/logs/cron-status.log"
mkdir -p "$(dirname "$LOGFILE")"

log_err() {
    echo "$1"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$1" >> "$LOGFILE"
}

log_info() {
    echo "$1"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$1" >> "$INFOFILE"
}

#
# Lock anti-sovrapposizione (code review 2026-08-20, §3.7) — v.
# backup.sh per la motivazione completa. Rilevante qui in particolare
# perché trace.sh gira ogni 30 minuti (il job più frequente): un
# main_trace.py insolitamente lento potrebbe altrimenti sovrapporsi
# al giro successivo.
#
LOCKFILE="$INSTALL_DIR/run/trace.sh.lock"
mkdir -p "$(dirname "$LOCKFILE")"
exec 9> "$LOCKFILE"

if ! flock -n 9; then
    log_info "$(basename "$0"): un'altra istanza è già in esecuzione, uscita senza fare nulla."
    exit 0
fi

cd "$INSTALL_DIR" || {
    log_err "ERRORE: cd $INSTALL_DIR fallita, uscita."
    exit 1
}

NODE="node_XX"
IP_SERVER="Y.Y.Y.Y"

./main_trace.py

if [ $? -ne 0 ]; then
    log_err "Errore durante l'esecuzione di main_trace.py"
    exit 1
fi

sleep 10
cd "$INSTALL_DIR/data" || {
    log_err "Errore: cd $INSTALL_DIR/data fallita."
    exit 1
}
#
# Variabili remote quotate insieme (code review 2026-08-20, §4) — v.
# stessa nota in backup.sh.
#
scp -P 15450 trace.json "trace-mon@${IP_SERVER}:/home/trace-mon/data/${NODE}"

if [ $? -ne 0 ]; then
    log_err "Errore durante l'invio di trace.json al Collettore"
    exit 1
fi

exit 0
MAINTSCRIPT_EOF
            ;;
    esac

    sed -i "s/NODE=\"node_XX\"/NODE=\"$NODE_ID\"/" "$output"
    sed -i "s/IP_SERVER=\"Y.Y.Y.Y\"/IP_SERVER=\"$IP_SERVER\"/" "$output"

    #
    # Controllo di sintassi automatico post-generazione (code review
    # 2026-08-20, §3.7) — prima non veniva mai eseguito da setup.sh
    # stesso (solo "a mano" nei changelog passati): un bug futuro nei
    # template heredoc sopra, o un'interazione imprevista con la
    # sostituzione sed, verrebbe altrimenti scoperto solo al primo
    # giro di cron, non al momento dell'installazione.
    #
    if ! bash -n "$output"; then
        echo "ERRORE: $output generato con una sintassi non valida — installazione interrotta."
        exit 1
    fi

    chmod +x "$output"

    echo "  generato: $output"
}

for script in backup.sh contact_sync.sh rotate_contacts.sh trace.sh; do
    write_maint_script "$script"
done

echo

#
# ============================================================
# Parte 2: config.yaml
# ============================================================
#
echo "--- Parte 2: config.yaml ---"
echo

if confirm_overwrite "config/config.yaml"; then

    echo "Tipo di connessione al companion MeshCore:"
    echo "  1) TCP"
    echo "  2) Seriale (USB)"
    echo "  3) BLE"
    read -p "Scelta [1-3]: " CONN_CHOICE

    case "$CONN_CHOICE" in
        1) CONN_TYPE="tcp" ;;
        2) CONN_TYPE="serial" ;;
        3) CONN_TYPE="ble" ;;
        *)
            echo "ERRORE: scelta non valida."
            exit 1
            ;;
    esac

    if [ "$CONN_TYPE" = "tcp" ]; then

        read -p "Host TCP: " TCP_HOST

        if [ -z "$TCP_HOST" ]; then
            echo "ERRORE: l'host TCP non può essere vuoto."
            exit 1
        fi

        read -p "Porta TCP [5000]: " TCP_PORT
        TCP_PORT="${TCP_PORT:-5000}"

    elif [ "$CONN_TYPE" = "serial" ]; then

        read -p "Device seriale [/dev/ttyUSB0]: " SERIAL_DEVICE
        SERIAL_DEVICE="${SERIAL_DEVICE:-/dev/ttyUSB0}"

        read -p "Baudrate [115200]: " SERIAL_BAUDRATE
        SERIAL_BAUDRATE="${SERIAL_BAUDRATE:-115200}"

    elif [ "$CONN_TYPE" = "ble" ]; then

        read -p "Indirizzo BLE (es. AA:BB:CC:DD:EE:FF): " BLE_ADDRESS

        if [ -z "$BLE_ADDRESS" ]; then
            echo "ERRORE: l'indirizzo BLE non può essere vuoto."
            exit 1
        fi
    fi

    echo
    echo "Path da tracciare — elenco di prefissi separati da virgola,"
    echo "formato: aaaa,bbbb,aaaa (es. 0001,0002,0001)."
    read -p "Path: " TRACE_PATH

    if [ -z "$TRACE_PATH" ]; then
        echo "ERRORE: il path non può essere vuoto."
        exit 1
    fi

    read -p "Nome del repeater da interrogare (neighbor_monitoring): " REPEATER_NAME

    if [ -z "$REPEATER_NAME" ]; then
        echo "ERRORE: il nome del repeater non può essere vuoto."
        exit 1
    fi

    mkdir -p config

    #
    # Heredoc con delimitatore NON quotato (CONFIG_EOF, non
    # 'CONFIG_EOF') — qui VOGLIAMO che setup.sh interpoli subito le
    # variabili $TCP_HOST ecc., a differenza degli script sopra:
    # config.yaml non ha variabili proprie da preservare letterali,
    # è dati statici.
    #
    cat > config/config.yaml << CONFIG_EOF
connection:
  type: $CONN_TYPE
  max_reconnect_attempts: 5
  recovery_retry_interval: 30
  heartbeat_interval: 15   # secondi tra un health-check attivo e l'altro
  heartbeat_timeout: 5     # timeout del singolo get_bat() di verifica

  tcp:
    host: ${TCP_HOST:-<connection-tcp-host>}
    port: ${TCP_PORT:-5000}

  serial:
    device: ${SERIAL_DEVICE:-/dev/ttyUSB0}
    baudrate: ${SERIAL_BAUDRATE:-115200}

  ble:
    address: ${BLE_ADDRESS:-AA:BB:CC:DD:EE:FF}

trace:
  enabled: true
  output_file: data/trace.json
  interval: 10
  timeout: 15
  backup: true

  # Ogni entry può portare un suffisso ,true/,false per abilitare o
  # disabilitare il path senza rimuoverlo (utile se una tratta radio
  # diventa temporaneamente non disponibile) — nessun suffisso
  # equivale a ,true. Aggiungi/rimuovi/attiva altri path con
  # config.sh dopo l'installazione, invece di editare qui a mano.
  paths:
    - "$TRACE_PATH,true"

bot:
  enabled: true
  channel_name: "#bot"
  max_reply_length: 152
  known_regions:
    - "europe"
    - "it"

logging:
  level: INFO
  file: logs/trace-mon.log
  console: false

contacts:
  enabled: true
  db_file: data/contacts.db
  sync_interval: 3600

neighbor_monitoring:
  # Nessun parametro di cadenza qui: la cadenza è quella dell'unica
  # entry di crontab che lancia main_neighbor_monitor.py — coerente
  # col pattern già usato per trace/advert (vedi
  # docs/NEIGHBOR_MONITORING.md §4/§6).
  interval: 5   # secondi di attesa tra un repeater e il successivo, se più di uno
  max_retries: 3   # tentativi per singola interrogazione radio fallita, prima di passare oltre

  repeaters:
    - name: "$REPEATER_NAME"

services:
  - name: system
    enabled: true
    module: system.service
    class: SystemService

  - name: trace
    enabled: true
    module: trace.service
    class: TraceService

  - name: advert
    enabled: true
    module: advert.service
    class: AdvertService

  - name: bot
    enabled: true
    module: bot.service
    class: BotService

  - name: contact_sync
    enabled: true
    module: contact_sync.service
    class: ContactSyncService

  - name: neighbor_monitor
    enabled: true
    module: neighbor_monitor.service
    class: NeighborMonitorService
CONFIG_EOF

    #
    # Permessi ristretti (code review 2026-08-20, §3.7) — config.yaml
    # non contiene segreti veri, ma include hostname/indirizzi interni
    # della rete (connection.tcp.host, ecc.). 0600: solo il
    # proprietario (utente 'meshcore') può leggerlo. tools/edit_config.py
    # applica lo stesso permesso ad ogni salvataggio successivo e ai
    # relativi backup in config/backup/.
    #
    chmod 600 config/config.yaml

    #
    # Validazione: config.yaml appena scritto deve essere YAML
    # sintatticamente valido (PyYAML è comunque una dipendenza
    # obbligatoria del progetto, vedi requirements.txt).
    #
    if [ -x ".venv/bin/python3" ]; then

        .venv/bin/python3 -c "import yaml; yaml.safe_load(open('config/config.yaml'))" \
            && echo "  generato: config/config.yaml (YAML valido)" \
            || echo "  ATTENZIONE: config/config.yaml scritto ma non è YAML valido — controllalo a mano."
    else
        echo "  generato: config/config.yaml (non validato — .venv non ancora creato)"
    fi

else
    echo "  config/config.yaml — saltato."
fi

echo

#
# ============================================================
# Parte 3: servizio systemd (trace-web.service)
#
# trace-mon.service invece è già nel repository (systemd/trace-mon.service),
# invariato — non richiede adattamenti, non generato da questo script.
# ============================================================
#
echo "--- Parte 3: servizio systemd (trace-web.service) ---"
echo

NODE_BIN="$(which node || true)"

if [ -z "$NODE_BIN" ]; then
    echo "ERRORE: 'node' non trovato nel PATH. Installa Node.js"
    echo "(vedi INSTALL.md) prima di rilanciare questa parte."
    exit 1
fi

echo "Rilevato Node.js in: $NODE_BIN"

if confirm_overwrite "systemd/trace-web.service"; then

    mkdir -p systemd

    cat > systemd/trace-web.service << 'SERVICE_EOF'
[Unit]
Description=MeshCore Trace-Path Web Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=meshcore
Group=meshcore
WorkingDirectory=/home/meshcore/trace-mon
ExecStart=__NODE_BIN__ /home/meshcore/trace-mon/frontend/server.js
Restart=always
RestartSec=5

#
# Arresto pulito (allineato a trace-mon.service)
#
KillSignal=SIGTERM
TimeoutStopSec=15

#
# Hardening (code review 2026-08-20, §3.7) — prima trace-web.service
# non aveva ALCUN hardening, a differenza di trace-mon.service (che
# ha già NoNewPrivileges/PrivateTmp): è il processo di superficie più
# esterna del progetto (server Node in rete, e sul frontend
# Collettore esposto su internet, non solo in LAN come sul Nodo),
# gira come lo stesso utente 'meshcore' che possiede anche il socket
# IPC del daemon — una sua compromissione avrebbe altrimenti pieno
# accesso in scrittura a DB/config/log e potenzialmente al socket IPC.
# server.js non scrive mai sul filesystem (solo letture: trace.json,
# gli archivi in backup/, contacts.db in sola lettura) — ProtectSystem
# =strict + ProtectHome=read-only sono sicuri da applicare senza
# ReadWritePaths aggiuntivi, e riducono concretamente cosa un processo
# compromesso potrebbe modificare anche restando nello stesso utente.
#
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
SERVICE_EOF

    #
    # NODE_BIN può contenere '/' (fa parte del path) — uso '#' come
    # separatore sed invece del solito '/' per non doverlo escapare.
    #
    sed -i "s#__NODE_BIN__#$NODE_BIN#" systemd/trace-web.service

    echo "  generato: systemd/trace-web.service"

else
    echo "  systemd/trace-web.service — saltato."
fi

echo
echo "=== Setup completato ==="
echo
echo "Per attivare i servizi:"
echo "  sudo cp systemd/trace-mon.service systemd/trace-web.service /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now trace-mon trace-web"
