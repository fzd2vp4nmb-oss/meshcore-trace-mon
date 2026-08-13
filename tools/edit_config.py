#!/home/meshcore/trace-mon/.venv/bin/python3

"""
tools/edit_config.py

Motore di modifica per config/config.yaml, usato da config.sh
(l'interfaccia a menu interattiva) — non pensato per essere invocato
direttamente dall'utente, un comando per ogni operazione atomica.

A differenza di setup.sh/generate_config.py (che GENERANO config.yaml
da zero, sostituzione testuale su un template noto), qui si MODIFICA
un file che potrebbe già essere stato toccato a mano nel frattempo —
serve un parser YAML vero (PyYAML), non sostituzione testuale.

Conseguenza nota: PyYAML non preserva i commenti alla riserializzazione.
Le spiegazioni che nel template (config.yaml.example) stavano accanto
a ciascun parametro qui sono raccolte in un unico blocco fisso
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
import sys
import shutil
import json
import sqlite3
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

#
# frontend/mesh-nodes.json — mappa public_key completa -> nome
# leggibile, usata dal frontend (Nodo e Collettore) per mostrare un
# nome nei tooltip dei grafici invece del prefisso hex grezzo. File
# per-Nodo, non condiviso: sync-meshnode.sh lo copia al Collettore,
# che ha un suo script di merge con deduplica — questo script non
# deve preoccuparsi di altri nodi, solo del proprio.
#
MESH_NODES_PATH = PROJECT_ROOT / "frontend" / "mesh-nodes.json"
BACKUP_DIR = Path("config/backup")

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

    shutil.copy2(CONFIG_PATH, backup_path)

    return backup_path


def save_config(data, backup_path):
    """
    Scrive, poi rilegge per validare. Se la rilettura fallisce,
    ripristina il backup e si ferma con un errore — mai un
    config.yaml rotto sul disco, nemmeno per un istante che sopravviva
    all'esecuzione di questo script.
    """

    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        f.write(HEADER_COMMENT)
        yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False,
                        allow_unicode=True)

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            yaml.safe_load(f)

    except yaml.YAMLError as e:

        print(
            f"ERRORE: il file scritto non è YAML valido ({e}). "
            f"Ripristino il backup.",
            file=sys.stderr
        )

        shutil.copy2(backup_path, CONFIG_PATH)

        sys.exit(1)

    print(f"config.yaml aggiornato (backup: {backup_path})")


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


def _load_mesh_nodes():
    """
    None distingue "file illeggibile, non toccare nulla" da "file
    assente o vuoto, {} va bene" — un JSON corrotto non deve essere
    silenziosamente sovrascritto da un json.dump() successivo.
    """

    if not MESH_NODES_PATH.exists():
        return {}

    try:
        with open(MESH_NODES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)

    except (json.JSONDecodeError, OSError) as e:

        print(
            f"AVVISO: impossibile leggere {MESH_NODES_PATH} ({e}) — "
            "salto l'aggiornamento automatico dei nomi nodo per "
            "questo path.",
            file=sys.stderr
        )

        return None


def _save_mesh_nodes(mesh_nodes):

    with open(MESH_NODES_PATH, "w", encoding="utf-8") as f:
        json.dump(mesh_nodes, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _contacts_db_path(data):

    db_file = get_path(data, "contacts.db_file") or "data/contacts.db"

    return PROJECT_ROOT / db_file


def auto_register_path_nodes(data, path):
    """
    Per ogni prefisso esadecimale distinto nel path, se non è già
    presente in mesh-nodes.json (stesso confronto case-insensitive
    a prefisso di resolveNodeName() in app.js) cerca una
    corrispondenza UNIVOCA in contacts.db e la aggiunge.

    SOLO aggiunta, mai rimozione (deciso con l'utente: un file più
    grande del necessario è innocuo, una voce tolta per errore rompe
    un tooltip altrove senza preavviso). Se il nodo non è ancora
    noto al device o il prefisso è ambiguo (più corrispondenze),
    stampa un avviso e lascia il compito all'utente — non è un
    errore fatale, il path resta comunque salvato.
    """

    segments = {
        s.strip()
        for s in path.split(",")
        if s.strip()
    }

    mesh_nodes = _load_mesh_nodes()

    if mesh_nodes is None:
        return

    db_path = _contacts_db_path(data)

    if not db_path.exists():

        print(
            f"AVVISO: {db_path} non trovato — impossibile risolvere "
            "automaticamente i nomi nodo per questo path. Aggiungili "
            "a mano in frontend/mesh-nodes.json quando disponibili."
        )

        return

    conn = sqlite3.connect(str(db_path))
    changed = False

    try:

        for prefix in segments:

            already_known = any(
                full_key.lower().startswith(prefix.lower())
                for full_key in mesh_nodes
            )

            if already_known:
                continue

            rows = conn.execute(
                "SELECT public_key, adv_name FROM nodes "
                "WHERE public_key LIKE ?",
                (prefix.lower() + "%",)
            ).fetchall()

            if not rows:

                print(
                    f"AVVISO: nodo '{prefix}' non ancora noto al "
                    "device — aggiungilo a mano in "
                    "frontend/mesh-nodes.json quando disponibile."
                )

                continue

            if len(rows) > 1:

                print(
                    f"AVVISO: '{prefix}' corrisponde a più di un "
                    "nodo noto (prefisso ambiguo) — aggiungilo a "
                    "mano in frontend/mesh-nodes.json scegliendo "
                    "quello giusto."
                )

                continue

            public_key, adv_name = rows[0]

            if not adv_name:

                print(
                    f"AVVISO: nodo '{prefix}' trovato ma senza nome "
                    "(adv_name vuoto) — aggiungilo a mano in "
                    "frontend/mesh-nodes.json."
                )

                continue

            mesh_nodes[public_key] = adv_name
            changed = True

            print(
                f"'{prefix}' -> '{adv_name}' aggiunto a "
                "frontend/mesh-nodes.json."
            )

    finally:
        conn.close()

    if changed:
        _save_mesh_nodes(mesh_nodes)


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

        #
        # La risoluzione dei nomi va comunque tentata: un path già
        # presente può avere nodi non ancora risolti in
        # mesh-nodes.json (es. aggiunto prima che esistesse questa
        # automazione, o riprovato dopo che il device ha imparato a
        # conoscere un nodo nel frattempo) — "già presente" riguarda
        # solo trace.paths, non deve troncare la risoluzione.
        #
        auto_register_path_nodes(data, args.path)

        return

    entries.append(
        format_path_entry(args.path, enabled)
    )

    backup_path = backup_config()
    save_config(data, backup_path)

    auto_register_path_nodes(data, args.path)


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

    if enabled:
        auto_register_path_nodes(data, args.path)


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

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
