#!/bin/bash

cd /home/meshcore/trace-mon

NODE="node_XX"

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
    echo "Errore durante la rotazione di path_observations"
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
    echo "Errore durante la rotazione di repeater_neighbours"
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

cd /home/meshcore/trace-mon/backup

if [ -f "$FILEOUTZIP" ]; then
    scp -P 15450 $FILEOUTZIP trace-mon@IP_SERVER:/home/trace-mon/backup/$NODE
fi

if [ -f "$FILEOUTZIP2" ]; then
    scp -P 15450 $FILEOUTZIP2 trace-mon@IP_SERVER:/home/trace-mon/backup/$NODE
fi

exit 0
