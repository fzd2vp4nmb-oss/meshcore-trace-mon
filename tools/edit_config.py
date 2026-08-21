#!/home/meshcore/trace-mon/.venv/bin/python3

"""
tools/edit_config.py

Motore di modifica per config/config.yaml, usato da config.sh
(l'interfaccia a menu interattiva) — non pensato per essere invocato
direttamente dall'utente, un comando per ogni operazione atomica.

A differenza di setup.sh (che GENERA config.yaml da zero, sostituzione
testuale su config/config.yaml.template), qui si MODIFICA un file che
potrebbe già essere stato toccato a mano nel frattempo — serve un
parser YAML vero (PyYAML), non sostituzione testuale.

(Nota storica, corretta il 2026-08-21, docs/ARCHITECTURE.md §45: questo
docstring citava in precedenza "setup.sh/generate_config.py" e un
template "config.yaml.example" — nessuno dei due è mai esistito
nell'albero, probabilmente riferimenti a un'architettura precedente mai
realizzata. Da questa sessione config/config.yaml.template esiste
davvero, letto sia da setup.sh sia dal comando `align` più sotto — lo
stesso file, non due copie separate.)

Conseguenza nota: PyYAML non preserva i commenti alla riserializzazione.
Le spiegazioni che nel template (config/config.yaml.template) stanno
accanto a ciascun parametro qui sono raccolte in un unico blocco fisso
(HEADER_COMMENT) scritto in cima al file ad ogni salvataggio — non
per parametro, ma un riferimento centrale valido per l'intero file.

Sicurezza built-in, per ogni comando che scrive:
1. backup con timestamp di config.yaml prima di toccarlo
2. modifica in memoria
3. scrittura su disco
4. validazione: rilettura del file appena scritto
5. se la validazione fallisce, ripristino automatico dal backup
   appena creato — non lascia mai un config.yaml rotto sul disco
"""

import argparse
import os
import stat
import sys
import shutil
from datetime import datetime
from pathlib import Path

#
# Root del progetto
#
PROJECT_ROOT = Path(__file__).resolve().parent.parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from bootstrap import bootstrap
bootstrap()

import yaml

from core.trace_paths import parse_path_entry, format_path_entry


CONFIG_PATH = Path("config/config.yaml")

BACKUP_DIR = Path("config/backup")

#
# Fonte dei valori di default per il comando `align` (v. cmd_align()
# sotto) — lo stesso file che setup.sh usa per generare config.yaml da
# zero (docs/ARCHITECTURE.md §45). Un file mancante non è un errore
# fatale per gli altri comandi (get/set/ecc. non ne hanno bisogno),
# solo per `align` stesso.
#
TEMPLATE_PATH = Path("config/config.yaml.template")

#
# Path che nel template compaiono come placeholder __TOKEN__
# (connection.tcp.host, ecc.) — istanza-specifici, mai popolabili con
# un valore sensato dal template. In pratica `align` non li propone
# mai comunque (walk_template_scalars() salta ogni chiave dentro una
# lista, e queste sono tutte già popolate da setup.sh al momento della
# generazione), ma l'elenco esplicito resta come rete di sicurezza
# leggibile: se uno di questi risultasse davvero assente, è un segnale
# di un config.yaml anomalo da sistemare a mano (o con setup.sh), non
# qualcosa che `align` deve riempire da solo con un placeholder.
#
INSTANCE_SPECIFIC_PATHS = frozenset({
    "connection.tcp.host",
    "connection.tcp.port",
    "connection.serial.device",
    "connection.serial.baudrate",
    "connection.ble.address",
})

#
# Permessi ristretti su config.yaml e sui suoi backup (code review
# 2026-08-20, §3.7) — non contengono segreti veri, ma includono
# hostname/indirizzi interni della rete (connection.tcp.host, IP del
# Collettore nei backup meno recenti se mai stato lì, ecc.). 0600:
# solo il proprietario (utente 'meshcore') può leggerli.
#
CONFIG_FILE_MODE = stat.S_IRUSR | stat.S_IWUSR  # 0600

