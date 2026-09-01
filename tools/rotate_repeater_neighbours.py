#!/home/meshcore/trace-mon/.venv/bin/python3

"""
tools/rotate_repeater_neighbours.py

Archivia mensilmente la tabella repeater_neighbours (data/contacts.db),
stesso pattern di tools/rotate_path_observations.py.

Perché questa tabella e non le altre quattro di neighbor_monitor
(repeater_status/telemetry/region/config): repeater_neighbours è
l'unica che rappresenta stato ACCUMULATO IN RAM dal repeater
interrogato (chi ha sentito direttamente, nel tempo) — un reboot del
repeater (firmware update o qualunque riavvio) lo azzera, e a
differenza delle altre quattro tabelle (letture istantanee o
configurazione persistente su flash) il dato pre-reboot NON è
recuperabile da nessun'altra fonte: se non l'abbiamo già catturato
noi in una query precedente, è perso per sempre. Vedi
docs/NEIGHBOR_MONITORING.md §13.

A differenza di path_observations, qui NON si opera per timestamp
continuo ma per "scatti" discreti (una riga per neighbour per ogni
giro di cron) — l'archivio di un mese contiene quindi più snapshot
distinti (uno per ogni queried_at in cui il cron ha girato), non un
flusso continuo. Il frontend permette di scegliere sia il mese sia lo
snapshot specifico all'interno di quel mese (vedi
/api/neighbors/:publicKey/archive/snapshots).

Stessa logica di concorrenza di rotate_path_observations.py: WAL +
busy_timeout, dato che il daemon (NeighborMonitorWriter) può scrivere
su questo stesso file mentre lo script gira come processo separato.
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
import sqlite3
from datetime import datetime, timezone

from core.config import config
from core.logger import log


BUSY_TIMEOUT_MS = 5000


def previous_month_range(today=None):
    """
    Identica a rotate_path_observations.previous_month_range() —
    duplicata qui deliberatamente invece di importata, per tenere i
    due script di rotazione indipendenti l'uno dall'altro (nessuna
    dipendenza incrociata tra tool di manutenzione).

    'today', se non passato esplicitamente, va preso nel fuso ORARIO
    LOCALE di sistema (non UTC) — fix bug 2026-09-01: stessa
    motivazione di rotate_path_observations.previous_month_range(),
    v. lì per il dettaglio completo (rotate_contacts.sh gira alle
    1:07 locali del giorno 1, che con l'ora legale UTC+2 sono ancora
    le 23:07 UTC del giorno/mese precedente — datetime.now(timezone.utc)
    faceva scegliere il mese sbagliato ogni volta che l'esecuzione
    cadeva in quella finestra). start_ts/end_ts restano in UTC,
    invariati.
    """

    today = today or datetime.now().astimezone()

    year = today.year
    month = today.month - 1

    if month == 0:
        month = 12
        year -= 1

    start = datetime(year, month, 1, tzinfo=timezone.utc)

    if month == 12:
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(year, month + 1, 1, tzinfo=timezone.utc)

    return year, month, int(start.timestamp()), int(end.timestamp())


def rotate(db_path, backup_dir, year, month, start_ts, end_ts):
    """
    Esegue la rotazione per un singolo mese [start_ts, end_ts).
    Ritorna il path del file archiviato, o None se non c'era nulla
    da archiviare (idempotente).
    """

    out_name = f"repeater_neighbours-{year:04d}-{month:02d}.json.gz"
    out_path = backup_dir / out_name

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")

    try:
        rows = conn.execute(
            """
            SELECT public_key, queried_at, neighbour_prefix,
                   secs_ago, snr
            FROM repeater_neighbours
            WHERE queried_at >= ? AND queried_at < ?
            ORDER BY queried_at ASC
            """,
            (start_ts, end_ts)
        ).fetchall()

        if not rows:
            log.info(
                "rotate_repeater_neighbours: nessuna riga per "
                "%04d-%02d, nulla da archiviare.",
                year, month
            )
            return None

        backup_dir.mkdir(parents=True, exist_ok=True)

        payload = [dict(r) for r in rows]

        tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")

        with gzip.open(tmp_path, "wt", encoding="utf-8") as f:
            json.dump(payload, f)

        tmp_path.rename(out_path)

        conn.execute(
            "DELETE FROM repeater_neighbours "
            "WHERE queried_at >= ? AND queried_at < ?",
            (start_ts, end_ts)
        )
        conn.commit()

        #
        # Protetto da sqlite3.OperationalError (code review 2026-08-20,
        # §3.8) — vedi rotate_path_observations.py per la motivazione
        # completa: l'archiviazione e il DELETE sono già committati
        # con successo a questo punto, un VACUUM fallito va solo
        # loggato, non deve far fallire la rotazione già riuscita.
        #
        try:
            conn.execute("VACUUM")

        except sqlite3.OperationalError:
            log.exception(
                "rotate_repeater_neighbours: VACUUM fallito dopo "
                "l'archiviazione di %04d-%02d (dati comunque al "
                "sicuro, il DB resta solo temporaneamente non "
                "compattato).",
                year, month
            )

        log.info(
            "rotate_repeater_neighbours: archiviate %d righe "
            "(%04d-%02d) in %s, tabella compattata.",
            len(rows), year, month, out_path
        )

        return out_path

    finally:
        conn.close()


def main():

    parser = argparse.ArgumentParser(
        description="Archivia mensilmente repeater_neighbours da contacts.db"
    )

    parser.add_argument(
        "--year",
        type=int,
        help="Anno da archiviare (default: mese precedente a oggi)"
    )

    parser.add_argument(
        "--month",
        type=int,
        help="Mese da archiviare 1-12 (default: mese precedente a oggi)"
    )

    args = parser.parse_args()

    db_path = Path(
        config.get("contacts.db_file", "data/contacts.db")
    )

    if not db_path.exists():
        log.info(
            "rotate_repeater_neighbours: %s non trovato, nulla da fare.",
            db_path
        )
        return

    backup_dir = PROJECT_ROOT / "backup"

    #
    # Validazione --year/--month + protezione dal mese corrente
    # (code review 2026-08-20, §3.8) — identica a
    # rotate_path_observations.py; qui ancora più critica perché
    # repeater_neighbours rappresenta stato accumulato in RAM sul
    # repeater, esplicitamente NON recuperabile da nessun'altra fonte
    # una volta perso (v. docstring di modulo).
    #
    if (args.year is None) != (args.month is None):
        log.error(
            "rotate_repeater_neighbours: --year e --month vanno "
            "passati insieme, non uno alla volta."
        )
        sys.exit(1)

    if args.year is not None and args.month is not None:

        if not (1 <= args.month <= 12):
            log.error(
                "rotate_repeater_neighbours: --month non valido (%d), "
                "deve essere 1-12.",
                args.month
            )
            sys.exit(1)

        if not (2000 <= args.year <= 2100):
            log.error(
                "rotate_repeater_neighbours: --year non valido (%d), "
                "atteso un valore ragionevole (2000-2100).",
                args.year
            )
            sys.exit(1)

        # 'now' in ora LOCALE, non UTC (fix bug 2026-09-01, stessa
        # motivazione della protezione gemella in
        # rotate_path_observations.py): con UTC, un `--month` appena
        # concluso poteva essere rifiutato per errore come "mese
        # corrente" se lanciato a mano nella finestra oraria critica
        # (dopo la mezzanotte locale ma prima di quella UTC).
        #
        now = datetime.now().astimezone()

        if (args.year, args.month) >= (now.year, now.month):
            log.error(
                "rotate_repeater_neighbours: rifiuto di archiviare "
                "%04d-%02d, e' il mese corrente o un mese futuro "
                "(oggi: %04d-%02d). Si puo' archiviare solo un mese "
                "gia' concluso.",
                args.year, args.month, now.year, now.month
            )
            sys.exit(1)

        start = datetime(args.year, args.month, 1, tzinfo=timezone.utc)

        if args.month == 12:
            end = datetime(args.year + 1, 1, 1, tzinfo=timezone.utc)
        else:
            end = datetime(args.year, args.month + 1, 1, tzinfo=timezone.utc)

        year, month = args.year, args.month
        start_ts, end_ts = int(start.timestamp()), int(end.timestamp())

    else:
        year, month, start_ts, end_ts = previous_month_range()

    rotate(db_path, backup_dir, year, month, start_ts, end_ts)


if __name__ == "__main__":
    main()
