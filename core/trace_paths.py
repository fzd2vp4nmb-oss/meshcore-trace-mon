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

    parts = entry.split(",")

    last = parts[-1].strip().lower()

    if last in ("true", "false"):
        return ",".join(parts[:-1]), (last == "true")

    return entry, True


def format_path_entry(path, enabled):
    """
    Ricostruisce una entry da path + stato — sempre in forma
    esplicita (mai omette il suffisso), anche per enabled=True: una
    volta che una entry è stata toccata da questo strumento, meglio
    che resti esplicita piuttosto che tornare al formato implicito
    e generare ambiguità con path scritti a mano.
    """

    return f"{path},{'true' if enabled else 'false'}"
