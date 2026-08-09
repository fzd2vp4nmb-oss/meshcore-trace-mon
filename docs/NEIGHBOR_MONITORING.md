# Interrogazione repeater (tab Repeaters)

Indipendente dal trace/dagli advertisement: interroga a richiesta un
repeater configurato, ottenendo cinque tipi di informazione diverse,
ciascuna con un proprio meccanismo e un proprio requisito di
permesso sull'access list (ACL) del repeater — vedi
`INSTALL.md` per come configurare i permessi necessari sul companion.

## Le cinque fonti dati

| Dato | Richiede ACL | Richiede login |
|---|---|---|
| Status (batteria, traffico, uptime) | Sì | No |
| Neighbours (nodi sentiti dal repeater) | Sì | No |
| Telemetria (sensori) | Sì | No |
| Regioni supportate | No | No |
| Configurazione (versione firmware, parametri di trasmissione) | Sì (permesso admin) | Sì (password vuota se già ammesso in ACL) |

Le prime tre condividono lo stesso meccanismo di richiesta binaria
diretta. Le regioni usano un meccanismo ancora più aperto, senza
alcun requisito di permesso. La configurazione richiede una vera e
propria sessione di login (gestita internamente, nessuna password da
configurare) seguita da comandi testuali — l'unica delle cinque a
funzionare così.

**Un mancato risultato non implica un permesso mancante**: su un
canale radio LoRa, un timeout è indistinguibile da un rifiuto per
permessi insufficienti. Un valore assente in una singola
interrogazione va semplicemente riprovato al giro successivo.

## Storico

Solo i **neighbours** hanno uno storico consultabile (rotazione
mensile, stesso principio di `CONTACT_MANAGEMENT.md`) — le altre
quattro fonti sono letture istantanee o configurazione persistente
sul repeater stesso, non hanno lo stesso bisogno. I neighbours
invece sono stato che il repeater accumula in RAM e perde ad ogni
riavvio: senza storico, quel dato pre-riavvio andrebbe perso per
sempre.

Un mese archiviato può contenere più interrogazioni distinte (una
per ogni giro di cron) — il frontend permette di scegliere sia il
mese sia l'interrogazione specifica al suo interno.

## Configurazione

`neighbor_monitoring.repeaters` in `config.yaml` elenca i repeater da
interrogare (per nome, risolto in chiave pubblica a runtime). La
cadenza è quella della relativa voce di crontab — vedi `INSTALL.md`.
