# MeshCore trace-mon

Un piccolo backend + frontend web per monitorare una rete
[MeshCore](https://meshcore.co.uk/) (LoRa) da un companion collegato
a un Raspberry Pi (o altra macchina Linux equivalente).

## Cosa fa

- **Trace** — traccia periodicamente uno o più path della mesh e ne
  mostra l'andamento nel tempo (SNR).
- **Nodes** — elenco dei nodi conosciuti dal companion, con dettaglio
  e storico delle osservazioni per ciascuno.
- **Repeaters** — interroga a richiesta i repeater configurati:
  status, telemetria, configurazione, regioni supportate, e i nodi
  che il repeater stesso sente direttamente — con storico mensile
  per questi ultimi.
- **Bot** — risponde a comandi su un canale dedicato o via messaggio
  diretto (`!status`, `!path`, `!meteo`, `!ping`, ecc.).

Tutto accessibile da un'interfaccia web semplice, servita
localmente dal Raspberry stesso.

## Installazione

Prerequisiti di sistema, Python, Node.js, configurazione del
companion MeshCore e avvio dei servizi: segui **[INSTALL.md](INSTALL.md)**
dall'inizio, nell'ordine indicato.

## Requisiti

- Python 3.9+
- Node.js 22.5+
- Un companion MeshCore configurato secondo i criteri descritti in
  [INSTALL.md](INSTALL.md#1-configurazione-del-companion-meshcore)

## Licenza

MIT — vedi [LICENSE](LICENSE).
