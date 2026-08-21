"""
core/trace_paths.py

Parsing condiviso del formato di trace.paths in config.yaml — usato
sia da mesh_modules/trace/engine.py (esecuzione) sia da
tools/edit_config.py (modifica via config.sh). Un'unica implementazione
per evitare che le due derivino nel tempo verso interpretazioni
diverse dello stesso formato.

Formato di una entry:
    "aaaa,bbbb,aaaa"        — path abilitato (nessun suffisso: il
                               comportamento implicito è abilitato,
                               per retrocompatibilità con config.yaml
                               scritti prima di questa funzionalità)
    "aaaa,bbbb,aaaa,true"   — path abilitato, esplicito
    "aaaa,bbbb,aaaa,false"  — path disabilitato

Indipendente dal numero di byte usati per i singoli prefissi (1/2/3
byte) — il parsing guarda solo se l'ULTIMO segmento separato da
virgola è letteralmente "true" o "false", qualunque cosa lo precede
resta il path così com'è.
"""


def parse_path_entry(entry):
    """
    Ritorna (path, enabled) da una entry grezza di trace.paths.
    """

    #
    # Validazione (code review 2026-08-20, §4) — trace.paths viene
    # scritto a mano in config.yaml (oltre che da edit_config.py), e
    # un errore di battitura (entry non stringa per un YAML non
    # quotato interpretato come numero/bool, o una entry vuota/solo
    # virgole) prima produceva un AttributeError/IndexError grezzo
    # più a valle, in TraceEngine.run(), invece di un messaggio
    # chiaro nel punto in cui il dato viene letto.
    #
    if not isinstance(entry, str):
        raise ValueError(
            f"trace.paths: entry non valida (atteso una stringa, "
            f"ricevuto {type(entry).__name__}: {entry!r}) — controlla "
            f"che ogni voce in config.yaml sia tra virgolette."
        )

    if not entry.strip():
        raise ValueError(
            "trace.paths: trovata una entry vuota — rimuovila da "
            "config.yaml."
        )

    parts = entry.split(",")

    last = parts[-1].strip().lower()

    if last in ("true", "false"):
        path = ",".join(parts[:-1])
        enabled = (last == "true")

    else:
        path = entry
        enabled = True

    if not path.strip():
        raise ValueError(
            f"trace.paths: entry {entry!r} non contiene un path "
            f"valido (solo il suffisso true/false)."
        )

    return path, enabled


def format_path_entry(path, enabled):
    """
    Ricostruisce una entry da path + stato — sempre in forma
    esplicita (mai omette il suffisso), anche per enabled=True: una
    volta che una entry è stata toccata da questo strumento, meglio
    che resti esplicita piuttosto che tornare al formato implicito
    e generare ambiguità con path scritti a mano.
    """

    return f"{path},{'true' if enabled else 'false'}"
