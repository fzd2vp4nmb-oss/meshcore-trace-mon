# Architettura

Panoramica tecnica di come è fatto trace-mon. Per i dettagli sui
singoli sottosistemi, vedi anche `CONTACT_MANAGEMENT.md` (gestione
contatti e storico path) e `NEIGHBOR_MONITORING.md` (interrogazione
repeater remoti).

## Struttura generale

Un **daemon Python residente** mantiene l'unica connessione attiva
verso il companion MeshCore (TCP, seriale o BLE — configurabile) e
ospita un insieme di **servizi pluggable**:

- `system` — stato di connessione, riconnessione automatica
- `trace` — tracciamento periodico dei path configurati
- `advert` — invio di advertisement flood
- `bot` — risposta a comandi su canale/DM
- `contact_sync` — sincronizzazione della lista contatti
- `neighbor_monitor` — interrogazione diretta dei repeater

Comunicazione interna via **socket Unix (IPC)**: script esterni
(lanciati da cron per trace/advert/neighbor_monitor) mandano una
richiesta al daemon via IPC invece di aprire una propria connessione
al companion — un'unica connessione condivisa, mai contesa.

## Concorrenza

Ogni comando verso il companion passa da un lock condiviso
(`Engine.command_lock`) — evita che due richieste in corso
contemporaneamente si sovrappongano sulla stessa connessione. Un
health-check periodico (verifica leggera che la connessione sia
ancora viva) gira volutamente **fuori** da questo lock, per non
restare bloccato se un comando in corso si impianta su un device
irraggiungibile.

## Frontend

Server Node.js/Express (`frontend/server.js`) che legge direttamente
il database SQLite (`data/contacts.db`) tramite il modulo nativo
`node:sqlite` — nessuna dipendenza esterna per l'accesso al database.
Frontend statico (HTML/CSS/JS) servito dallo stesso processo.

Tre tab principali:
- **Trace** — andamento nel tempo dei path tracciati
- **Nodes** — elenco e dettaglio dei nodi conosciuti
- **Repeaters** — dati dei repeater interrogati direttamente (vedi
  `NEIGHBOR_MONITORING.md`)

## Comandi del bot

Un comando per file, in `mesh_modules/bot/commands/` — un registro
centrale (`registry.py`) li espone al modulo bot. Aggiungere un
comando significa aggiungere un file in quella cartella, senza
toccare il resto.

## Configurazione

Un unico `config.yaml` (generato da `setup.sh` in fase di
installazione — vedi `INSTALL.md`) governa connessione, path da
tracciare, canale del bot, repeater da interrogare, e quali servizi
sono attivi.
