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

async def main():
    parser = argparse.ArgumentParser(
        description="PING test client for MeshCore daemon"
    )

    parser.parse_args()
    client = IPCClient()

    print()
    print("========================================")
    print("        MeshCore Daemon PING Test")
    print("========================================")
    print()

    print("Invio richiesta...")
    print()

    response = await client.request(
        service="system",
        command="ping"
    )

    print("Response")
    print("----------------------------------------")

    pprint(response)
    print()

if __name__ == "__main__":
    asyncio.run(main())
