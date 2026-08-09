#!/home/meshcore/trace-mon/.venv/bin/python3

from pathlib import Path
import sys

#
# Root del progetto
#
PROJECT_ROOT = Path(__file__).resolve().parent.parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

#
# Bootstrap applicazione
#
from bootstrap import bootstrap

bootstrap()

import asyncio

from clients.ipc_client import IPCClient

async def main():
    client = IPCClient()

    response = await client.request(
        service="advert",
        command="advert"
    )

    if response.get("status") != "ok":
        message = response.get(
            "message",
            "unknown error"
        )

        print(
            f"ERROR: {message}",
            file=sys.stderr
        )

        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(
        asyncio.run(main())
    )
