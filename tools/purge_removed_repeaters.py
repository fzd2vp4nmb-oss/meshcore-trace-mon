#!/home/meshcore/trace-mon/.venv/bin/python3

"""
tools/purge_removed_repeaters.py

Rimuove da contacts.db (data/contacts.db) i dati dei repeater che NON
sono più monitorati: tabelle repeater_status, repeater_neighbours,
repeater_telemetry, repeater_region, repeater_config, repeater_clock.
Chiamato da rotate_contacts.sh, subito dopo le due rotazioni mensili
(path_observations, repeater_neighbours). Vedi docs/ARCHITECTURE.md §82.

Perche' serve. Il selettore del tab Repeaters (Nodo e Collettore) e'
popolato dal DB (SELECT DISTINCT su repeater_status JOIN nodes, v.
docs/NEIGHBOR_MONITORING.md §7), non da config.yaml: un repeater
rimosso con `config.sh` (repeater-remove, che tocca SOLO config.yaml)
restava quindi elencato per sempre, perche' nessun codice cancellava
righe di quelle tabelle (le uniche DELETE del progetto erano le due
rotazioni mensili, e solo su path_observations/repeater_neighbours).

Quando un repeater e' "rimosso". Entrambe le condizioni:

  1) NON risolve a nessun nome di neighbor_monitoring.repeaters in
     config.yaml. La risoluzione e' la STESSA del monitor
     (core/contact_lookup.find_contact_by_name con case_sensitive=True:
     match ESATTO e case-sensitive su nodes.adv_name, nessun
     fallback per sottostringa). Se piu' chiavi hanno lo stesso
     adv_name, TUTTE sono considerate configurate (scelta prudente:
     meglio non cancellare che cancellare un repeater ancora in uso).
  2) Nessuna riga, in NESSUNA delle sei tabelle, piu' recente di
     --inactive-days giorni (default 7). Il config.yaml contiene NOMI,
     e un nome puo' passare da una chiave all'altra (rinomina del
     repeater, firmware che riporta un adv_name di default dopo un
     reset — caso reale di node_04, 2026-10): senza questa seconda
     condizione una rinomina o un contatto momentaneamente non
     risolto farebbe cancellare lo storico di un repeater ancora
     interrogato. 7 giorni > di qualunque buco globale osservato
     (82 h) e molto sotto un mese.

Un repeater rimosso a fine mese (ultime righe < --inactive-days)
sopravvive fino alla rotazione successiva: voluto, non un difetto.

Cosa viene cancellato. Per ogni repeater rimosso, TUTTE le righe delle
sei tabelle (intera storia, non solo il mese chiuso). La riga in
`nodes` NON si tocca (e' un contatto, non un dato di monitoraggio).
Gli archivi mensili repeater_neighbours-YYYY-MM.json.gz gia' prodotti
(Nodo e Collettore) restano intatti.

Rete di sicurezza. Cinque delle sei tabelle non hanno alcun archivio
mensile: PRIMA del DELETE le righe di ogni repeater rimosso sono
scritte in backup/repeater_removed-YYYY-MM-<chiave12>.json.gz
(file temporaneo + rename, poi mai sovrascritto: se il nome esiste si
aggiunge -2, -3...). Il file resta sul Nodo, NON viene inviato al
Collettore (rotate_contacts.sh non lo cita).

Atomicita'. Backup + DELETE avvengono dentro UNA transazione
BEGIN IMMEDIATE: il writer del daemon (NeighborMonitorWriter) non puo'
inserire righe tra la decisione "e' inattivo" e il DELETE. Un errore
qualunque (backup incluso) => ROLLBACK, nessun dato cancellato.
Idempotente: una seconda esecuzione non trova piu' nulla da cancellare.

Salvaguardia: se config.yaml non contiene almeno un nome di repeater
valido lo script RIFIUTA di cancellare (exit 1) — un config illeggibile
o vuoto non deve mai tradursi in "tutti i repeater sono rimossi"
(config.sh stesso impedisce di svuotare la lista).

Il Collettore non ha bisogno di nulla: contact_sync.sh gli invia una
copia COMPLETA di contacts.db, quindi eredita la pulizia al primo sync
dopo la rotazione.
"""

from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parent.parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from bootstrap import bootstrap
bootstrap()

