from mesh_modules.bot.commands.base import BotCommand


class InfoCommand(BotCommand):
    """
    !info — risponde con l'elenco dei nomi dei comandi disponibili
    (con prefisso '!'), letto dinamicamente da
    mesh_modules/bot/commands/registry.py — nessuna lista hardcoded
    da tenere sincronizzata a mano.

    Import di COMMANDS fatto dentro handle() (non a livello di
    modulo) perché registry.py importa questo file per registrare il
    comando — un import a livello di modulo qui creerebbe un import
    circolare.
    """

    name = "info"

    async def handle(self, ctx):

        from mesh_modules.bot.commands.registry import COMMANDS

        names = sorted(f"!{n}" for n in COMMANDS.keys())

        budget = max(ctx.reply_budget - len("Commands:"), 0)

        shown = []
        total = 0

        for i, n in enumerate(names):

            sep_len = 1 if shown else 0
            remaining_after = len(names) - (i + 1)
            suffix_len = len(f" +{remaining_after}") if remaining_after > 0 else 0

            if total + sep_len + len(n) + suffix_len > budget:
                break

            shown.append(n)
            total += sep_len + len(n)

        omitted = len(names) - len(shown)

        result = " ".join(shown) if shown else "…"

        if omitted > 0:
            result += f" +{omitted}"

        return f"Comandi disponibili:{result}"