#
# Retention dei backup in config/backup/ (code review 2026-08-20,
# §3.7) — prima nessuna pulizia periodica: ogni salvataggio da
# config.sh aggiunge un file, mai rimosso, con accumulo silenzioso nel
# tempo (40+ osservati). Mantiene solo gli N backup più recenti dopo
# ogni salvataggio riuscito — non tocca il backup appena creato per
# QUESTA operazione (sempre il più recente, quindi mai tra quelli
# rimossi da questa stessa potatura).
#
MAX_CONFIG_BACKUPS = 20


def _restrict_permissions(path):
    """Applica CONFIG_FILE_MODE (0600) a path — errori non fatali
    (es. filesystem che non supporta i permessi POSIX), solo
    un avviso: non deve impedire il salvataggio della config."""

    try:
        path.chmod(CONFIG_FILE_MODE)

    except OSError as e:
        print(
            f"AVVISO: impossibile impostare permessi 0600 su {path}: {e}",
            file=sys.stderr
        )


def _prune_old_backups():
    """Mantiene solo i MAX_CONFIG_BACKUPS backup più recenti in
    BACKUP_DIR (code review 2026-08-20, §3.7). Fallimenti su un
    singolo file (permessi, race con un altro processo) non
    interrompono la potatura degli altri."""

    if not BACKUP_DIR.is_dir():
        return

    backups = sorted(
        BACKUP_DIR.glob("config.yaml.*.bak"),
        key=lambda p: p.name,
        reverse=True
    )

    for stale in backups[MAX_CONFIG_BACKUPS:]:

        try:
            stale.unlink()

        except OSError as e:
            print(
                f"AVVISO: impossibile rimuovere il vecchio backup "
                f"{stale}: {e}",
                file=sys.stderr
            )

VALID_SERVICES = [
    "system", "trace", "advert", "bot", "contact_sync", "neighbor_monitor"
]

#
# Suffissi di path che vanno convertiti a intero prima di scrivere.
# ".interval" copre sia trace.interval sia neighbor_monitoring.interval
# (stesso trattamento numerico, soglie minime diverse — vedi MIN_VALUES
# sotto, indicizzato sul path ESATTO non sul suffisso).
#
NUMERIC_SUFFIXES = (
    ".port", ".baudrate", ".max_retries", ".sync_interval",
    ".interval", ".timeout"
)

#
# Soglie minime per specifici path numerici. trace.interval/timeout
# toccano timing radio su una rete condivisa — un valore troppo basso
# (es. 0) impatta traffico reale sulla mesh, non solo il Nodo locale.
# contacts.sync_interval è comunicazione locale col device (nessun
# impatto radio) ma un valore troppo basso moltiplica inutilmente le
# scritture su contacts.db.
#
MIN_VALUES = {
    "neighbor_monitoring.max_retries": 1,
    "neighbor_monitoring.interval": 1,
    "trace.interval": 10,
    "trace.timeout": 10,
    "contacts.sync_interval": 60,
}

VALID_LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")

