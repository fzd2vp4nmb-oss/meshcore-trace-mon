from meshcore.events import EventType

from core.logger import log
from mesh_modules.bot.commands.base import BotCommand


#
# Stessa scelta di meteo.py: un'unica risposta generica per
# qualsiasi errore, nessun dettaglio tecnico esposto sul canale/DM.
#
FALLBACK_MESSAGE = "Informazioni non trovate"


class StatusCommand(BotCommand):
    """
    !status — risponde con tensione batteria e memoria libera del
    device, letti in tempo reale via get_bat() — comando locale al
    companion (non passa dal link radio), sicuro da interrogare a
    ogni invocazione.

    Payload confermato EMPIRICAMENTE sul device
    (experiments/exp07_get_bat.py, 2026-08-08):
        {'level': 4279, 'used_kb': 215, 'total_kb': 1404}
    'level' è la tensione batteria in MILLIVOLT nonostante il nome
    (NON una percentuale — valore osservato 4279 = 4.28V, plausibile
    per una LiPo carica) — non dedotto dalla documentazione del
    companion protocol, solo confermata da questa a coincidere in
    generale ("battery voltage and storage usage"), il significato
    esatto dei singoli campi viene dal test reale.

    get_bat() tocca il device sulla connessione condivisa (query
    locale, non radio) — per coerenza con l'architettura a
    connessione esclusiva, va comunque serializzato con
    Engine.command_lock come ogni altro comando sulla connessione.
    Unica differenza rispetto a !path/!ping/!info, che leggono solo
    dati già presenti in ctx senza interrogare il device.
    """

    name = "status"

    async def handle(self, ctx):

        if not ctx.engine.connected:
            return FALLBACK_MESSAGE

        try:
            async with ctx.engine.command_lock:
                result = await ctx.engine.mesh.commands.get_bat()

            if result.type == EventType.ERROR:
                log.warning(
                    "StatusCommand: get_bat() ha risposto ERROR: %r",
                    result.payload
                )
                return FALLBACK_MESSAGE

            payload = result.payload

            millivolts = payload["level"]
            used_kb = payload["used_kb"]
            total_kb = payload["total_kb"]

        except Exception:
            log.warning(
                "StatusCommand: get_bat() fallito.",
                exc_info=True
            )
            return FALLBACK_MESSAGE

        volts = millivolts / 1000
        free_kb = total_kb - used_kb

        return f"Status: batt {volts:.2f}V mem {free_kb}/{total_kb}KB libera"
