from mesh_modules.bot.commands.base import BotCommand


def split_path_hops(path_hex, path_len):

    if not path_hex or not path_len:
        return []

    chunk_size = len(path_hex) // path_len

    #
    # path_len (hop count) dichiarato più alto di quanti "byte" siano
    # davvero presenti in path_hex produce chunk_size=0 (code review
    # Rev.6, trovato ESEGUENDO un test mirato, non dalla sola lettura:
    # con chunk_size=0 il range() sottostante solleva
    # "ValueError: range() arg 3 must not be zero" — un crash secco,
    # non un valore sbagliato). path_len e path_hex arrivano da due
    # campi INDIPENDENTI del payload radio (out_path_len/out_path o
    # path_len/path di RX_LOG_DATA, v. contact_sync.py) senza alcuna
    # verifica incrociata a monte — un dato radio incoerente (o
    # out_path_len che eccede la capacità reale di out_path, 64 byte
    # fissi lato firmware per ContactInfo, v. FIRMWARE_ANALYSIS.md
    # §10) è quindi raggiungibile, non solo teorico. Nessuna
    # spiegazione di design trovata per questo comportamento: è un
    # difetto, non una scelta. Fallback: l'intera stringa come un
    # unico "hop" grezzo — mantiene un'informazione mostrabile
    # all'utente invece di far fallire l'intero comando (!path) o,
    # lato frontend JS (stesso bug gemello in app.js
    # splitAdvertPathHops, corretto in coppia), di bloccare la pagina.
    #
    if chunk_size < 1:
        return [path_hex]

    return [
        path_hex[i:i + chunk_size]
        for i in range(0, len(path_hex), chunk_size)
    ]


def format_path(path_hex, path_len, max_chars=None):
    """
    Formatta il path come elenco di hop separati da ','.

    path_len is None -> instradamento non ancora noto (tipico dei DM
    prima che il path venga appreso, out_path_len 255 O -1 — v.
    UNKNOWN_OUT_PATH_VALUES in bot.py, Finding 3 code review
    2026-08-20).
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