HEADER_COMMENT = """\
# =====================================================================
# config.yaml — MeshCore trace-mon
#
# Generato/modificato da setup.sh o config.sh — la modifica manuale
# resta possibile, ma qualunque commento aggiunto qui sotto verrà
# perso al prossimo salvataggio da config.sh (limite del parser YAML
# usato per le modifiche sicure). Questo blocco in testa riassume il
# significato dei parametri, al posto dei commenti che altrimenti
# starebbero accanto a ciascuno.
#
# connection:
#   type — tcp, serial o ble. Solo il blocco corrispondente al tipo
#     scelto viene letto, gli altri due restano ignorati.
#   heartbeat_interval — secondi tra un health-check attivo e l'altro
#   heartbeat_timeout — timeout del singolo controllo di verifica
#   serial.baudrate — 115200 è il default proposto da setup.sh, non
#     un vincolo: cambialo solo se il tuo device seriale richiede un
#     valore diverso.
#
# trace:
#   paths — elenco di path da tracciare, uno per riga, formato
#     "aaaa,bbbb,aaaa" (prefissi esadecimali separati da virgola).
#     Un suffisso ,true/,false abilita o disabilita il path senza
#     rimuoverlo — nessun suffisso equivale a ,true.
#   interval — secondi di attesa tra un path e il successivo nello
#     stesso giro (minimo 10)
#   timeout — secondi di attesa di una risposta TRACE_DATA prima di
#     considerare il path fallito (minimo 10)
#
# logging:
#   level — DEBUG, INFO, WARNING o ERROR
#
# contacts:
#   sync_interval — secondi tra un sync completo del device
#     (get_contacts()) e il successivo (minimo 60) — comunicazione
#     locale col companion, non genera traffico radio, ma più
#     scritture su contacts.db
#
# bot:
#   known_regions — regioni note al bot per la risoluzione flood-scope
#
# neighbor_monitoring:
#   interval — secondi di attesa tra un repeater e il successivo, se
#     più di uno configurato
#   repeaters — elenco dei repeater da interrogare (tab Repeaters)
#   max_retries — tentativi totali per singola interrogazione radio
#     (status/neighbours/telemetry/region/login/comandi CLI) prima di
#     rinunciare e passare alla successiva. 1 = nessun retry.
#
# services:
#   Ciascun servizio del daemon può essere disattivato singolarmente
#   con enabled: false, senza toccare gli altri.
# =====================================================================

"""


def load_config():

    if not CONFIG_PATH.exists():
        print(f"ERRORE: {CONFIG_PATH} non trovato.", file=sys.stderr)
        sys.exit(1)

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def backup_config():

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    backup_path = BACKUP_DIR / f"config.yaml.{timestamp}.bak"

    #
    # copy2 preserva anche i permessi del sorgente — se CONFIG_PATH è
    # già 0600 (v. CONFIG_FILE_MODE, applicato da save_config() sotto
    # a ogni salvataggio), il backup eredita automaticamente lo stesso
    # permesso. _restrict_permissions() qui è comunque una seconda
    # rete di sicurezza esplicita, per un'installazione dove
    # config.yaml avesse ancora permessi più larghi da prima di questo
    # fix (code review 2026-08-20, §3.7).
    #
    shutil.copy2(CONFIG_PATH, backup_path)
    _restrict_permissions(backup_path)

    return backup_path


def save_config(data, backup_path):
    """
    Scrive in un file temporaneo nella stessa directory, lo rilegge
    per validare, e solo se valido lo rinomina atomicamente al posto
    di CONFIG_PATH (os.replace, atomico sullo stesso filesystem) —
    mai un config.yaml rotto o troncato sul disco, nemmeno per un
    istante, neanche in caso di crash A METÀ della scrittura stessa.

    Prima di questo fix (code review 2026-08-20, §3.8), la scrittura
    avveniva direttamente su CONFIG_PATH: la rilettura/ripristino
    successivi presumevano che la scrittura fosse già andata a buon
    fine, e non coprivano un crash proprio durante la scrittura (un
    file troncato che impedisce il riavvio del daemon) — in
    contraddizione con l'intento dichiarato nel docstring del modulo.
    Con l'approccio atomico, se la validazione fallisce CONFIG_PATH
    non è mai stato toccato: il ripristino dal backup non serve più,
    basta scartare il file temporaneo.
    """

    tmp_path = CONFIG_PATH.with_name(CONFIG_PATH.name + ".tmp")

    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(HEADER_COMMENT)
        yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False,
                        allow_unicode=True)
        f.flush()
        os.fsync(f.fileno())

    try:
        with open(tmp_path, "r", encoding="utf-8") as f:
            yaml.safe_load(f)

    except yaml.YAMLError as e:

        print(
            f"ERRORE: il file scritto non è YAML valido ({e}). "
            f"Nessuna modifica applicata a {CONFIG_PATH} (backup "
            f"comunque disponibile: {backup_path}).",
            file=sys.stderr
        )

        tmp_path.unlink(missing_ok=True)

        sys.exit(1)

    #
    # v. CONFIG_FILE_MODE (code review 2026-08-20, §3.7).
    #
    _restrict_permissions(tmp_path)

    os.replace(tmp_path, CONFIG_PATH)

    print(f"config.yaml aggiornato (backup: {backup_path})")

    _prune_old_backups()


