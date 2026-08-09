import asyncio
import json
from pathlib import Path

SOCKET_FILE = Path("run/trace-mon.sock")

class IPCClient:
    async def request(
        self,
        service,
        command,
        **kwargs
    ):

        reader, writer = await asyncio.open_unix_connection(
            str(SOCKET_FILE)
        )

        request = {
            "version": 1,
            "service": service,
            "command": command
        }

        request.update(kwargs)

        writer.write(
            (
                json.dumps(request) + "\n"
            ).encode()
        )

        await writer.drain()
        raw = await reader.readline()
        writer.close()
        await writer.wait_closed()

        return json.loads(
            raw.decode()
        )
