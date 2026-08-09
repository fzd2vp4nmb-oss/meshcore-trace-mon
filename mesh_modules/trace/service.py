from core.logger import log
from mesh_modules.trace.trace import TraceModule

class TraceService:
    """
    Servizio TRACE.
    Espone il modulo Trace tramite IPC.
    """

    def __init__(
        self,
        context
    ):

        self.context = context
        self.trace = TraceModule(
            self.context.engine
        )

    async def execute(
        self,
        request
    ):

        command = request.get(
            "command"
        )

        if command != "run":
            return {
                "version": 1,
                "status": "error",
                "message": f"unknown command '{command}'"
            }

        path = request.get(
            "path"
        )

        if not path:
            return {
                "version": 1,
                "status": "error",
                "message": "missing path"
            }

        timeout = request.get(
            "timeout"
        )

        log.info(
            "TraceService: %s",
            path
        )

        payload = await self.trace.trace(
            path=path,
            timeout=timeout
        )

        if payload is None:
            return {
                "version": 1,
                "status": "error",
                "message": "timeout waiting trace"
            }

        return {
            "version": 1,
            "status": "ok",
            "result": payload
        }
