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

    def _resolve_timeout(self, timeout, result, tag):
        """
        Decide il timeout effettivo da usare per attendere il
        TRACE_DATA di QUESTO invio: il timeout calcolato dal
        firmware in funzione del numero di hop realmente
        attraversati dal path di QUESTA chiamata, quando disponibile
        — altrimenti il valore di config.yaml, usato come semplice
        FALLBACK.

        Decisione 2026-08-23, rivista lo stesso giorno su richiesta
        esplicita dell'utente (v. docs/CHANGES_trace_timeout_dinamico_hop.md
        per la cronologia completa): la prima versione di questa
        logica trattava 'self.timeout' (da config.yaml) come guardia
        superiore invalicabile, capando il valore dinamico quando
        più grande. L'utente ha chiarito che il funzionamento
        desiderato è un altro: 'self.timeout' NON è più un tetto
        massimo, è **solo** il valore da usare quando il firmware
        non fornisce affatto un proprio timeout per questo invio —
        quando lo fornisce, quel valore va usato COSÌ COM'È, anche
        se più grande di 'self.timeout'.

        - Si applica SOLO quando il chiamante non ha richiesto un
          timeout esplicitamente diverso da quello di default
          risolto da config ('timeout == self.timeout' — vero sia
          per l'invocazione IPC senza override esplicito, che arriva
          già risolta a self.timeout da TraceModule.__init__(), sia
          per 'tools/test_trace.py' senza argomento CLI). Un timeout
          diverso da self.timeout è una scelta deliberata del
          chiamante (es. diagnosi manuale con timeout aumentato via
          CLI) e non va toccata: si esce subito, invariato.
        - In assenza di un 'suggested_timeout' valido nella risposta
          del firmware (chiave assente, None o 0 — pacchetti
          MSG_SENT senza questo campo su firmware più vecchi), si usa
          'self.timeout' (config.yaml) — il solo caso in cui il
          valore di configurazione entra in gioco.
        - ATTENZIONE (v. docs/CHANGES_trace_timeout_dinamico_hop.md,
          sezione "Nota sul margine IPC"): rimuovendo il tetto
          massimo, l'attesa reale di trace() può ora superare
          'self.timeout' senza alcun limite legato a config.yaml —
          il margine di timeout lato IPC calcolato da
          TraceEngine.run()/tools/test_trace.py (storicamente
          'self.timeout + 15') deve restare coerente con questo,
          altrimenti il chiamante IPC può abbandonare la richiesta
          mentre il daemon sta ancora aspettando legittimamente.
        - Conversione ms -> s con lo stesso divisore /800 (non
          /1000) già usato in modo identico da tutta la libreria
          meshcore_py per questo stesso campo (commands/binary.py,
          commands/messaging.py) — un margine di sicurezza
          aggiuntivo del 25% voluto dalla libreria client sopra il
          valore già conservativo del firmware, non una conversione
          di unità: si segue la stessa convenzione per coerenza col
          resto del progetto.

        Logging (rivisto 2026-08-23, due volte, entrambe su richiesta
        esplicita dell'utente — v.
        docs/CHANGES_trace_timeout_dinamico_hop.md, "Log fuorviante"
        e il suo follow-up):

        - Prima esisteva un log.info() nel caso d'uso del firmware che
          confrontava esplicitamente il valore con quello del
          fallback ("timeout dal firmware: Xs... usato al posto del
          fallback di config.yaml (Ys)") — rimosso perché, letto
          insieme al log generico del daemon per la richiesta IPC in
          ingresso (che citava anch'esso 'Ys', prima che
          TraceEngine.run() smettesse di inviare quel campo — v.
          engine.py), dava l'impressione fuorviante di due timeout in
          conflitto per lo stesso invio.
        - Rimosso quel confronto, un log.info() è stato reintrodotto
          nel caso d'uso del firmware — ma SENZA alcun confronto con
          config.yaml, solo il valore effettivamente usato: la fonte
          della confusione originale era il confronto stesso (due
          numeri per lo stesso invio), non il fatto di riportare il
          dato. Serve a rendere osservabile il valore reale anche
          quando la trace ha successo (un timeout che scade è già
          osservabile dai timestamp del log, uno che non scade non lo
          è altrimenti — punto sollevato testando un path a 5 hop
          risolto troppo rapidamente per rivelare quale soglia fosse
          davvero in vigore).
        """

        if timeout != self.timeout:
            return timeout

        suggested_timeout_ms = result.payload.get("suggested_timeout")

        if not suggested_timeout_ms:
            log.info(
                "TRACE: %s nessun suggested_timeout dal firmware — uso "
                "il valore di fallback di config.yaml: %ss.",
                tag,
                timeout
            )
            return timeout

        dynamic_timeout = suggested_timeout_ms / 800

        log.info(
            "TRACE: %s timeout: %.1fs (dal firmware, suggested_timeout=%sms).",
            tag,
            dynamic_timeout,
            suggested_timeout_ms
        )

        return dynamic_timeout

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
        # Timeout dal firmware in funzione degli hop realmente
        # attraversati da QUESTO invio, con config.yaml usato solo
        # come fallback in assenza di un valore dal firmware — v.
        # _resolve_timeout(). Fuori dal blocco try/except sopra:
        # quel try/except è mirato specificamente ai fallimenti di
        # send_trace() (report_possible_failure()), non a questa
        # logica puramente locale.
        #
        timeout = self._resolve_timeout(timeout, result, tag)

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
