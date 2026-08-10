import asyncio

from core.config import config
from core.logger import log
from core.trace_paths import parse_path_entry
from clients.ipc_client import IPCClient
from mesh_modules.trace.writer import TraceWriter

class TraceEngine:
    """
    Coordina una campagna di acquisizione TRACE.

    I trace vengono richiesti al daemon tramite IPC,
    mentre la scrittura del file trace.json rimane
    locale a questo processo.
    """

    def __init__(self):
        #
        # Client IPC verso il daemon
        #
        self.client = IPCClient()

        #
        # Writer del file trace.json
        #
        self.writer = TraceWriter(
            config["trace.output_file"]
        )

        #
        # Configurazione — ogni entry può portare un suffisso
        # ,true/,false per abilitare/disabilitare il path senza
        # rimuoverlo da config.yaml (vedi core/trace_paths.py).
        #
        self.paths = config["trace.paths"]

        self.interval = config.get(
            "trace.interval",
            10
        )

        self.timeout = config.get(
            "trace.timeout",
            15
        )

    async def run(self):
        """
        Esegue una singola acquisizione di tutti i path
        configurati (quelli abilitati) e termina.
        """

        enabled_paths = []

        for entry in self.paths:

            path, enabled = parse_path_entry(entry)

            if enabled:
                enabled_paths.append(path)

            else:
                log.info(
                    "TRACE: path %s disabilitato in config.yaml, "
                    "saltato.",
                    path
                )

        for i, path in enumerate(enabled_paths):
            response = await self.client.request(
                service="trace",
                command="run",
                path=path,
                timeout=self.timeout
            )

            #
            # Compatibilità con trace.sh storico.
            #
            if response["status"] == "ok":
                payload = response["result"]

            else:

                payload = {
                    "error": response["message"]
                }

            self.writer.write(
                trace_path=path,
                payload=payload
            )

            #
            # Attesa tra un trace e il successivo — non dopo l'ultimo
            #
            if i < len(enabled_paths) - 1:
                await asyncio.sleep(
                    self.interval
                )
