#!/home/meshcore/trace-mon/.venv/bin/python3

from pathlib import Path
import sys

#
# Root del progetto
#
PROJECT_ROOT = Path(__file__).resolve().parent.parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from bootstrap import bootstrap

bootstrap()

import argparse
import asyncio
from pprint import pprint

from tools.ipc_test_common import send_ipc_request
from mesh_modules.bot.commands.path import split_path_hops

#
# 255 e -1 indicano entrambi "routing non ancora noto" (code review
# 2026-08-20, §3.8) — stesso byte 0xFF, interpretato come signed da
# meshcore_py in alcuni percorsi e come unsigned in altri; prima
# veniva controllato solo 255, quindi un -1 cadeva nel ramo
# "out_path_len == 0" sottostante e veniva etichettato erroneamente
# come "DIRECT (0 hop)" invece di "FLOOD (routing non ancora noto)".
# Stessa costante già in uso in test_contact_list.py.
#
UNKNOWN_OUT_PATH_VALUES = (255, -1)


def format_routing(out_path_len, out_path):

    if out_path_len is None:
        return "sconosciuto (campo assente)"

    if out_path_len in UNKNOWN_OUT_PATH_VALUES:
        return "FLOOD (routing non ancora noto)"

    if out_path_len == 0 or not out_path:
        return "DIRECT (0 hop)"

    hops = split_path_hops(out_path, out_path_len)

    return f"{out_path_len} hop -> " + " > ".join(hops)


async def main():

    parser = argparse.ArgumentParser(
        description="Interroga lo stato di routing di un contatto "
                     "conosciuto dal daemon, tramite IPC."
    )

    group = parser.add_mutually_exclusive_group(required=True)

    group.add_argument(
        "--name",
        help="Nome del contatto (adv_name), anche parziale"
    )

    group.add_argument(
        "--prefix",
        help="Prefisso esadecimale della chiave pubblica"
    )

    args = parser.parse_args()

    request = (
        {"name": args.name}
        if args.name else
        {"prefix": args.prefix}
    )

    print()
    print("========================================")
    print("       MeshCore Daemon CONTACT Test")
    print("========================================")
    print()

    print("Invio richiesta...")
    print()

    response = await send_ipc_request(
        service="system",
        command="contact",
        **request
    )

    print("Response")
    print("----------------------------------------")

    pprint(response)
    print()

    if response.get("status") == "ok":

        #
        # Accesso difensivo (code review 2026-08-20, §4) — v. stessa
        # nota in test_contact_list.py.
        #
        result = response.get("result", {})

        print(f"Contatto     : {result.get('adv_name')}")
        print(
            f"Routing      : "
            f"{format_routing(result.get('out_path_len'), result.get('out_path'))}"
        )
        print(f"Public key   : {result.get('public_key')}")
        print(f"Last advert  : {result.get('last_advert')}")

    else:
        print(f"Errore: {response.get('message')}")


if __name__ == "__main__":

    asyncio.run(main())
