import asyncio
import contextlib
import json
import os

from pathlib import Path
from core.config import config
from core.logger import log

#
# Path del socket centralizzato via config (code review 2026-08-20,
# §3.1) — prima era hardcoded e duplicato identico qui e in
# clients/ipc_client.py, mai reso configurabile via 'daemon.socket_path'
# nonostante ARCHITECTURE.md §8 lo desse per previsto. Il default
# resta invariato (nessun impatto su chi non aggiunge la chiave).
#
SOCKET_FILE = Path(
    config.get(
        "daemon.socket_path",
        "run/trace-mon.sock"
    )
)

#
# Tempo massimo di attesa, in stop(), per gli handler già in corso
# (code review 2026-08-20, §3.1) prima di procedere comunque con lo
# shutdown — non deve mai bloccare indefinitamente l'arresto del
# daemon se un handler è appeso (es. dentro command_lock).
#
SHUTDOWN_HANDLERS_TIMEOUT = 30.0

#
# Timeout sulla LETTURA della riga di richiesta iniziale (stress-test
# IPC/eventi, 2026-08-21 — v. ARCHITECTURE.md, "Rafforzamento IPC dopo
# stress-test"). Prima di questo fix, reader.readline() non aveva
# alcun limite: un client che si connette e non scrive nulla (o scrive
# lentissimo, sotto qualunque soglia di attenzione) occupava un
# handler a tempo indefinito. Non sfruttabile da remoto (socket 0600,
# solo lo stesso utente 'meshcore' può connettersi) e non blocca altri
# client IPC (command_lock si acquisisce solo DOPO che questa lettura
# è completata) — ma un handler abbandonato restava comunque in
# _active_handlers, allungando fino a SHUTDOWN_HANDLERS_TIMEOUT ogni
# futuro arresto del daemon per tutto il tempo in cui restava aperto.
# 10s è ampiamente sopra il comportamento di ogni client reale
# (clients/ipc_client.py scrive la richiesta subito dopo l'apertura
# della connessione, senza mai attendere).
#
IPC_READ_TIMEOUT = 10.0

#
# Backstop di ultima istanza sulla durata di UN dispatch (stress-test
# IPC/eventi, 2026-08-21 — v. ARCHITECTURE.md). Prima di questo fix,
# nessun limite di tempo copriva dispatcher.dispatch(): l'unica
# garanzia che una richiesta IPC terminasse prima o poi dipendeva
# interamente dal fatto che OGNI servizio si auto-limitasse
# correttamente — vero oggi (neighbor_monitor delimitato rigorosamente
# dal calcolo di ARCHITECTURE.md §29, gli altri servizi passano tutti
# da comandi meshcore_py già auditati per intero in §32), ma emerso
# dall'auditare ogni servizio uno per uno, non garantito dal
# framework. Senza backstop, un futuro servizio (o una modifica a uno
# esistente) con anche un solo await che in un caso limite non si
# risolve mai bloccherebbe l'intero command_lock — e con esso IPC e
# risposte del bot, project-wide — senza che nulla se ne accorga.
#
# Configurabile (daemon.dispatch_timeout) perché ACCOPPIATO al
# worst-case di neighbor_monitor calcolato in ARCHITECTURE.md §29
# (892s con la configurazione attuale, 0-hop/2-repeater/max_retries=3):
# il default qui sotto deve restare comodamente sopra quel numero, e
# va rivisto insieme a neighbor_monitoring.max_retries/repeaters se
# quei parametri cambiano — i due non erano collegati prima di questo
# fix, lo sono adesso. 1200s (20 minuti) lascia ~300s di margine sopra
# il worst-case oggi documentato.
#
# Verificato (non assunto) che una cancellazione a questo punto sia
# sicura: la cancellazione a metà comando NON lascia lo stato interno
# di meshcore_py corrotto (commands/base.py::send() rilascia sempre le
# proprie subscription in un blocco finally, e il lock interno
# _mesh_request_lock è preso con "async with", quindi sempre
# rilasciato anche su CancelledError — letto il sorgente, non assunto).
# L'unico effetto collaterale reale, verificato anche questo sul
# firmware (v. ARCHITECTURE.md e docs/NEIGHBOR_MONITORING.md): una
# cancellazione a metà di una sessione CLI di neighbor_monitor salta
# l'invio di send_logout() — innocuo, perché send_logout() non genera
# mai traffico radio verso il repeater (comando locale al SOLO
# companion, libera uno slot nella sua tabella connections[] usata per
# un altro scopo, mai popolata dal login/dai comandi CLI che usiamo).
#
DISPATCH_TIMEOUT = config.get(
    "daemon.dispatch_timeout",
    1200.0
)


