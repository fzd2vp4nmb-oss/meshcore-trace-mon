from mesh_modules.bot.commands.base import BotCommand


def split_path_hops(path_hex, path_len):

    if not path_hex or not path_len:
        return []

    chunk_size = len(path_hex) // path_len

    return [
        path_hex[i:i + chunk_size]
        for i in range(0, len(path_hex), chunk_size)
    ]


def format_path(path_hex, path_len, max_chars=None):
    """
    Formatta il path come elenco di hop separati da ','.

    path_len is None -> instradamento non ancora noto (tipico dei DM
    prima che il path venga appreso, out_path_len == 255).
    path_len == 0 (o path_hex vuoto) -> diretto, 0 hop.
    Altrimenti -> elenco hop, troncato sui confini (mai un hash
    tagliato a metà) se max_chars è specificato.
    """

    if path_len is None:
        return "FLOOD (instradamento non ancora noto)"

    hops = split_path_hops(path_hex, path_len)

    if not hops:
        return "DIRECT (0 hop)"

    if max_chars is None:
        return ",".join(hops)

    shown = []
    total = 0

    for i, hop in enumerate(hops):

        sep_len = 1 if shown else 0
        remaining_after = len(hops) - (i + 1)
        suffix_len = len(f" +{remaining_after}") if remaining_after > 0 else 0

        if total + sep_len + len(hop) + suffix_len > max_chars:
            break

        shown.append(hop)
        total += sep_len + len(hop)

    omitted = len(hops) - len(shown)

    result = ",".join(shown) if shown else "…"

    if omitted > 0:
        result += f" +{omitted}"

    return result


class PathCommand(BotCommand):
    """
    !path — risponde con il path (elenco hop) con cui è arrivato il
    messaggio sul canale, o con il path attualmente noto per
    raggiungere il contatto, per i DM (contact['out_path']).
    """

    name = "path"

    async def handle(self, ctx):

        budget = max(ctx.reply_budget - len("Path:"), 0)

        path_str = format_path(ctx.path_hex, ctx.path_len, max_chars=budget)

        return f"Path:{path_str}"
