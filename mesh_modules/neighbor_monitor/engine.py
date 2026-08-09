import asyncio

from core.config import config
from core.logger import log
from clients.ipc_client import IPCClient
from mesh_modules.neighbor_monitor.writer import NeighborMonitorWriter


class NeighborMonitorEngine:
    """
    Coordina una campagna di interrogazione repeater (status +
    neighbours).

    Le query vengono richieste al daemon tramite IPC (stesso
    disaccoppiamento già usato da TraceEngine), mentre la scrittura
    in contacts.db resta locale a questo processo — coerente con
    tools/rotate_path_observations.py, che tocca lo stesso file da
    un processo separato dal daemon.
    """

    def __init__(self):

        self.client = IPCClient()

        self.writer = NeighborMonitorWriter(
            config["contacts.db_file"]
        )

        self.repeaters = config.get(
            "neighbor_monitoring.repeaters",
            []
        )

        #
        # Attesa tra una query e la successiva quando sono
        # configurati più repeater — stesso ruolo di trace.interval,
        # per non mandare le richieste radio una via l'altra senza
        # respiro.
        #
        self.interval = config.get(
            "neighbor_monitoring.interval",
            5
        )

    async def run(self):
        """
        Esegue una singola campagna su tutti i repeater configurati
        e termina.
        """

        if not self.repeaters:

            log.info(
                "NeighborMonitorEngine: nessun repeater configurato "
                "(neighbor_monitoring.repeaters vuoto), nulla da fare."
            )

            return

        for i, repeater in enumerate(self.repeaters):

            name = repeater.get("name")

            if not name:

                log.warning(
                    "NeighborMonitorEngine: voce repeater senza "
                    "'name' in configurazione, saltata: %r",
                    repeater
                )

                continue

            response = await self.client.request(
                service="neighbor_monitor",
                command="run",
                repeater_name=name
            )

            if response["status"] == "ok":

                self.writer.write(
                    response["result"]
                )

                log.info(
                    "NeighborMonitorEngine: %s salvato in contacts.db.",
                    name
                )

            else:

                #
                # Stesso principio già adottato altrove nel progetto
                # (!meteo, !status): una query fallita non produce
                # nessuna riga — non c'è un "errore" significativo da
                # salvare, il frontend mostrerà semplicemente l'ultima
                # query riuscita disponibile.
                #
                log.warning(
                    "NeighborMonitorEngine: %s fallita (%s), nessuna "
                    "riga scritta.",
                    name,
                    response.get("message")
                )

            #
            # Attesa tra una query e la successiva — non dopo
            # l'ultima.
            #
            if i < len(self.repeaters) - 1:

                await asyncio.sleep(
                    self.interval
                )

        self.writer.close()
