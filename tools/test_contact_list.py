#!/home/meshcore/trace-mon/.venv/bin/python3

from pathlib import Path
import sys
import time

#
# Root del progetto
#
PROJECT_ROOT = Path(__file__).resolve().parent.parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from bootstrap import bootstrap

bootstrap()

import asyncio

from tools.ipc_test_common import send_ipc_request

#
# Mappa dei valori 'type' osservati/documentati — completare se ne
# emergono altri durante i test (es. sensor).
#
TYPE_NAMES = {
    1: "chat",
    2: "repeater",
    3: "room server",
}

#
# "Path sconosciuto" può arrivare sia come 255 (unsigned) sia come -1
# (stesso byte 0xFF, interpretato come signed da meshcore_py) —
# osservato empiricamente sui dati reali, non solo documentato.
#
UNKNOWN_OUT_PATH_VALUES = (255, -1)


def format_type(t):
    return TYPE_NAMES.get(t, f"sconosciuto ({t})")


def format_last_advert(ts):

    if not ts:
        return "mai"

    return time.strftime(
        "%Y-%m-%d %H:%M:%S",
        time.localtime(ts)
    )


def format_routing(out_path_len, out_path):

    if out_path_len is None:
        return "sconosciuto (campo assente)"

    if out_path_len in UNKNOWN_OUT_PATH_VALUES:
        return "FLOOD (routing non ancora noto)"

    if out_path_len == 0:
        return "DIRECT (0 hop)"

    return f"{out_path_len} hop -> {out_path}"


async def main():

    print()
    print("========================================")
    print("     MeshCore Daemon CONTACTS LIST")
    print("========================================")
    print()

    print("Invio richiesta...")
    print()

    response = await send_ipc_request(
        service="system",
        command="contacts"
    )

    if response.get("status") != "ok":
        print(f"Errore: {response.get('message')}")
        return

    #
    # Accesso difensivo (code review 2026-08-20, §4) — questo è uno
    # script diagnostico interattivo lanciato a mano da riga di
    # comando: un accesso diretto con [] su un payload IPC malformato
    # (bug lato daemon, versione disallineata) produrrebbe un
    # KeyError grezzo invece di un messaggio chiaro. .get() con
    # default rende l'errore leggibile senza cambiare comportamento
    # nel caso normale.
    #
    result = response.get("result", {})

    print(f"Totale contatti: {result.get('count', '?')}")
    print()

    for c in result.get("contacts", []):

        print("-" * 60)
        print(f"Nome         : {c.get('adv_name')}")
        print(f"Tipo         : {format_type(c.get('type'))}")
        print(f"Last advert  : {format_last_advert(c.get('last_advert'))}")
        print(f"Public key   : {c.get('public_key')}")
        print(
            f"Routing      : "
            f"{format_routing(c.get('out_path_len'), c.get('out_path'))}"
        )

    print("-" * 60)


if __name__ == "__main__":

    asyncio.run(main())
