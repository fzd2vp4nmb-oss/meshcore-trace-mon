# MeshCore trace-mon

Un piccolo backend + frontend web per monitorare una rete
[MeshCore](https://meshcore.io/) (LoRa) da un companion collegato
a un Raspberry Pi (o altra macchina Linux equivalente).

## Cosa fa

- **Trace** — traccia periodicamente uno o più path della mesh e ne
  mostra l'andamento nel tempo (SNR); dal timestamp di una singola
  osservazione si apre una vista di dettaglio con mappa geografica
  (nodi coinvolti e SNR per ciascun hop).
- **Nodes** — elenco dei nodi conosciuti dal companion, con dettaglio
  e storico delle osservazioni per ciascuno.
- **Repeaters** — interroga a richiesta i repeater configurati:
  status, telemetria, configurazione, regioni supportate, e i nodi
  che il repeater stesso sente direttamente — con storico mensile
  per questi ultimi.
- **Bot** — risponde a comandi su un canale dedicato
  (`!status`, `!path`, `!meteo`, `!ping`, ecc.).

Il Nodo locale può inoltre inviare periodicamente i propri dati a un
server centrale (Collector) che li aggrega con quelli di altri nodi
della rete. Per configurare il Nodo perché acceda al server serve
contattare l'admin del servizio — vedi
[INSTALL.md](INSTALL.md#14-collegarsi-al-server-collector).

Tutto accessibile da un'interfaccia web semplice, servita
localmente dal Raspberry stesso.

## Installazione

Prerequisiti di sistema, Python, Node.js, configurazione del
companion MeshCore e avvio dei servizi: segui **[INSTALL.md](INSTALL.md)**
dall'inizio, nell'ordine indicato.

## Requisiti

- Python 3.9+
- Node.js 22.5+
- sqlite3
- Un companion MeshCore configurato secondo i criteri descritti in
  [INSTALL.md](INSTALL.md#1-configurazione-del-companion-meshcore)

## Licenza

MIT — vedi [LICENSE](LICENSE).
