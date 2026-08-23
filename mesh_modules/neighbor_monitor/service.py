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

        #
        # public_key/adv_name (opzionali, 2026-08-23): quando il
        # chiamante (NeighborMonitorEngine) li fornisce già risolti —
        # avendo appena interrogato system.contact per calcolare l'hop
        # count reale del margine di timeout IPC — passati direttamente
        # a NeighborMonitorModule.query(), che salta così un secondo
        # get_contacts() locale ridondante per lo stesso contatto (v.
        # NeighborMonitorModule.query(), docstring). Assenti per
        # qualunque altro chiamante: comportamento invariato, query()
        # risolve da sola come sempre.
        #
        result = await self.monitor.query(
            repeater_name,
            public_key=request.get("public_key"),
            adv_name=request.get("adv_name")
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
