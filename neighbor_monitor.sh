#!/bin/bash

#
# set -u/set -o pipefail + lock anti-sovrapposizione (code review
# 2026-08-20, §3.7) — v. backup.sh per la motivazione completa.
# Rilevante qui in particolare perché una singola esecuzione può
# legittimamente durare fino a ~10-15 minuti nel caso peggiore (v.
# code review §1.3): senza lock, un'esecuzione ancora in corso al
# giro successivo (ogni 2 ore) avrebbe potuto sovrapporsi.
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
# motivazione originale e questo aggiornamento; qui in origine per
# code review 2026-08-20, §3.2 — prima non veniva controllato l'exit
# code del comando principale, a differenza degli altri script di
# manutenzione già irrobustiti: un errore di I/O come una scrittura
# fallita su contacts.db restava silenzioso sui nodi senza email cron
# configurata). Definiti qui, PRIMA del lock e del cd verso
# INSTALL_DIR, così anche quei due messaggi (lock già preso, cd
# fallita) finiscono su file — v. backup.sh per la nota completa sul
# limite noto (disco pieno) e sui path assoluti.
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

LOCKFILE="$INSTALL_DIR/run/neighbor_monitor.sh.lock"
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
# Nessuno scp qui: i risultati finiscono in contacts.db, già
# sincronizzato verso il Collettore ogni 5 minuti da contact_sync.sh
# — non serve un trasferimento dedicato come per trace.json.
#
./main_neighbor_monitor.py

if [ $? -ne 0 ]; then
    log_err "Errore durante l'esecuzione di main_neighbor_monitor.py"
    exit 1
fi

exit 0
