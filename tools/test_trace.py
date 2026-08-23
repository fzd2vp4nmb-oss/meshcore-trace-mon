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
from core.trace_timeout_estimate import estimate_ipc_timeout
from tools.ipc_test_common import send_ipc_request

DEFAULT_TRACE_PATH = "0d28,3075,0d28"

async def _fetch_radio_params():
    """
    Interroga il daemon per i parametri radio reali del device, usati
    per stimare un margine di timeout IPC più accurato (v.
    core/trace_timeout_estimate.py e la stessa logica in
    mesh_modules/trace/engine.py, TraceEngine._fetch_radio_params() —
    duplicata qui invece di condivisa perché questo è uno script CLI
    indipendente, non un metodo di TraceEngine).

    A differenza della richiesta 'trace run' vera e propria (inviata
    più sotto tramite send_ipc_request(), che termina lo script con
    errore se il daemon non risponde), un fallimento qui è tollerato
    in silenzio: è un dato accessorio per il calcolo del margine, la
    sua assenza degrada semplicemente alla formula statica storica,
    esattamente come in TraceEngine — non deve mai impedire l'esecuzione
    della trace richiesta.
    """

    try:
        response = await IPCClient().request(
            service="system",
            command="status"
        )

    except Exception:
        return None

    if response.get("status") != "ok":
        return None

    return response.get("result", {}).get("radio")

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
    # (eventualmente custom) usato dal servizio 'trace' lato daemon per
    # attendere TRACE_DATA — che dal 2026-08-23 non è più limitato dal
    # fallback statico quando il firmware fornisce un proprio
    # suggested_timeout (v. TraceModule._resolve_timeout()). Stimato
    # dai parametri radio reali del device quando disponibili
    # (_fetch_radio_params() sopra), altrimenti dalla stessa formula
    # statica di sempre — stessa logica di
    # mesh_modules/trace/engine.py, v. core/trace_timeout_estimate.py.
    #
    static_timeout = args.timeout if args.timeout is not None else 20

    radio = await _fetch_radio_params()

    ipc_timeout = estimate_ipc_timeout(
        args.path,
        radio,
        static_timeout
    )

    #
    # Osservabilità (2026-08-23, richiesta utente — stessa aggiunta di
    # mesh_modules/trace/engine.py, v.
    # docs/CHANGES_trace_timeout_dinamico_hop.md): solo il valore
    # usato, nessun confronto.
    #
    print(f"IPC_TIMEOUT: {ipc_timeout:.1f} s")
    print()

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