def get_path(data, dotted_path):

    node = data

    for key in dotted_path.split("."):

        if not isinstance(node, dict) or key not in node:
            return None

        node = node[key]

    return node


def set_path(data, dotted_path, value):

    keys = dotted_path.split(".")
    node = data

    for key in keys[:-1]:

        if key not in node or not isinstance(node[key], dict):
            node[key] = {}

        node = node[key]

    node[keys[-1]] = value


def parse_bool(s):

    if s.lower() in ("true", "1", "yes", "si", "sì"):
        return True

    if s.lower() in ("false", "0", "no"):
        return False

    print(f"ERRORE: valore booleano non valido: '{s}'", file=sys.stderr)
    sys.exit(1)


def parse_log_level(s):

    normalized = s.strip().upper()

    if normalized not in VALID_LOG_LEVELS:

        print(
            f"ERRORE: livello di log non valido: '{s}' "
            f"(validi: {', '.join(VALID_LOG_LEVELS)}).",
            file=sys.stderr
        )

        sys.exit(1)

    return normalized


def cmd_get(args):

    data = load_config()
    value = get_path(data, args.path)

    if value is None:
        print("")
    else:
        print(value)


def cmd_set(args):

    data = load_config()

    value = args.value

    #
    # I campi 'enabled' sono sempre booleani — conversione automatica
    # in base al nome dell'ultimo segmento del path, non serve un
    # flag separato per dire "questo è un booleano".
    #
    if args.path.endswith(".enabled") or args.path == "enabled":
        value = parse_bool(value)

    elif args.path == "logging.level":
        value = parse_log_level(value)

    elif args.path.endswith(NUMERIC_SUFFIXES):

        try:
            value = int(value)

        except ValueError:
            print(f"ERRORE: valore numerico non valido: '{value}'", file=sys.stderr)
            sys.exit(1)

        minimum = MIN_VALUES.get(args.path)

        if minimum is not None and value < minimum:

            print(
                f"ERRORE: {args.path} deve essere almeno {minimum}.",
                file=sys.stderr
            )

            sys.exit(1)

    if not str(value).strip() and not isinstance(value, bool):
        print("ERRORE: il valore non può essere vuoto.", file=sys.stderr)
        sys.exit(1)

    #
    # Validazione di schema (code review 2026-08-20, §4) — prima
    # cmd_set accettava QUALUNQUE path e ci scriveva sopra un valore
    # scalare (stringa/intero/bool) senza controllare cosa ci fosse
    # già lì: 'set trace.paths qualcosa' o 'set
    # neighbor_monitoring.repeaters qualcosa' avrebbe silenziosamente
    # sovrascritto un'intera lista con una stringa, corrompendo
    # config.yaml in un modo che il solo controllo YAML-valido di
    # save_config() non intercetta (il file resta sintatticamente
    # valido, solo semanticamente sbagliato) — l'errore si sarebbe
    # manifestato più tardi e altrove, al prossimo avvio del daemon
    # (es. TraceEngine che si aspetta una lista in trace.paths).
    # Questo comando è pensato per valori scalari foglia; le liste
    # hanno già i propri sottocomandi dedicati (trace-path-add/
    # remove, repeater-add/remove) che le manipolano correttamente.
    #
    existing = get_path(data, args.path)

    if isinstance(existing, (list, dict)):

        print(
            f"ERRORE: '{args.path}' è una struttura "
            f"({'lista' if isinstance(existing, list) else 'oggetto'}), non "
            f"un valore singolo — usa i sottocomandi dedicati "
            f"(trace-path-add/remove, repeater-add/remove) invece di "
            f"'set' per modificarla.",
            file=sys.stderr
        )

        sys.exit(1)

    backup_path = backup_config()
    set_path(data, args.path, value)
    save_config(data, backup_path)


