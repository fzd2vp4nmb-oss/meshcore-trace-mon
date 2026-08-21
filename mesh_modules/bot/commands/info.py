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

    #
    # Finding 5, code review 2026-08-20: il budget veniva calcolato
    # sottraendo len("Commands:") (9 caratteri, un residuo inglese mai
    # emesso), mentre il prefisso REALMENTE anteposto nel return sotto
    # era "Comandi disponibili:" (20 caratteri) -- uno scarto di 11
    # caratteri tra calcolo interno e output reale. Effetto pratico
    # mitigato da _truncate_utf8_safe() a valle (bot.py), ma il
    # contatore "+N comandi omessi" calcolato qui poteva risultare
    # disallineato rispetto a quanto davvero visibile dopo quel taglio
    # esterno, in scenari con reply_budget stretto. Fix: un'unica
    # costante usata sia per il calcolo del budget sia per il return,
    # cosi le due cose non possono più divergere (stesso principio già
    # in uso, per costruzione, in PathCommand -- "Path:" lì compare
    # identico nei due punti, anche se non fattorizzato in una
    # costante dedicata).
    #
    PREFIX = "Comandi disponibili:"

    async def handle(self, ctx):

        from mesh_modules.bot.commands.registry import COMMANDS

        names = sorted(f"!{n}" for n in COMMANDS.keys())

        budget = max(ctx.reply_budget - len(self.PREFIX), 0)

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

        return f"{self.PREFIX}{result}"
