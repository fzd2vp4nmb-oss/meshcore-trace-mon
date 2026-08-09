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

Guida completa, passo per passo (prerequisiti di sistema, Python,
Node.js, configurazione del companion MeshCore, avvio dei servizi):
**[INSTALL.md](INSTALL.md)**.

In breve, dopo aver seguito i prerequisiti:

```bash
git clone https://github.com/<utente>/meshcore-trace-mon.git ~/trace-mon
cd ~/trace-mon
./setup.sh
```

`setup.sh` genera in modo interattivo tutti i file specifici della
tua installazione (script di manutenzione, `config.yaml`, servizio
web) — nessun dato reale è mai distribuito con questo repository.

## Requisiti

- Python 3.9+
- Node.js 22.5+
- Un companion MeshCore configurato secondo i criteri descritti in
  [INSTALL.md](INSTALL.md#11-configurazione-del-companion-meshcore)

## Licenza

MIT — vedi [LICENSE](LICENSE).
