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
from core.clock_sync import sync_clock
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
        # Sync orologio del companion — un riavvio del DEVICE (non
        # del daemon) gli fa perdere il conteggio orario; prima si
        # correggeva a mano con tools/sync_clock.py, che richiedeva
        # il daemon fermo per avere la connessione libera. Qui gira
        # sulla connessione già aperta da questo stesso daemon,
        # quindi ad ogni riavvio del SERVIZIO — anche quando il
        # device non si è mai spento e non ne avrebbe bisogno, nel
        # qual caso non fa nulla oltre a leggere l'ora e verificare
        # che lo scarto sia trascurabile.
        #
        await self._sync_clock_at_startup()

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

    async def _sync_clock_at_startup(self):
        """
        Non solleva mai — un problema di sync orario non deve
        impedire l'avvio del resto del daemon, viene solo loggato.
        """

        try:
            async with self.engine.command_lock:
                result = await sync_clock(self.engine.mesh)

        except Exception:

            log.exception(
                "Clock sync all'avvio: errore imprevisto, proseguo "
                "comunque con l'avvio."
            )

            return

        if not result.ok:

            log.warning(
                "Clock sync all'avvio fallito: %s",
                result.error
            )

            return

        if not result.synced:

            log.info(
                "Clock sync: device già allineato (scarto %+ds), "
                "nessuna correzione necessaria.",
                result.drift_before
            )

            return

        if result.drift_after is None:

            log.warning(
                "Clock sync: %s",
                result.error
            )

            return

        log.info(
            "Clock sync: corretto uno scarto di %+ds (residuo dopo "
            "la sincronizzazione: %+ds).",
            result.drift_before,
            result.drift_after
        )

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