import argparse
import gzip
import json
import os
import sqlite3
import time
from datetime import datetime

from core.config import config
from core.contact_lookup import find_contact_by_name
from core.logger import log


BUSY_TIMEOUT_MS = 5000

DEFAULT_INACTIVE_DAYS = 7

# Le sei tabelle con colonne public_key + queried_at (schema in
# mesh_modules/contact_sync/db.py). L'ordine e' quello del backup.
REPEATER_TABLES = (
    "repeater_status",
    "repeater_neighbours",
    "repeater_telemetry",
    "repeater_region",
    "repeater_config",
    "repeater_clock",
)


def configured_repeater_names(raw):
    """
    Estrae i nomi validi da neighbor_monitoring.repeaters (lista di
    {name: ...}). Voci non-dict, senza 'name' o con nome non stringa/
    vuoto sono ignorate (il monitor non saprebbe risolverle).
    """

    names = []

    if not isinstance(raw, list):
        return names

    for entry in raw:
        if not isinstance(entry, dict):
            continue

        name = entry.get("name")

        if isinstance(name, str) and name:
            names.append(name)

    return names


def protected_keys(conn, names):
    """
    Chiavi pubbliche che risolvono a un nome configurato, con la
    stessa regola del monitor (match esatto case-sensitive su
    nodes.adv_name). Tutte le chiavi con quel nome sono protette.
    """

    contacts = {}

    for row in conn.execute("SELECT public_key, adv_name FROM nodes"):
        contacts[row[0]] = {"adv_name": row[1]}

    keys = set()

    for name in names:
        # find_contact_by_name restituisce un solo contatto: per
        # proteggere TUTTE le chiavi omonime si ripete la regola di
        # uguaglianza esatta (stessa del monitor) su ogni contatto.
        if find_contact_by_name(
            contacts, name, allow_substring=False, case_sensitive=True
        ) is None:
            continue

        for pk, c in contacts.items():
            if (c.get("adv_name") or "") == name:
                keys.add(pk)

    return keys


def existing_tables(conn):
    found = {
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }

    return [t for t in REPEATER_TABLES if t in found]


def last_activity_by_key(conn, tables):
    """public_key -> queried_at massimo su tutte le tabelle presenti."""

    last = {}

    for t in tables:
        for pk, ts in conn.execute(
            f"SELECT public_key, MAX(queried_at) FROM {t} "
            f"GROUP BY public_key"
        ):
            if ts is None:
                continue

            if pk not in last or ts > last[pk]:
                last[pk] = ts

    return last


def select_removed(conn, tables, names, cutoff_ts):
    """
    Ritorna (rimossi, protetti_ma_inattivi): rimossi = chiavi con dati
    che non risolvono a un nome configurato E con ultima attivita'
    < cutoff_ts.
    """

    protected = protected_keys(conn, names)
    last = last_activity_by_key(conn, tables)

    removed = sorted(
        pk for pk, ts in last.items()
        if pk not in protected and ts < cutoff_ts
    )

    return removed, sorted(protected & set(last))


def backup_path_for(backup_dir, now, public_key):
    base = f"repeater_removed-{now.year:04d}-{now.month:02d}-{public_key[:12]}"
    path = backup_dir / f"{base}.json.gz"
    n = 2

    while path.exists():
        path = backup_dir / f"{base}-{n}.json.gz"
        n += 1

    return path


def write_backup(conn, tables, public_key, path):
    payload = {"public_key": public_key, "tables": {}}

    for t in tables:
        cur = conn.execute(
            f"SELECT * FROM {t} WHERE public_key = ? ORDER BY id ASC",
            (public_key,)
        )
        payload["tables"][t] = [dict(r) for r in cur.fetchall()]

    tmp_path = path.with_suffix(path.suffix + ".tmp")

    with gzip.open(tmp_path, "wt", encoding="utf-8") as f:
        json.dump(payload, f)

    os.replace(tmp_path, path)

    return {t: len(rows) for t, rows in payload["tables"].items()}