def cmd_list_show(args):

    data = load_config()
    items = get_path(data, args.path) or []

    for i, item in enumerate(items):
        print(f"{i}: {item}")


def cmd_list_add(args):

    if not args.value.strip():
        print("ERRORE: il valore non può essere vuoto.", file=sys.stderr)
        sys.exit(1)

    data = load_config()
    items = get_path(data, args.path)

    if items is None:
        items = []
        set_path(data, args.path, items)

    if args.value in items:
        print(f"'{args.value}' è già presente, nessuna modifica.")
        return

    items.append(args.value)

    backup_path = backup_config()
    save_config(data, backup_path)


def cmd_list_remove(args):

    data = load_config()
    items = get_path(data, args.path)

    if not items or args.value not in items:
        print(f"'{args.value}' non trovato, nessuna modifica.")
        return

    if len(items) <= 1:

        print(
            "ERRORE: non posso rimuovere l'ultimo elemento rimasto — "
            "la lista non può restare vuota.",
            file=sys.stderr
        )

        sys.exit(1)

    items.remove(args.value)

    backup_path = backup_config()
    save_config(data, backup_path)


def cmd_trace_path_list(args):

    data = load_config()
    entries = get_path(data, "trace.paths") or []

    for i, entry in enumerate(entries):

        path, enabled = parse_path_entry(entry)
        status = "abilitato" if enabled else "disabilitato"

        print(f"{i}: {path} — {status}")


def cmd_trace_path_add(args):

    if not args.path.strip():
        print("ERRORE: il path non può essere vuoto.", file=sys.stderr)
        sys.exit(1)

    enabled = parse_bool(args.enabled)

    data = load_config()
    entries = get_path(data, "trace.paths")

    if entries is None:
        entries = []
        set_path(data, "trace.paths", entries)

    #
    # Confronto sul path "nudo" (senza suffisso), non sulla entry
    # grezza — altrimenti "X,true" e "X,false" sarebbero considerate
    # due path diversi invece di due stati dello stesso path.
    #
    if any(parse_path_entry(e)[0] == args.path for e in entries):

        print(f"'{args.path}' è già presente, nessuna modifica.")

        return

    entries.append(
        format_path_entry(args.path, enabled)
    )

    backup_path = backup_config()
    save_config(data, backup_path)


def cmd_trace_path_remove(args):

    data = load_config()
    entries = get_path(data, "trace.paths") or []

    matching = [e for e in entries if parse_path_entry(e)[0] == args.path]

    if not matching:
        print(f"'{args.path}' non trovato, nessuna modifica.")
        return

    if len(entries) <= 1:

        print(
            "ERRORE: non posso rimuovere l'ultimo path rimasto — "
            "la lista non può restare vuota.",
            file=sys.stderr
        )

        sys.exit(1)

    entries[:] = [e for e in entries if parse_path_entry(e)[0] != args.path]

    backup_path = backup_config()
    set_path(data, "trace.paths", entries)
    save_config(data, backup_path)


def cmd_trace_path_set_enabled(args):

    enabled = parse_bool(args.enabled)

    data = load_config()
    entries = get_path(data, "trace.paths") or []

    found = False

    for i, entry in enumerate(entries):

        path, _ = parse_path_entry(entry)

        if path == args.path:
            entries[i] = format_path_entry(path, enabled)
            found = True
            break

    if not found:
        print(f"'{args.path}' non trovato, nessuna modifica.")
        return

    backup_path = backup_config()
    set_path(data, "trace.paths", entries)
    save_config(data, backup_path)


def cmd_repeater_list(args):

    data = load_config()
    repeaters = get_path(data, "neighbor_monitoring.repeaters") or []

    for i, r in enumerate(repeaters):
        print(f"{i}: {r.get('name', '?')}")


