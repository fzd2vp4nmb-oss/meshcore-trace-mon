class BotCommand:
    """
    Interfaccia comune per i comandi del bot.

    `name` è la stringa dopo il prefisso '!' (es. "path" per "!path").

    `handle()` riceve il contesto del messaggio e ritorna il TESTO DEL
    CONTENUTO della risposta — senza prefisso "@[nome] ", di cui si
    occupa BotModule allo stesso modo per tutti i comandi. Il budget
    di caratteri disponibile (ctx.reply_budget) è già al netto di
    quel prefisso: ogni comando gestisce da sé come troncare/formattare
    il proprio contenuto entro quel budget.
    """

    name = None

    async def handle(self, ctx):
        raise NotImplementedError
