from core.logger import log
from mesh_modules.neighbor_monitor.neighbor_monitor import NeighborMonitorModule


class NeighborMonitorService:
    """
    Servizio NEIGHBOR_MONITOR.
    Espone NeighborMonitorModule tramite IPC.
    """

    def __init__(
        self,
        context
    ):

        self.context = context
        self.monitor = NeighborMonitorModule(
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

        repeater_name = request.get(
            "repeater_name"
        )

        if not repeater_name:
            return {
                "version": 1,
                "status": "error",
                "message": "missing repeater_name"
            }

        log.info(
            "NeighborMonitorService: %s",
            repeater_name
        )

        result = await self.monitor.query(
            repeater_name
        )

        if result is None:
            return {
                "version": 1,
                "status": "error",
                "message": (
                    "no response from repeater (timeout, "
                    "unreachable, or ACL permission not granted)"
                )
            }

        return {
            "version": 1,
            "status": "ok",
            "result": result
        }
