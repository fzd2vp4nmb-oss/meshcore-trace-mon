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
import signal

from core.engine import Engine
from core.logger import log
from services.context import ServiceContext
from services.dispatcher import Dispatcher
from services.ipc_server import IPCServer
from services.loader import ServiceLoader


class MeshCoreDaemon:
    """
    Processo residente proprietario della connessione MeshCore.

    Responsabilità:

        - mantiene aperta la connessione MeshCore
        - carica dinamicamente i servizi
        - gestisce il Dispatcher
        - gestisce il server IPC

    Il daemon non conosce alcun servizio applicativo.
    """

    def __init__(self):

        #
        # Engine
        #
        self.engine = Engine()

        #
        # Dispatcher
        #
        self.dispatcher = Dispatcher()

        #
        # Server IPC — usa il command_lock condiviso di Engine
        #
        self.ipc = IPCServer(
            self.dispatcher,
            self.engine
        )

        #
        # Shutdown event
        #
        self._shutdown = asyncio.Event()

    async def start(self):
        """
        Avvio del daemon.
        """

        log.info("Starting MeshCore daemon...")

        #
        # Connessione MeshCore
        #
        await self.engine.connect()

        log.info(
            "MeshCore connection established (%s).",
            self.engine.connection_type.upper()
        )

        #
        # Contesto condiviso
        #
        context = ServiceContext(
            engine=self.engine,
            dispatcher=self.dispatcher
        )

        #
        # Caricamento dinamico servizi
        #
        loader = ServiceLoader(
            dispatcher=self.dispatcher,
            context=context
        )

        loader.load()

        #
        # Avvio IPC
        #
        await self.ipc.start()

        log.info("IPC Server started.")

        #
        # Rimane residente
        #
        await self._shutdown.wait()

    async def stop(self):
        """
        Arresto ordinato.
        """

        log.info("Stopping MeshCore daemon...")

        await self.ipc.stop()

        if self.engine.connected:
            await self.engine.disconnect()

        log.info("MeshCore daemon stopped.")

    def shutdown(self):
        self._shutdown.set()


async def main():
    daemon = MeshCoreDaemon()

    loop = asyncio.get_running_loop()

    loop.add_signal_handler(
        signal.SIGINT,
        daemon.shutdown
    )

    loop.add_signal_handler(
        signal.SIGTERM,
        daemon.shutdown
    )

    try:
        await daemon.start()

    finally:
        await daemon.stop()


if __name__ == "__main__":
    asyncio.run(main())
