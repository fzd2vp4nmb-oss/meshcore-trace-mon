import asyncio
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
            raw = await reader.readline()

            if not raw:
                return

            request = json.loads(
                raw.decode()
            )

            log.info(
                "IPC Request: %s",
                request
            )

            #
            # Serializza il dispatch usando il lock CONDIVISO di
            # Engine: le richieste condividono la stessa connessione
            # MeshCore usata anche dal bot, vanno processate una alla
            # volta indipendentemente da chi le origina.
            #
            async with self.engine.command_lock:
                response = await self.dispatcher.dispatch(
                    request
                )

            writer.write(
                (
                    json.dumps(response) + "\n"
                ).encode()
            )

            await writer.drain()

        except Exception as e:
            log.exception(
                "IPC error"
            )

            try:
                response = {
                    "version": 1,
                    "status": "error",
                    "message": str(e)
                }

                writer.write(
                    (
                        json.dumps(response) + "\n"
                    ).encode()
                )

                await writer.drain()

            except Exception:
                pass

        finally:

            try:
                writer.close()
                await writer.wait_closed()

            except Exception:
                pass
