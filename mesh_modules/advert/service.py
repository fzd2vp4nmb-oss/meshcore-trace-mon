from meshcore.events import EventType
from core.logger import log

from mesh_modules.advert.advert import AdvertModule

class AdvertService:
    """
    Servizio Advert.

    Espone tramite IPC le funzionalità di AdvertModule.

    Comandi disponibili:

        advert
        floodadv
    """

    def __init__(
        self,
        context
    ):

        self.context = context
        self.advert = AdvertModule(
            self.context.engine
        )

    async def execute(
        self,
        request
    ):

        command = request.get(
            "command"
        )

        #
        # Advert 0-hop
        #
        if command == "advert":
            log.info(
                "AdvertService: advert"
            )

            event = await self.advert.advert()

        #
        # Flood Advert
        #
        elif command == "floodadv":
            log.info(
                "AdvertService: floodadv"
            )

            event = await self.advert.floodadv()

        #
        # Comando sconosciuto
        #
        else:

            return {
                "version": 1,
                "status": "error",
                "message": f"unknown command '{command}'"
            }

        #
        # Connessione non attiva: invio annullato a monte
        #
        if event is None:
            return {
                "version": 1,
                "status": "error",
                "message": "connessione al device non attiva"
            }

        #
        # Gestione risultato
        #
        if event.type == EventType.ERROR:
            return {
                "version": 1,
                "status": "error",
                "message": str(event)
            }

        #
        # Successo
        #
        return {
            "version": 1,
            "status": "ok"
        }