def cmd_repeater_add(args):

    if not args.name.strip():
        print("ERRORE: il nome del repeater non può essere vuoto.", file=sys.stderr)
        sys.exit(1)

    data = load_config()
    repeaters = get_path(data, "neighbor_monitoring.repeaters")

    if repeaters is None:
        repeaters = []
        set_path(data, "neighbor_monitoring.repeaters", repeaters)

    if any(r.get("name") == args.name for r in repeaters):
        print(f"'{args.name}' è già presente, nessuna modifica.")
        return

    repeaters.append({"name": args.name})

    backup_path = backup_config()
    save_config(data, backup_path)


def cmd_repeater_remove(args):

    data = load_config()
    repeaters = get_path(data, "neighbor_monitoring.repeaters") or []

    matching = [r for r in repeaters if r.get("name") == args.name]

    if not matching:
        print(f"'{args.name}' non trovato, nessuna modifica.")
        return

    if len(repeaters) <= 1:

        print(
            "ERRORE: non posso rimuovere l'ultimo repeater rimasto — "
            "la lista non può restare vuota.",
            file=sys.stderr
        )

        sys.exit(1)

    repeaters[:] = [r for r in repeaters if r.get("name") != args.name]

    backup_path = backup_config()
    set_path(data, "neighbor_monitoring.repeaters", repeaters)
    save_config(data, backup_path)


def cmd_repeater_rename(args):

    if not args.new_name.strip():
        print("ERRORE: il nuovo nome non può essere vuoto.", file=sys.stderr)
        sys.exit(1)

    data = load_config()
    repeaters = get_path(data, "neighbor_monitoring.repeaters") or []

    found = False

    for r in repeaters:

        if r.get("name") == args.old_name:
            r["name"] = args.new_name
            found = True
            break

    if not found:
        print(f"'{args.old_name}' non trovato, nessuna modifica.")
        return

    backup_path = backup_config()
    save_config(data, backup_path)


def cmd_service_list(args):

    data = load_config()
    services = get_path(data, "services") or []

    for s in services:
        status = "abilitato" if s.get("enabled") else "disabilitato"
        print(f"{s.get('name')}: {status}")


def cmd_service_set_enabled(args):

    if args.name not in VALID_SERVICES:

        print(
            f"ERRORE: '{args.name}' non è un servizio valido "
            f"({', '.join(VALID_SERVICES)}).",
            file=sys.stderr
        )

        sys.exit(1)

    value = parse_bool(args.value)

    data = load_config()
    services = get_path(data, "services") or []

    found = False

    for s in services:

        if s.get("name") == args.name:
            s["enabled"] = value
            found = True
            break

    if not found:

        print(
            f"ERRORE: servizio '{args.name}' non presente in config.yaml "
            f"— file probabilmente corrotto o modificato a mano in modo "
            f"incompatibile.",
            file=sys.stderr
        )

        sys.exit(1)

    backup_path = backup_config()
    save_config(data, backup_path)


def walk_template_scalars(node, prefix=()):
    """
    Genera (dotted_path, valore) per ogni FOGLIA SCALARE del template
    — ricorre nei dizionari, ma si ferma subito su una lista (v.
    cmd_align() per il perché: le liste vanno sempre gestite con i
    sottocomandi/menu dedicati, mai fuse automaticamente da `align`).
    Questo significa che un'intera sezione lista-valued (es.
    bot.known_regions, trace.paths, neighbor_monitoring.repeaters,
    services) non viene MAI proposta da `align`, nemmeno se
    completamente assente dal config.yaml corrente — comportamento
    scelto deliberatamente, non un limite da correggere: la fusione di
    liste (dove va inserito un nuovo elemento? con quali valori?) è un
    problema diverso e più rischioso di quello che `align` risolve
    (aggiungere scalari mancanti), fuori scope di questo comando.
    """

    if isinstance(node, dict):

        for key, value in node.items():
            yield from walk_template_scalars(value, prefix + (key,))

    elif isinstance(node, list):
        return

    else:
        yield (".".join(prefix), node)