class _PeerGone(Exception):
    """
    Segnala che il client IPC si è disconnesso (o ha violato il
    protocollo scrivendo byte inattesi dopo la riga di richiesta)
    mentre un dispatch era in corso o in attesa di command_lock — v.
    IPCServer._dispatch_with_watchdog(). Solo uso interno a questo
    modulo, mai propagata al client (non c'è più nessuno a cui
    rispondere).
    """


class IPCServer:
    """
    Server IPC basato su Unix Domain Socket.

    Le richieste vengono processate in sequenza usando il
    command_lock CONDIVISO di Engine — lo stesso lock usato da
    BotModule — perché condividono la stessa connessione MeshCore:
    comandi concorrenti, da qualunque origine, rischierebbero di
    confondere le risposte correlate via expected_ack.
    """

    def __init__(self, dispatcher, engine):
        self.dispatcher = dispatcher
        self.engine = engine
        self.server = None
        self._active_handlers = set()

    async def start(self):
        if SOCKET_FILE.exists():
            SOCKET_FILE.unlink()

        SOCKET_FILE.parent.mkdir(
            parents=True,
            exist_ok=True
        )

        self.server = await asyncio.start_unix_server(
            self._handle_client_tracked,
            path=str(SOCKET_FILE)
        )

        #
        # Permessi ristretti sul socket (code review 2026-08-20,
        # §3.1) — ARCHITECTURE.md §8 richiede "0600 o gruppo
        # dedicato"; prima non veniva mai applicato alcun chmod dopo
        # il bind. 0600: solo il proprietario (utente 'meshcore')
        # può connettersi — coerente con un deployment mono-utente,
        # da rivalutare se il modello di deployment cambierà (es.
        # servizio separato con utente dedicato che debba parlare
        # con l'IPC, nel qual caso servirebbe un gruppo dedicato
        # invece di 0600).
        #
        try:
            os.chmod(
                SOCKET_FILE,
                0o600
            )

        except OSError:
            log.exception(
                "IPC Server: impossibile impostare i permessi "
                "0600 su %s.",
                SOCKET_FILE
            )

        log.info(
            "IPC Server listening on %s",
            SOCKET_FILE
        )

    async def _handle_client_tracked(
        self,
        reader,
        writer
    ):
        #
        # Traccia l'handler corrente perché stop() possa attenderne
        # la terminazione prima di procedere (v. sotto, §3.1).
        #
        task = asyncio.current_task()
        self._active_handlers.add(task)

        try:
            await self.handle_client(
                reader,
                writer
            )

        finally:
            self._active_handlers.discard(task)

    async def stop(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()

        #
        # Prima di questo fix (code review 2026-08-20, §3.1), stop()
        # fermava solo l'accettazione di nuove connessioni senza mai
        # attendere gli handler handle_client() già in corso: durante
        # lo shutdown, un handler a metà (es. bloccato su
        # command_lock, vedi §1.3) poteva non riuscire mai a
        # scrivere la risposta al client in attesa. Attendiamo ora
        # la loro terminazione, con un timeout di sicurezza per non
        # bloccare indefinitamente lo shutdown del daemon.
        #
        if self._active_handlers:

            log.info(
                "IPC Server: in attesa di %d handler in corso "
                "(timeout %ss)...",
                len(self._active_handlers),
                SHUTDOWN_HANDLERS_TIMEOUT
            )

            try:
                await asyncio.wait_for(
                    asyncio.gather(
                        *self._active_handlers,
                        return_exceptions=True
                    ),
                    timeout=SHUTDOWN_HANDLERS_TIMEOUT
                )

            except asyncio.TimeoutError:
                log.warning(
                    "IPC Server: timeout in attesa degli handler "
                    "in corso, procedo comunque con lo shutdown."
                )

        if SOCKET_FILE.exists():
            SOCKET_FILE.unlink()

        log.info(
            "IPC Server stopped."
        )

    async def handle_client(
        self,
        reader,
        writer
    ):

        try:
            raw = await asyncio.wait_for(
                reader.readline(),
                timeout=IPC_READ_TIMEOUT
            )

        except asyncio.TimeoutError:

            log.warning(
                "IPC Server: nessuna richiesta ricevuta entro %ss "
                "dall'apertura della connessione, chiudo.",
                IPC_READ_TIMEOUT
            )

            await self._close_writer(writer)
            return

        except Exception:

            log.exception(
                "IPC error (lettura richiesta)"
            )

            await self._close_writer(writer)
            return

        if not raw:
            await self._close_writer(writer)
            return

        try:
            request = json.loads(
                raw.decode()
            )

        except Exception as e:

            log.exception(
                "IPC error (richiesta non valida)"
            )

            await self._send_error_response(writer, str(e))
            await self._close_writer(writer)
            return

        log.info(
            "IPC Request: %s",
            request
        )

        try:
            #
            # Serializza il dispatch usando il lock CONDIVISO di
            # Engine: le richieste condividono la stessa connessione
            # MeshCore usata anche dal bot, vanno processate una alla
            # volta indipendentemente da chi le origina.
            #
            # acquire_command_lock() invece dell'accesso diretto al
            # lock (Finding 1/5, review affidabilità 2026-08-21 — v.
            # ARCHITECTURE.md §49): logga se l'attesa qui supera una
            # soglia sospetta, indicando chi la sta causando — es. un
            # DM del bot in corso di invio (Finding 1) — così un
            # comando IPC breve che scade lato client per colpa di
            # questa contesa non è più privo di correlazione nei log.
            # L'etichetta usa service.command della richiesta stessa:
            # l'unica cosa distintiva disponibile a questo livello,
            # comune a tutti i chiamanti IPC (trace/advert/system/
            # neighbor_monitor/contact_sync).
            #
            lock_label = (
                f"ipc:{request.get('service', '?')}."
                f"{request.get('command', '?')}"
            )

            async with self.engine.acquire_command_lock(lock_label):
                response = await self._dispatch_with_watchdog(
                    request,
                    reader
                )

        except asyncio.TimeoutError:

            log.error(
                "IPC error: dispatch di %s non concluso entro %ss "
                "(backstop DISPATCH_TIMEOUT), richiesta annullata.",
                request,
                DISPATCH_TIMEOUT
            )

            await self._send_error_response(
                writer,
                f"timeout interno del daemon ({DISPATCH_TIMEOUT}s), "
                "richiesta annullata"
            )

            await self._close_writer(writer)
            return

        except _PeerGone:

            #
            # Il client non c'è più (disconnesso mentre era in coda
            # per command_lock, o durante il dispatch stesso) — non
            # c'è nessuno a cui rispondere, nessun log di errore:
            # comportamento atteso, non un'anomalia.
            #
            log.info(
                "IPC Server: client disconnesso prima del "
                "completamento di %s, richiesta annullata.",
                request
            )

            await self._close_writer(writer)
            return

        except Exception as e:

            log.exception(
                "IPC error"
            )

            await self._send_error_response(writer, str(e))
            await self._close_writer(writer)
            return

        try:
            writer.write(
                (
                    json.dumps(response) + "\n"
                ).encode()
            )

            await writer.drain()

        except Exception:
            log.exception(
                "IPC error (invio risposta)"
            )

        finally:
            await self._close_writer(writer)

    async def _dispatch_with_watchdog(self, request, reader):
        """
        Esegue dispatcher.dispatch(request) sotto due protezioni
        indipendenti, entrambe interne alla gestione di UNA singola
        richiesta (stress-test IPC/eventi, 2026-08-21):

        - un limite di tempo assoluto (DISPATCH_TIMEOUT) — backstop di
          ultima istanza, v. commento sulla costante sopra;
        - un monitor concorrente sulla disconnessione del client: se
          il socket si chiude (o arriva un byte inatteso — il nostro
          protocollo non prevede altro traffico dal client dopo la
          riga di richiesta, quindi qualunque lettura che si risolve
          qui segnala che non ci si può più fidare di questa
          connessione) mentre il dispatch è ancora in corso — incluso
          il caso in cui il client abbandona MENTRE è ancora in coda
          per command_lock, prima ancora che dispatch() inizi
          davvero — annulliamo subito invece di lasciare che consumi
          command_lock per nessuno fino al termine naturale (o fino al
          backstop).

        Le due condizioni sono gestite dallo stesso meccanismo unico
        (asyncio.wait su entrambi i task) invece di un controllo
        separato "prima di iniziare": un client già andato quando
        arriviamo qui fa terminare quasi subito anche il task di
        monitor, quindi il caso "abbandonato in coda" e il caso
        "abbandonato a metà" condividono lo stesso codice.

        Solleva asyncio.TimeoutError se scade DISPATCH_TIMEOUT, oppure
        _PeerGone se il client si disconnette prima del termine.
        Ritorna il risultato di dispatch() in ogni altro caso.
        """

        dispatch_task = asyncio.ensure_future(
            self.dispatcher.dispatch(request)
        )

        disconnect_task = asyncio.ensure_future(
            self._watch_for_disconnect(reader)
        )

        await asyncio.wait(
            {dispatch_task, disconnect_task},
            timeout=DISPATCH_TIMEOUT,
            return_when=asyncio.FIRST_COMPLETED
        )

        #
        # Priorità al dispatch se è comunque arrivato a termine (anche
        # se, sullo stesso giro, il client si è disconnesso proprio
        # subito dopo aver ricevuto tutto quel che gli serviva) — non
        # buttare via un risultato valido già pronto.
        #
        if dispatch_task.done():

            disconnect_task.cancel()

            with contextlib.suppress(asyncio.CancelledError, Exception):
                await disconnect_task

            return dispatch_task.result()

        if disconnect_task.done():

            dispatch_task.cancel()

            with contextlib.suppress(asyncio.CancelledError, Exception):
                await dispatch_task

            raise _PeerGone()

        #
        # Né l'uno né l'altro: è scattato il timeout del backstop.
        #
        dispatch_task.cancel()
        disconnect_task.cancel()

        with contextlib.suppress(asyncio.CancelledError, Exception):
            await dispatch_task

        with contextlib.suppress(asyncio.CancelledError, Exception):
            await disconnect_task

        raise asyncio.TimeoutError()

    async def _watch_for_disconnect(self, reader):
        """
        Si risolve (con qualunque esito: EOF, byte inatteso, o
        un'eccezione di trasporto) appena il client smette di essere
        una controparte affidabile. Richiamata solo da
        _dispatch_with_watchdog(), mai in sovrapposizione con un'altra
        lettura sullo stesso reader (la riga di richiesta è già stata
        letta per intero prima di arrivare qui — un reader asyncio
        supporta una sola lettura pendente alla volta).
        """

        try:
            await reader.read(1)

        except Exception:
            pass

    async def _send_error_response(self, writer, message):

        try:
            response = {
                "version": 1,
                "status": "error",
                "message": message
            }

            writer.write(
                (
                    json.dumps(response) + "\n"
                ).encode()
            )

            await writer.drain()

        except Exception:
            pass

    async def _close_writer(self, writer):

        try:
            writer.close()
            await writer.wait_closed()

        except Exception:
            pass
