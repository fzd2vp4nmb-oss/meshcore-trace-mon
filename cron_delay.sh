#!/bin/bash

#
# cron_delay.sh — ritardo FISSO, diverso per ogni nodo, da mettere davanti
# a un job di cron (docs/ARCHITECTURE.md §87.19).
#
# Perché: il crontab è lo stesso su tutti i nodi, quindi i job che
# trasmettono un flood (floodadv.sh, sonar.sh) partirebbero tutti nello
# stesso minuto. Questo script aspetta un numero di secondi ricavato
# dall'ID del nodo (NODE) e poi lancia il job: crontab identico ovunque,
# istante di partenza diverso per ogni nodo.
#
# Uso nel crontab (stesso testo su tutti i nodi):
#
#     5  3,9,15,21 * * * /home/meshcore/trace-mon/cron_delay.sh floodadv.sh > /dev/null 2>&1
#     35 3,9,15,21 * * * /home/meshcore/trace-mon/cron_delay.sh sonar.sh > /dev/null 2>&1
#     */5 0-5 * * * /home/meshcore/trace-mon/cron_delay.sh --window 240 --quiet contact_sync.sh > /dev/null 2>&1
#     */10 6-23 * * * /home/meshcore/trace-mon/cron_delay.sh --window 240 --quiet contact_sync.sh > /dev/null 2>&1
#     7 1 1 * * /home/meshcore/trace-mon/cron_delay.sh --window 240 rotate_contacts.sh > /dev/null 2>&1
#
# sonar.sh trasmette con lo scope di sonar.tx.scope (config.yaml del nodo);
# un eventuale --scope sulla riga lo scavalca (docs/ARCHITECTURE.md §87.19, D31).
#
# Sintassi:
#
#     cron_delay.sh [--window SECONDI] [--quiet] <job> [argomenti del job...]
#     cron_delay.sh [--window SECONDI] [--node ID] --show
#
#   <job>       nome di un file eseguibile nella directory di installazione
#               (solo il nome: niente percorsi); gli argomenti che seguono
#               vanno al job senza modifiche
#   --window    ampiezza della finestra in secondi (1-3600, default 1200):
#               il ritardo è sempre minore della finestra
#   --quiet     non scrive la riga di stato in cron-status.log (per i job
#               molto frequenti, come contact_sync.sh); gli errori si
#               scrivono sempre
#   --show      stampa il ritardo e NON lancia nulla (verifica a mano)
#   --node      con --show: calcola il ritardo di un altro nodo, per
#               controllare da qui la distanza tra tutti i nodi
#
# Come si calcola il ritardo: SHA-256 della stringa "<SALT>:<NODE>", primi
# 8 caratteri esadecimali letti come numero, modulo REF_WINDOW (1200): è la
# POSIZIONE del nodo, fissa. Il ritardo è quella posizione riscalata alla
# finestra richiesta (posizione x finestra / REF_WINDOW, per difetto): con
# 1200 s coincide con la posizione; con una finestra più corta i nodi
# conservano lo stesso ordine e la stessa distanza in proporzione (con
# 240 s, node_01..node_10 stanno ad almeno 16 s l'uno dall'altro). Il
# ritardo è FISSO (stesso nodo, stessa finestra: stesso ritardo a ogni
# esecuzione) e l'ordine dei nodi è lo stesso per TUTTI i job; la distanza
# tra due job dello stesso nodo, se hanno la stessa finestra, resta quella
# scritta nel crontab (advert alle hh:05 e Sonar alle hh:35 restano a 30
# minuti l'uno dall'altro, qualunque sia il ritardo del nodo). SALT è una
# costante scelta fra 5000 candidate perché node_01..node_10 stiano ad
# almeno 80 secondi l'uno dall'altro nella finestra di 1200 secondi; per
# altri ID (oltre 10 nodi) il ritardo è semplicemente casuale: la distanza
# NON è garantita. Cambiare SALT o REF_WINDOW cambia il ritardo di tutti i
# nodi, su tutte le finestre.
#
# VINCOLO: la finestra deve essere minore dell'intervallo tra due esecuzioni
# dello stesso job (qui 6 ore contro 20 minuti): questo script non conosce
# la pianificazione e non lo controlla. Il job ha comunque un proprio lock
# anti-sovrapposizione (flock).
#
# Regola degli errori (scelta deliberata): tutto ciò che riguarda il RITARDO
# è "fail-open" — se il calcolo fallisce (sha256sum assente, finestra non
# valida, NODE non configurato) il job parte comunque, SENZA ritardo, e
# l'errore va in logs/cron-errors.log: perdere il job sarebbe peggio che
# perdere lo sfasamento. Tutto ciò che impedisce di sapere COSA lanciare
# è "fail-closed": nessun job, o job non valido/non eseguibile, termina con
# un errore e non lancia nulla.
#
# Il job viene lanciato con exec: il codice di uscita è il suo, e i suoi
# messaggi di log portano il suo nome, non quello di questo script.
#
set -u
set -o pipefail

#
# Variabile unica per la directory di installazione — v. stessa nota in
# backup.sh.
#
INSTALL_DIR="/home/meshcore/trace-mon"

#
# Log su file — errori (log_err) e messaggi informativi/di stato
# (log_info) in due file separati dentro logs/, indipendenti da come cron
# redirige lo stdout dello script (v. docs/CHANGES_log_errori_cron_su_file.md).
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