def cmd_align(args):
    """
    "Allinea al template" (docs/ARCHITECTURE.md §45) — inserisce in
    config.yaml SOLO le chiavi scalari che config/config.yaml.template
    definisce ma che nel file corrente non ci sono ancora (es. un
    parametro introdotto da una versione più recente del codice).

    Garanzie, per costruzione:
    - non sovrascrive MAI una chiave già presente, qualunque sia il
      suo valore (anche se diverso dal default del template — è
      esattamente il caso di una personalizzazione fatta con
      config.sh, che va sempre preservata);
    - non tocca MAI una lista (walk_template_scalars() non vi entra);
    - stessa sicurezza degli altri comandi che scrivono: backup,
      scrittura atomica, validazione (via backup_config()/
      save_config(), invariate) — ma solo se c'è davvero qualcosa da
      aggiungere: a differenza degli altri comandi, un `align` che non
      trova nulla di mancante non crea un backup inutile.
    """

    if not TEMPLATE_PATH.exists():

        print(
            f"ERRORE: {TEMPLATE_PATH} non trovato — impossibile "
            f"allineare senza il template.",
            file=sys.stderr
        )

        sys.exit(1)

    with open(TEMPLATE_PATH, "r", encoding="utf-8") as f:
        template = yaml.safe_load(f)

    data = load_config()

    added = []

    for path, template_value in walk_template_scalars(template):

        if path in INSTANCE_SPECIFIC_PATHS:
            continue

        if get_path(data, path) is not None:
            continue

        set_path(data, path, template_value)
        added.append((path, template_value))

    if not added:
        print("config.yaml già allineato al template — nessuna chiave mancante.")
        return

    for path, value in added:
        print(f"AGGIUNTA: {path} = {value!r}")

    backup_path = backup_config()
    save_config(data, backup_path)

    print(f"Totale: {len(added)} chiave/i aggiunta/e.")


def main():

    parser = argparse.ArgumentParser(description="Motore di modifica config.yaml")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("get")
    p.add_argument("path")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("set")
    p.add_argument("path")
    p.add_argument("value")
    p.set_defaults(func=cmd_set)

    p = sub.add_parser("list-show")
    p.add_argument("path")
    p.set_defaults(func=cmd_list_show)

    p = sub.add_parser("list-add")
    p.add_argument("path")
    p.add_argument("value")
    p.set_defaults(func=cmd_list_add)

    p = sub.add_parser("list-remove")
    p.add_argument("path")
    p.add_argument("value")
    p.set_defaults(func=cmd_list_remove)

    p = sub.add_parser("trace-path-list")
    p.set_defaults(func=cmd_trace_path_list)

    p = sub.add_parser("trace-path-add")
    p.add_argument("path")
    p.add_argument("enabled")
    p.set_defaults(func=cmd_trace_path_add)

    p = sub.add_parser("trace-path-remove")
    p.add_argument("path")
    p.set_defaults(func=cmd_trace_path_remove)

    p = sub.add_parser("trace-path-set-enabled")
    p.add_argument("path")
    p.add_argument("enabled")
    p.set_defaults(func=cmd_trace_path_set_enabled)

    p = sub.add_parser("repeater-list")
    p.set_defaults(func=cmd_repeater_list)

    p = sub.add_parser("repeater-add")
    p.add_argument("name")
    p.set_defaults(func=cmd_repeater_add)

    p = sub.add_parser("repeater-remove")
    p.add_argument("name")
    p.set_defaults(func=cmd_repeater_remove)

    p = sub.add_parser("repeater-rename")
    p.add_argument("old_name")
    p.add_argument("new_name")
    p.set_defaults(func=cmd_repeater_rename)

    p = sub.add_parser("service-list")
    p.set_defaults(func=cmd_service_list)

    p = sub.add_parser("service-set-enabled")
    p.add_argument("name")
    p.add_argument("value")
    p.set_defaults(func=cmd_service_set_enabled)

    p = sub.add_parser("align")
    p.set_defaults(func=cmd_align)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
