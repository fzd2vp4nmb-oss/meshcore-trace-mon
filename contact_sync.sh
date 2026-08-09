#!/bin/bash

cd /home/meshcore/trace-mon

NODE="node_XX"
SNAPSHOT="data/contacts_export.db"

#
# Se il daemon non ha ancora creato il DB (es. subito dopo
# l'installazione), non c'è nulla da sincronizzare — esce senza
# errore, stesso principio difensivo già usato lato server web.
#
if [ ! -f data/contacts.db ]; then
    exit 0
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
    echo "Errore durante la creazione dello snapshot di contacts.db"
    exit 1
fi

scp -P 15450 "$SNAPSHOT" trace-mon@IP_SERVER:/home/trace-mon/data/$NODE/contacts.db

exit 0
