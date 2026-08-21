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
                repeater_name=name,
                #
                # Caso peggiore noto e documentato (v. code review
                # 2026-08-20, §1.3): con neighbor_monitoring.max_retries
                # e CLI_RESPONSE_TIMEOUT=10s fissi, una singola
                # interrogazione (fino a ~12 comandi CLI) su un
                # repeater irraggiungibile può restare legittimamente
                # in corso, sotto Engine.command_lock, per diversi
                # minuti prima di arrendersi. Un timeout IPC troppo
                # stretto qui farebbe fallire il client con un falso
                # "daemon bloccato" mentre il daemon sta solo
                # esaurendo i retry come da design — 15 minuti sono
                # un margine deliberatamente generoso rispetto al
                # worst-case teorico (~10 minuti). Se in futuro §1.3
                # viene affrontato riducendo il worst-case (es. un
                # timeout complessivo per repeater indipendente dal
                # prodotto retry×timeout), questo valore andrà
                # ridotto di conseguenza.
                #
                ipc_timeout=900
            )

            #
            # Accesso difensivo a "status"/"result" (code review
            # 2026-08-20, §4) — v. TraceEngine.run() per la
            # motivazione: un payload IPC malformato non deve far
            # fallire con un KeyError grezzo l'intera campagna,
            # ripete qui lo stesso trattamento già applicato lì.
            #
            if response.get("status") == "ok":

                #
                # Un errore di I/O/DB qui prima di questo fix (code
                # review 2026-08-20, §3.2) interrompeva l'intero
                # batch invece del solo repeater corrente.
                #
                try:
                    self.writer.write(
                        response.get("result", {})
                    )

                    log.info(
                        "NeighborMonitorEngine: %s salvato in "
                        "contacts.db.",
                        name
                    )

                except Exception:
                    log.exception(
                        "NeighborMonitorEngine: scrittura in "
                        "contacts.db fallita per %s — proseguo con "
                        "i repeater successivi.",
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
