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

DEFAULT_TRACE_PATH = "0d28,3075,0d28"

async def main():
    parser = argparse.ArgumentParser(
        description="Trace test client for MeshCore daemon"
    )

    parser.add_argument(
        "path",
        nargs="?",
        default=DEFAULT_TRACE_PATH,
        help="Trace path (default: %(default)s)"
    )

    parser.add_argument(
        "timeout",
        nargs="?",
        type=int,
        default=None,
        help="Optional timeout in seconds"
    )

    args = parser.parse_args()

    print()
    print("========================================")
    print("       MeshCore Daemon TRACE Test")
    print("========================================")
    print()

    print(f"TRACE   : {args.path}")

    if args.timeout is None:
        print("TIMEOUT : default")
    else:
        print(f"TIMEOUT : {args.timeout} s")

    print()

    request = {
        "path": args.path
    }

    if args.timeout is not None:
        request["timeout"] = args.timeout

    #
    # Il timeout IPC lato client deve restare più ampio di quello
    # (eventualmente custom) usato dal servizio 'trace' lato daemon
    # per attendere TRACE_DATA — stesso margine di sicurezza usato
    # in mesh_modules/trace/engine.py.
    #
    ipc_timeout = (args.timeout or 20) + 15

    response = await send_ipc_request(
        service="trace",
        command="run",
        ipc_timeout=ipc_timeout,
        **request
    )

    print("Response")
    print("----------------------------------------")

    pprint(response)
    print()

if __name__ == "__main__":
    asyncio.run(main())