NODE="node_01"
SALT="trace-mon:cron-offset:v4179"
DEFAULT_WINDOW=1200
REF_WINDOW=1200
MAX_WINDOW=3600
ID_PATTERN='^[A-Za-z0-9_-]+$'
JOB_PATTERN='^[A-Za-z0-9._-]+$'

#
# Finestra valida: da 1 a MAX_WINDOW secondi, solo cifre (al massimo 5).
# Gli zeri iniziali non fanno l'ottale: si forza la base 10.
#
valid_window() {
    local w="$1"

    [[ "$w" =~ ^[0-9]{1,5}$ ]] || return 1
    w=$((10#$w))
    [ "$w" -ge 1 ] && [ "$w" -le "$MAX_WINDOW" ]
}

#
# Ritardo in secondi (0 .. finestra-1) per l'ID $1 e la finestra $2,
# scritto su stdout: la posizione dell'ID in REF_WINDOW riscalata alla
# finestra (per difetto). Ritorna 1 se l'hash non si può calcolare.
#
compute_delay() {
    local node="$1"
    local window=$((10#$2))
    local digest hex base

    digest="$(printf '%s' "${SALT}:${node}" | sha256sum 2>/dev/null)" || return 1
    hex="${digest:0:8}"
    [[ "$hex" =~ ^[0-9a-f]{8}$ ]] || return 1

    base=$((16#$hex % REF_WINDOW))
    echo $((base * window / REF_WINDOW))
}

WINDOW="$DEFAULT_WINDOW"
SHOW=0
SHOW_NODE=""
NODE_OPT=0
QUIET=0

while [ $# -gt 0 ]; do
    case "$1" in
        --window)
            if [ $# -lt 2 ]; then
                log_err "--window richiede un valore (secondi)"
                exit 2
            fi
            WINDOW="$2"
            shift 2
            ;;
        --show)
            SHOW=1
            shift
            ;;
        --quiet)
            QUIET=1
            shift
            ;;
        --node)
            if [ $# -lt 2 ]; then
                log_err "--node richiede un ID"
                exit 2
            fi
            SHOW_NODE="$2"
            NODE_OPT=1
            shift 2
            ;;
        --)
            shift
            break
            ;;
        -*)
            log_err "opzione sconosciuta: $1"
            exit 2
            ;;
        *)
            break
            ;;
    esac
done

#
# --show: solo calcolo e stampa, nessun job, nessun file di log. Qui un
# argomento sbagliato è un errore (exit 2): non c'è nessun job da salvare.
#
if [ "$SHOW" -eq 1 ]; then
    show_node="$NODE"

    if [ "$NODE_OPT" -eq 1 ]; then
        show_node="$SHOW_NODE"
    fi

    if ! valid_window "$WINDOW"; then
        echo "ERRORE: finestra non valida '$WINDOW' (attesi secondi da 1 a $MAX_WINDOW)"
        exit 2
    fi

    if ! [[ "$show_node" =~ $ID_PATTERN ]]; then
        echo "ERRORE: ID nodo non valido '$show_node'"
        exit 2
    fi

    if ! show_delay="$(compute_delay "$show_node" "$WINDOW")"; then
        echo "ERRORE: calcolo del ritardo non riuscito (sha256sum disponibile?)"
        exit 1
    fi

    printf '%s finestra=%ss ritardo=%ss (%sm%02ds)\n' \
        "$show_node" "$((10#$WINDOW))" "$show_delay" \
        "$((show_delay / 60))" "$((show_delay % 60))"
    exit 0
fi

if [ "$NODE_OPT" -eq 1 ]; then
    log_err "--node si usa solo con --show"
    exit 2
fi

if [ $# -lt 1 ]; then
    log_err "nessun job indicato (uso: cron_delay.sh [--window SECONDI] <job> [argomenti...])"
    exit 2
fi

JOB="$1"
shift

if ! [[ "$JOB" =~ $JOB_PATTERN ]] || [ "$JOB" = "$(basename "$0")" ]; then
    log_err "job non valido: '$JOB' (solo il nome di un file della directory di installazione, mai questo script)"
    exit 2
fi

if [ ! -f "$INSTALL_DIR/$JOB" ] || [ ! -x "$INSTALL_DIR/$JOB" ]; then
    log_err "job non eseguibile: $INSTALL_DIR/$JOB"
    exit 1
fi

#
# Da qui in poi il job partirà comunque: ogni problema sul ritardo lo
# azzera e basta (fail-open, v. intestazione).
#
DELAY=0

if [ "$NODE" = "node_""XX" ]; then
    log_err "NODE non configurato (setup.sh non ha sostituito l'ID del nodo): nessun ritardo per $JOB"
elif ! valid_window "$WINDOW"; then
    log_err "finestra non valida '$WINDOW' (attesi secondi da 1 a $MAX_WINDOW): nessun ritardo per $JOB"
elif ! DELAY="$(compute_delay "$NODE" "$WINDOW")"; then
    DELAY=0
    log_err "calcolo del ritardo non riuscito (sha256sum disponibile?): nessun ritardo per $JOB"
fi

if [ "$QUIET" -eq 0 ]; then
    log_info "$JOB: ritardo di ${DELAY}s (nodo $NODE, finestra ${WINDOW}s)"
fi

if [ "$DELAY" -gt 0 ]; then
    sleep "$DELAY"
fi

cd "$INSTALL_DIR" || {
    log_err "ERRORE: cd $INSTALL_DIR fallita, uscita."
    exit 1
}

exec "./$JOB" "$@"
