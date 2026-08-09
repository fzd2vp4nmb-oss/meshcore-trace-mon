import asyncio
import json

from pathlib import Path
from core.logger import log

SOCKET_FILE = Path("run/trace-mon.sock")

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

    async def start(self):
        if SOCKET_FILE.exists():
            SOCKET_FILE.unlink()

        SOCKET_FILE.parent.mkdir(
            parents=True,
            exist_ok=True
        )

        self.server = await asyncio.start_unix_server(
            self.handle_client,
            path=str(SOCKET_FILE)
        )

        log.info(
            "IPC Server listening on %s",
            SOCKET_FILE
        )

    async def stop(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()

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
