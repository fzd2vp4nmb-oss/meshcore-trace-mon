#!/home/meshcore/trace-mon/.venv/bin/python3

from pathlib import Path
import sys

#
# Root del progetto
#
PROJECT_ROOT = Path(__file__).resolve().parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

#
# Bootstrap applicazione
#
from bootstrap import bootstrap

bootstrap()

import argparse
import asyncio

from core.logger import log
from mesh_modules.neighbor_monitor.engine import NeighborMonitorEngine


async def main():
    parser = argparse.ArgumentParser(
        description="Neighbor monitor acquisition client"
    )

    parser.parse_args()

    try:
        log.info("Starting neighbor monitor acquisition...")
        engine = NeighborMonitorEngine()
        await engine.run()
        log.info("Neighbor monitor acquisition completed.")

    except Exception:
        log.exception(
            "Unhandled exception"
        )

        raise

    finally:
        log.info(
            "Application terminated."
        )


if __name__ == "__main__":
    asyncio.run(main())
