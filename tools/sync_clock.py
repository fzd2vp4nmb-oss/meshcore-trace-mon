#!/home/meshcore/trace-mon/.venv/bin/python3

"""
tools/sync_clock.py

Sincronizza l'orologio del companion MeshCore con quello del
Raspberry — equivalente al "clock sync" della CLI/app ufficiale.

Dalla versione che integra core/clock_sync.py, il daemon esegue
questa stessa sincronizzazione IN AUTOMATICO ad ogni avvio (vedi
services/daemon.py) — un `sudo systemctl restart trace-mon` la
attiva già, senza bisogno di questo tool. Resta utile per:
un controllo/correzione al volo senza riavviare l'intero servizio,
o per verificare lo scarto (--check) senza modificare nulla.

Come gli altri script diagnostici in tools/ (vedi experiments/ nel
mirror di sviluppo), apre una connessione ESCLUSIVA al companion —
va eseguito con il daemon principale FERMO
(sudo systemctl stop trace-mon), altrimenti la connessione è già
occupata.

Uso:
    ./tools/sync_clock.py            # mostra l'ora attuale del device, poi sincronizza
    ./tools/sync_clock.py --check    # mostra solo l'ora attuale, nessuna modifica
"""

from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parent.parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from bootstrap import bootstrap
bootstrap()

import argparse
import asyncio
from datetime import datetime, timezone

from meshcore.meshcore import MeshCore

from core.config import config
from core.clock_sync import sync_clock


async def create_mesh():
    """
    Stessa logica di dispatch di Engine._create_mesh() (core/engine.py)
    — connessione diretta secondo connection.type in config.yaml, non
    passa dal daemon/IPC.
    """

    connection_type = config["connection.type"]

    if connection_type == "tcp":

        return await MeshCore.create_tcp(
            host=config["connection.tcp.host"],
            port=config["connection.tcp.port"],
            debug=False
        )

    elif connection_type == "serial":

        return await MeshCore.create_serial(
            port=config["connection.serial.device"],
            baudrate=config["connection.serial.baudrate"],
            debug=False
        )

    elif connection_type == "ble":

        return await MeshCore.create_ble(
            address=config["connection.ble.address"],
            debug=False
        )

    else:

        print(
            f"ERRORE: tipo di connessione non supportato: {connection_type}",
            file=sys.stderr
        )

        sys.exit(1)


def format_time(unix_time):

    return datetime.fromtimestamp(
        unix_time,
        tz=timezone.utc
    ).strftime("%Y-%m-%d %H:%M:%S UTC")


async def main():

    parser = argparse.ArgumentParser(
        description="Sincronizza l'orologio del companion MeshCore"
    )

    parser.add_argument(
        "--check",
        action="store_true",
        help="Mostra solo l'ora attuale del device, nessuna modifica"
    )

    args = parser.parse_args()

    print("Connessione al companion...")

    mesh = await create_mesh()

    try:
        result = await sync_clock(mesh, dry_run=args.check)

        if not result.ok:

            print(
                f"ERRORE: {result.error}",
                file=sys.stderr
            )

            sys.exit(1)

        print(f"Ora del device:     {format_time(result.device_time_before)}")
        print(f"Ora del Raspberry:  {format_time(result.local_time)}")
        print(f"Differenza:         {result.drift_before:+d} secondi")

        if args.check:
            print("Modalità --check: nessuna modifica effettuata.")
            return

        if not result.synced:

            print(
                "Differenza trascurabile (< 5s), nessuna sincronizzazione "
                "necessaria."
            )

            return

        if result.drift_after is None:

            print(
                f"Comando di set inviato, ma non sono riuscito a "
                f"verificare il risultato: {result.error}",
                file=sys.stderr
            )

            return

        print("Sincronizzazione in corso...")
        print(f"Ora del device dopo la sincronizzazione: {format_time(result.device_time_after)}")
        print(f"Differenza residua: {result.drift_after:+d} secondi")

    finally:
        await mesh.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
