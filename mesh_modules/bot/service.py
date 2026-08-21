import asyncio

from core.logger import log
from mesh_modules.bot.bot import BotModule


class BotService:
    """
    Servizio BOT.

    A differenza di trace/advert/system, non riceve comandi via IPC
    in questa versione: è puramente event-driven, ascolta e risponde
    autonomamente sul canale configurato. execute() è implementato
    solo per compatibilità con l'interfaccia comune dei servizi.
    """

    def __init__(
        self,
        context
    ):

        self.context = context
        self.bot = BotModule(
            self.context.engine
        )

        #
        # Il costruttore del servizio non può essere asincrono, ma la
        # risoluzione del canale richiede una chiamata al device —
        # il setup vero e proprio parte in background.
        #
        # Riferimento mantenuto sull'istanza (code review 2026-08-20,
        # §3.1) — un task senza riferimenti può essere garbage
        # collected in modo imprevedibile prima del completamento
        # (sconsigliato esplicitamente dalla documentazione asyncio).
        #
        self._start_task = asyncio.create_task(
            self._start()
        )

    async def _start(self):

        try:
            await self.bot.start()

        except Exception:
            log.exception(
                "BotService: avvio fallito."
            )

    async def execute(
        self,
        request
    ):

        return {
            "version": 1,
            "status": "error",
            "message": "BotService non accetta comandi IPC in questa versione"
        }
