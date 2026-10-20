#!/bin/bash

#
# sonar.sh — trasmette UN messaggio sonar sul canale dedicato
# (docs/ARCHITECTURE.md §87). Pensato per il crontab: la pianificazione
# è SOLO di cron, nessuno scheduler interno al daemon. Gli argomenti
# vengono passati a tools/send_sonar.py, tipicamente --scope:
#
#     sonar.sh                    scope di sonar.tx.scope
#     sonar.sh --scope U          unscoped forzato
#     sonar.sh --scope lombardia  regione
#
# Il messaggio non parte da qui: send_sonar.py chiede l'invio al daemon
# via IPC (unico proprietario del device), che assegna il progressivo
# persistente, imposta lo scope, invia e registra l'esito. Un invio
# troppo ravvicinato (sonar.tx.min_interval) o la trasmissione
# disabilitata (sonar.tx.enabled=false) NON sono errori: vengono solo
# annotati in cron-status.log.
#
# set -u/set -o pipefail + lock anti-sovrapposizione — v. backup.sh per
# la motivazione completa. Un solo lock per tutte le varianti di scope:
# due invocazioni sovrapposte non devono competere per il companion
# (quella arrivata seconda esce senza fare nulla — pianificare le
# varianti a minuti diversi, v. docs/ARCHITECTURE.md §87.4).
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
# (log_info) in due file separati dentro logs/, indipendenti da come
# cron redirige lo stdout dello script (v. advert.sh e
# docs/CHANGES_log_errori_cron_su_file.md).
#
# DIFFERENZA RISPETTO A advert.sh/floodadv.sh (decisione consapevole,
# docs/ARCHITECTURE.md §87): quelli non controllano l'esito del comando
# perché "un singolo advert mancato non è di per sé un evento da
# tracciare". Per il sonar vale il contrario: ogni messaggio è un punto
# di una serie numerata che si analizza dopo, e un invio fallito o
# dall'esito incerto è un buco nella serie. Qui l'esito di
# send_sonar.py viene quindi SEMPRE registrato (stato: cron-status.log,
# errore: cron-errors.log), in aggiunta a sonar_tx lato daemon — che da
# solo non vedrebbe il caso "daemon non raggiungibile".
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

LOCKFILE="$INSTALL_DIR/run/sonar.sh.lock"
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

#
# Codici di uscita di send_sonar.py: 0 inviato, 10 nessun invio atteso
# (non è un errore), qualunque altro valore = errore. Stdout e stderr
# catturati insieme: contengono l'unica riga di esito.
#
output=$(./tools/send_sonar.py "$@" 2>&1)
rc=$?

case "$rc" in
    0|10)
        log_info "sonar: $output"
        exit 0
        ;;
    *)
        log_err "sonar: errore (codice $rc): $output"
        exit 1
        ;;
esac
