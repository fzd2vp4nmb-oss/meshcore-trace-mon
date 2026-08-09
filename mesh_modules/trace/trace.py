import asyncio

from meshcore.events import EventType
from core.config import config
from core.logger import log

class TraceModule:
    """
    Esegue trace di rotta sfruttando l'istanza MeshCore corrente,
    letta dinamicamente da Engine ad ogni chiamata — non ne tiene
    mai una copia locale, per restare valido anche dopo una
    riconnessione completa (nuova istanza MeshCore).
    """

    def __init__(self, engine):
        self.engine = engine

        self.timeout = config.get(
            "trace.timeout",
            15
        )

        self._queue = asyncio.Queue()

        self._subscribe()

        #
        # Ri-sottoscrive automaticamente quando la connessione
        # viene ricreata da zero (nuova istanza MeshCore). Non
        # serve per le riconnessioni transitorie, gestite in
        # autonomia dalla libreria sulla stessa istanza.
        #
        self.engine.register_rebind(self._on_rebind)

    def _subscribe(self):
        self.engine.mesh.subscribe(
            EventType.TRACE_DATA,
            self._trace_callback
        )

    def _on_rebind(self, mesh):
        log.info(
            "TraceModule: rebinding TRACE_DATA subscription."
        )

        self._subscribe()

    async def _trace_callback(self, event):
        await self._queue.put(event)

    async def trace(
        self,
        path,
        timeout=None
    ):

        if timeout is None:
            timeout = self.timeout

        #
        # Tag di correlazione per tutte le righe di log di questa
        # chiamata — il path stesso, già un identificativo leggibile.
        #
        tag = f"[path:{path}]"

        if not self.engine.connected:

            log.warning(
                "TRACE: %s connessione non attiva, invio annullato.",
                tag
            )

            return None

        #
        # elimina eventuali eventi rimasti
        #
        while not self._queue.empty():
            self._queue.get_nowait()

        #
        # invia il trace (sempre sull'istanza mesh corrente)
        #
        log.info("TRACE: %s sending command", tag)

        try:
            result = await self.engine.mesh.commands.send_trace(
                path=path
            )

            #
            # Se l'invio stesso è fallito (es. connessione appena
            # caduta), non aspettare inutilmente il timeout completo.
            # Il dettaglio completo dell'evento (utile in diagnosi)
            # va nel log SOLO in caso di errore — sul percorso normale
            # appesantiva solamente la lettura.
            #
            if result.type == EventType.ERROR:

                log.warning(
                    "TRACE: %s send_trace() reported an error: %r",
                    tag,
                    result.payload
                )

                #
                # Errore sul comando stesso (link locale al
                # companion), non sul timeout di TRACE_DATA (quello
                # è un esito radio normale) — segnala subito a
                # Engine.
                #
                self.engine.report_possible_failure()

                return None

            log.info(
                "TRACE: %s send_trace() ok, waiting TRACE_DATA...",
                tag
            )

        except Exception:

            log.exception(
                "TRACE: %s send_trace() failed",
                tag
            )

            self.engine.report_possible_failure()

            raise

        #
        # attesa risposta
        #
        try:
            event = await asyncio.wait_for(
                self._queue.get(),
                timeout
            )

            log.info(
                "TRACE: %s TRACE_DATA received",
                tag
            )

            return event.payload

        except asyncio.TimeoutError:

            log.warning(
                "TRACE: %s timeout waiting TRACE_DATA",
                tag
            )

            return None
