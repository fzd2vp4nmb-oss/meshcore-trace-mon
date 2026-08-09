from mesh_modules.bot.commands.base import BotCommand


class PingCommand(BotCommand):
    """
    !ping — risponde "pong" con RSSI e SNR rilevati alla ricezione
    del messaggio. RSSI può risultare None sui DM, dove non sempre è
    esposto dall'evento.
    """

    name = "ping"

    async def handle(self, ctx):

        return f"pong RSSI:{ctx.rssi} SNR:{ctx.snr}"
