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

from clients.ipc_client import IPCClient
from mesh_modules.bot.commands.path import split_path_hops

OUT_PATH_UNKNOWN = 255


def format_routing(out_path_len, out_path):

    if out_path_len is None:
        return "sconosciuto (campo assente)"

    if out_path_len == OUT_PATH_UNKNOWN:
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

    client = IPCClient()

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

    response = await client.request(
        service="system",
        command="contact",
        **request
    )

    print("Response")
    print("----------------------------------------")

    pprint(response)
    print()

    if response.get("status") == "ok":

        result = response["result"]

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
