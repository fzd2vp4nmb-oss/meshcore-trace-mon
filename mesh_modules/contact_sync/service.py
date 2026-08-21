import asyncio

from core.logger import log
from mesh_modules.contact_sync.contact_sync import ContactSyncModule


class ContactSyncService:
    """
    Servizio di sincronizzazione contatti/path verso lo store SQLite
    persistente (docs/CONTACT_MANAGEMENT.md).

    Puramente infrastrutturale, come BotService — non riceve comandi
    via IPC in questa versione. Il frontend leggerà il database
    SQLite direttamente, senza passare da IPC (stesso pattern già in
    uso oggi con trace.json).
    """

    def __init__(self, context):

        self.context = context

        self.contact_sync = ContactSyncModule(
            self.context.engine
        )

        #
        # Il costruttore del servizio non può essere asincrono, ma
        # l'avvio richiede chiamate al device — parte in background.
        #
        # Riferimento mantenuto sull'istanza (code review 2026-08-20,
        # §3.1) — v. mesh_modules/bot/service.py per la motivazione.
        #
        self._start_task = asyncio.create_task(
            self._start()
        )

    async def _start(self):

        try:
            await self.contact_sync.start()

        except Exception:
            log.exception(
                "ContactSyncService: avvio fallito."
            )

    async def execute(self, request):

        return {
            "version": 1,
            "status": "error",
            "message": "ContactSyncService non accetta comandi IPC "
                       "in questa versione"
        }
