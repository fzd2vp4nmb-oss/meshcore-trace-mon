#!/bin/bash

#
# set -u/set -o pipefail + lock anti-sovrapposizione (code review
# 2026-08-20, §3.7) — v. backup.sh per la motivazione completa.
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
# NOTA: qui non viene aggiunto alcun controllo sull'esito di
# send_floodadv.py sotto — resta una scelta deliberata (v.
# docs/CHANGES_log_errori_cron_su_file.md, nota Rev5): un singolo
# floodadv mancato non è di per sé un evento da tracciare, il prossimo
# giro di cron ne invierà comunque un altro. log_err()/log_info() qui
# servono solo per i due messaggi già esistenti (lock, cd), non per
# introdurre un controllo nuovo sul comando principale.
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

LOCKFILE="$INSTALL_DIR/run/floodadv.sh.lock"
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

./tools/send_floodadv.py

exit 0
