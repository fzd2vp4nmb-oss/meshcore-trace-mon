import asyncio
import random

from meshcore.events import EventType
from core.config import config
from core.logger import log
from core.event_correlation import wait_for_matching_event

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

    async def _wait_for_own_trace(
        self,
        expected_tag,
        timeout,
        tag
    ):
        """
        Continua a drenare la coda finché non arriva un TRACE_DATA il
        cui campo 'tag' corrisponde a quello generato per QUESTA
        richiesta — scarta (senza consumarlo come risposta valida)
        qualunque altro TRACE_DATA nel frattempo, entro la stessa
        finestra di timeout complessiva. Stesso principio già
        applicato in neighbor_monitor.py (_wait_for_own_response())
        per le risposte CLI: la coda non è isolata per richiesta, un
        trace innescato da un altro nodo sulla mesh (o una risposta
        in ritardo di un giro precedente, mai consumata perché
        arrivata dopo il timeout) può arrivare nella stessa finestra
        ed essere scambiato per la nostra risposta — bug reale
        osservato sul campo (2026-08-17): un trace verso "2559,cfa4,
        2559" ha restituito hash completamente estranei al path
        richiesto.
        """

        def _on_discard(event):
            log.info(
                "TRACE: %s TRACE_DATA scartato (tag=%s, atteso "
                "%s) — non è la risposta a questa richiesta.",
                tag,
                event.payload.get("tag"),
                expected_tag
            )

        return await wait_for_matching_event(
            get_next=self._queue.get,
            is_match=lambda event: (
                event.payload.get("tag") == expected_tag
            ),
            timeout=timeout,
            on_discard=_on_discard
        )

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

        #
        # Tag NUMERICO di correlazione radio (32 bit) — non va
        # confuso con 'tag' sopra (quello è solo per i log). Generato
        # qui esplicitamente, invece di lasciarlo scegliere a caso da
        # send_trace(), per poterlo confrontare con quello della
        # risposta ricevuta e scartare TRACE_DATA che non ci
        # appartengono (vedi _wait_for_own_trace()).
        #
        trace_tag = random.randint(1, 0xFFFFFFFF)

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
                tag=trace_tag,
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
        # attesa risposta — solo quella con il nostro trace_tag,
        # scartando qualunque altro TRACE_DATA nel frattempo (vedi
        # _wait_for_own_trace()).
        #
        try:
            event = await self._wait_for_own_trace(
                trace_tag,
                timeout,
                tag
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
