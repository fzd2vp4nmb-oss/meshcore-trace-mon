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

            #
            # Una entry malformata in trace.paths (code review
            # 2026-08-20, §4) non deve far fallire l'intera campagna
            # — viene saltata e loggata, coerente con il trattamento
            # già riservato agli errori di scrittura più sotto.
            #
            try:
                path, enabled = parse_path_entry(entry)

            except ValueError:
                log.exception(
                    "TRACE: entry non valida in trace.paths, saltata: %r",
                    entry
                )
                continue

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
                timeout=self.timeout,
                #
                # Il servizio 'trace' attende fino a self.timeout
                # secondi la risposta radio (TRACE_DATA) prima di
                # arrendersi — il timeout IPC lato client deve
                # restare più ampio di quello, altrimenti il client
                # abbandonerebbe la connessione (IPCError) mentre il
                # daemon sta ancora aspettando legittimamente,
                # rispondendo poi "a vuoto" su un socket già chiuso.
                #
                ipc_timeout=self.timeout + 15
            )

            #
            # Compatibilità con trace.sh storico.
            #
            # Accesso difensivo (code review 2026-08-20, §4) — prima
            # un accesso diretto con [] a "status"/"result"/"message"
            # avrebbe fatto fallire con un KeyError grezzo l'intera
            # campagna se il daemon avesse mai risposto con un
            # payload IPC malformato (bug lato daemon, versione IPC
            # disallineata, ecc.), invece di degradare al solo path
            # corrente come già avviene per gli errori di scrittura.
            #
            if response.get("status") == "ok":
                payload = response.get("result", {})

            else:

                payload = {
                    "error": response.get("message", "risposta IPC senza dettagli")
                }

            #
            # Un errore di I/O qui (disco pieno, permessi) prima di
            # questo fix (code review 2026-08-20, §3.2) interrompeva
            # l'intero batch invece del solo path corrente — gli
            # altri path già interrogati con successo restavano
            # comunque persi se non ancora scritti su disco.
            #
            try:
                self.writer.write(
                    trace_path=path,
                    payload=payload
                )

            except Exception:
                log.exception(
                    "TRACE: scrittura su trace.json fallita per il "
                    "path %s — proseguo con i path successivi.",
                    path
                )

            #
            # Attesa tra un trace e il successivo — non dopo l'ultimo
            #
            if i < len(enabled_paths) - 1:
                await asyncio.sleep(
                    self.interval
                )