def purge(db_path, backup_dir, names, inactive_days,
          now_ts=None, dry_run=False):
    """
    Esegue la pulizia. Ritorna {public_key: {tabella: righe}} dei
    repeater rimossi (vuoto se nulla da fare; con dry_run nulla viene
    scritto ne' cancellato).
    """

    now_ts = int(time.time()) if now_ts is None else int(now_ts)
    now = datetime.fromtimestamp(now_ts).astimezone()
    cutoff_ts = now_ts - int(inactive_days) * 86400

    # isolation_level=None: BEGIN/COMMIT espliciti (BEGIN IMMEDIATE).
    conn = sqlite3.connect(str(db_path), isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")

    result = {}

    try:
        tables = existing_tables(conn)

        if not tables:
            log.info(
                "purge_removed_repeaters: nessuna tabella repeater_* "
                "in %s, nulla da fare.", db_path
            )
            return result

        # Il lock di scrittura va preso PRIMA di decidere, cosi' la
        # decisione resta valida fino al DELETE.
        conn.execute("BEGIN IMMEDIATE")

        try:
            removed, _kept = select_removed(
                conn, tables, names, cutoff_ts
            )

            if not removed:
                conn.execute("ROLLBACK")
                log.info(
                    "purge_removed_repeaters: nessun repeater da "
                    "rimuovere (nomi in config: %d, soglia "
                    "inattivita': %d giorni).",
                    len(names), inactive_days
                )
                return result

            if not dry_run:
                backup_dir.mkdir(parents=True, exist_ok=True)

            for pk in removed:
                if dry_run:
                    counts = {
                        t: conn.execute(
                            f"SELECT COUNT(*) FROM {t} WHERE public_key = ?",
                            (pk,)
                        ).fetchone()[0]
                        for t in tables
                    }
                    log.info(
                        "purge_removed_repeaters: [dry-run] rimuoverei "
                        "%s: %s", pk, counts
                    )
                    result[pk] = counts
                    continue

                bpath = backup_path_for(backup_dir, now, pk)
                counts = write_backup(conn, tables, pk, bpath)

                for t in tables:
                    conn.execute(
                        f"DELETE FROM {t} WHERE public_key = ?", (pk,)
                    )

                result[pk] = counts

                log.info(
                    "purge_removed_repeaters: rimosso %s (righe: %s), "
                    "copia di sicurezza in %s", pk, counts, bpath
                )

            if dry_run:
                conn.execute("ROLLBACK")
            else:
                conn.execute("COMMIT")

        except BaseException:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise

        if result and not dry_run:
            # DELETE gia' committato: un VACUUM fallito si logga e basta
            # (stessa regola delle due rotazioni mensili).
            try:
                conn.execute("VACUUM")
            except sqlite3.OperationalError:
                log.exception(
                    "purge_removed_repeaters: VACUUM fallito dopo la "
                    "pulizia (dati cancellati, DB solo non compattato)."
                )

        return result

    finally:
        conn.close()


def main():

    parser = argparse.ArgumentParser(
        description=(
            "Rimuove da contacts.db i dati dei repeater non piu' in "
            "neighbor_monitoring.repeaters e inattivi."
        )
    )

    parser.add_argument(
        "--inactive-days",
        type=int,
        default=DEFAULT_INACTIVE_DAYS,
        help=(
            "Giorni senza alcuna riga per considerare inattivo un "
            f"repeater non in config (default: {DEFAULT_INACTIVE_DAYS})"
        )
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Mostra cosa verrebbe rimosso, senza scrivere nulla"
    )

    args = parser.parse_args()

    if args.inactive_days < 1:
        log.error(
            "purge_removed_repeaters: --inactive-days deve essere >= 1 "
            "(ricevuto %d).", args.inactive_days
        )
        sys.exit(1)

    db_path = Path(
        config.get("contacts.db_file", "data/contacts.db")
    )

    if not db_path.exists():
        log.info(
            "purge_removed_repeaters: %s non trovato, nulla da fare.",
            db_path
        )
        return

    names = configured_repeater_names(
        config.get("neighbor_monitoring.repeaters")
    )

    if not names:
        log.error(
            "purge_removed_repeaters: nessun nome valido in "
            "neighbor_monitoring.repeaters di config.yaml — rifiuto di "
            "cancellare (config vuoto/illeggibile non significa "
            "'tutti rimossi')."
        )
        sys.exit(1)

    purge(
        db_path,
        PROJECT_ROOT / "backup",
        names,
        args.inactive_days,
        dry_run=args.dry_run
    )


if __name__ == "__main__":
    main()
