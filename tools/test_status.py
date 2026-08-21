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

async def main():
    parser = argparse.ArgumentParser(
        description="STATUS test client for MeshCore daemon"
    )

    parser.parse_args()

    print()
    print("========================================")
    print("       MeshCore Daemon STATUS Test")
    print("========================================")
    print()

    print("Invio richiesta...")
    print()

    response = await send_ipc_request(
        service="system",
        command="status"
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
        connected = response.get("result", {}).get("connected")

        print()
        print(
            "Device connesso."
            if connected else
            "Device NON connesso."
        )

if __name__ == "__main__":
    asyncio.run(main())
