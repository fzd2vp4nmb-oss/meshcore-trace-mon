#!/bin/bash

cd /home/meshcore/trace-mon

#
# Nessuno scp qui: i risultati finiscono in contacts.db, già
# sincronizzato verso il Collettore ogni 5 minuti da contact_sync.sh
# — non serve un trasferimento dedicato come per trace.json.
#
./main_neighbor_monitor.py

exit 0
