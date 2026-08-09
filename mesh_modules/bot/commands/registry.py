from mesh_modules.bot.commands.info import InfoCommand
from mesh_modules.bot.commands.meteo import MeteoCommand
from mesh_modules.bot.commands.path import PathCommand
from mesh_modules.bot.commands.ping import PingCommand
from mesh_modules.bot.commands.status import StatusCommand

#
# Un comando nuovo = un file nuovo in mesh_modules/bot/commands/ + una
# riga qui sotto. Nessun altro file va toccato.
#
COMMANDS = {
    cmd.name: cmd
    for cmd in [
        InfoCommand(),
        MeteoCommand(),
        PathCommand(),
        PingCommand(),
        StatusCommand(),
    ]
}
