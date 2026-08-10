#!/home/meshcore/trace-mon/.venv/bin/python3

"""
tools/sync_clock.py

Sincronizza l'orologio del companion MeshCore con quello del
Raspberry — equivalente al "clock sync" della CLI/app ufficiale.
Non è una funzione periodica né esposta al daemon: va eseguita
all'occorrenza (es. dopo un reboot del companion che ha perso il
sync orario), a mano.

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
import time
from datetime import datetime, timezone

from meshcore.meshcore import MeshCore
from meshcore.events import EventType

from core.config import config


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
        get_result = await mesh.commands.get_time()

        if get_result.type == EventType.ERROR:

            print(
                f"ERRORE: impossibile leggere l'ora del device: "
                f"{get_result.payload}",
                file=sys.stderr
            )

            sys.exit(1)

        device_time = get_result.payload["time"]
        local_time = int(time.time())
        drift = local_time - device_time

        print(f"Ora del device:     {format_time(device_time)}")
        print(f"Ora del Raspberry:  {format_time(local_time)}")
        print(f"Differenza:         {drift:+d} secondi")

        if args.check:
            print("Modalità --check: nessuna modifica effettuata.")
            return

        if abs(drift) < 5:

            print(
                "Differenza trascurabile (< 5s), nessuna sincronizzazione "
                "necessaria."
            )

            return

        print("Sincronizzazione in corso...")

        set_result = await mesh.commands.set_time(local_time)

        if set_result.type == EventType.ERROR:

            print(
                f"ERRORE: impossibile impostare l'ora del device: "
                f"{set_result.payload}",
                file=sys.stderr
            )

            sys.exit(1)

        #
        # Rilettura per conferma — non ci fidiamo del solo OK locale,
        # stesso principio già applicato altrove nel progetto (un
        # comando accettato localmente non prova che l'effetto
        # desiderato sia avvenuto).
        #
        verify_result = await mesh.commands.get_time()

        if verify_result.type == EventType.ERROR:

            print(
                "Comando di set inviato, ma non sono riuscito a "
                "verificare il risultato (lettura fallita).",
                file=sys.stderr
            )

            return

        new_device_time = verify_result.payload["time"]
        new_drift = int(time.time()) - new_device_time

        print(f"Ora del device dopo la sincronizzazione: {format_time(new_device_time)}")
        print(f"Differenza residua: {new_drift:+d} secondi")

    finally:
        await mesh.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
