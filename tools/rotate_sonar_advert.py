#!/home/meshcore/trace-mon/.venv/bin/python3

"""
tools/rotate_sonar_advert.py

Archivia mensilmente le tre tabelle dei dati di propagazione di
data/contacts.db, sullo stesso schema di tools/rotate_path_observations.py
(mese appena concluso -> file JSON compresso in backup/, poi DELETE di
quelle righe e VACUUM):

    sonar_rx    le ricezioni dei messaggi sonar (una riga per copia fisica)
    sonar_tx    gli invii sonar di questo nodo (uno per progressivo)
    advert_tx   gli advert trasmessi da questo nodo (flood e zero-hop)

Perché esiste (docs/ARCHITECTURE.md §87.17): l'analisi della propagazione
incrocia i path degli advert ricevuti (path_observations, già ruotata e
archiviata ogni mese) con quelli dei messaggi sonar; perché l'analisi
abbia uno storico riproducibile nel tempo anche le tabelle sonar e il
registro degli advert trasmessi vanno archiviate come le altre, invece
di crescere senza limite (era la decisione D7 del §87, ora superata).

Un archivio per tabella, con lo stesso nome-formato degli altri:

    backup/sonar_rx-YYYY-MM.json.gz
    backup/sonar_tx-YYYY-MM.json.gz
    backup/advert_tx-YYYY-MM.json.gz

Lista JSON di oggetti, una per riga, con TUTTE le colonne della tabella
(chiave primaria compresa: id / seq). Nessun filtro, nessuna
deduplicazione: le copie dello stesso messaggio arrivate per percorsi
diversi sono dati voluti (docs/ARCHITECTURE.md §37 Follow-up 7, §87.3
D2) e finiscono tutte nell'archivio.

DIFFERENZE rispetto a rotate_path_observations.py, tutte dovute al fatto
che qui un errore costa di più (tabelle piccole ma ogni riga è un punto
di una serie che si analizza dopo):

  - si cancellano SOLO le righe effettivamente archiviate (per chiave),
    non "tutto ciò che cade nell'intervallo": una riga comparsa dopo la
    lettura, o non archiviata, non viene mai cancellata;
  - le righe di sonar_tx ancora 'pending' (invio in corso) NON si
    toccano: finish_sonar_tx() aggiorna solo righe 'pending', quindi
    cancellarne una farebbe perdere in silenzio l'esito dell'invio;
  - se l'archivio del mese esiste già (rotazione interrotta dopo la
    scrittura del file, o riga arrivata in ritardo dopo una rotazione
    riuscita) NON lo si sovrascrive: si UNISCE per chiave primaria e
    si riscrive in modo atomico. Un archivio esistente illeggibile
    ferma quella tabella (nessuna riga cancellata) — mai si perde un
    dato per ricreare un file;
  - le tre tabelle sono indipendenti: l'errore su una non impedisce le
    altre; il codice di uscita è 1 se almeno una è fallita;
  - una tabella assente (nodo che non ha ancora il db.py aggiornato)
    non è un errore: nulla da archiviare.

Il progressivo del sonar NON riparte: sonar_tx.seq è AUTOINCREMENT, il
suo valore massimo vive in sqlite_sequence, che né il DELETE né il
VACUUM azzerano (verificato dai test). Conseguenza nota e innocua: dopo
la rotazione sonar_tx contiene solo gli invii del mese in corso, quindi
"l'ultimo invio" che il daemon conosce (guardia sonar.tx.min_interval,
tools/sonar_status.py) manca finché non ne parte uno nuovo se l'ultimo
cadeva nel mese appena concluso. L'effetto pratico sulla guardia è
limitato ai min_interval secondi a cavallo della mezzanotte UTC del
giorno 1 (la rotazione gira all'1:07 locale).

Va eseguito il primo di ogni mese, da rotate_contacts.sh (dentro il suo
lock), PRIMA del prossimo giro di contact_sync.sh — stesso ordine delle
altre rotazioni — così il Collettore riceve un contacts.db già
compattato.

Concorrenza: il daemon scrive su questo stesso file mentre lo script
gira come processo separato. WAL + busy_timeout come negli altri
script di rotazione.

Uso:

    tools/rotate_sonar_advert.py                    mese precedente a oggi
    tools/rotate_sonar_advert.py --year 2026 --month 9
    tools/rotate_sonar_advert.py --dry-run          conta, non scrive nulla
"""

from pathlib import Path
import sys

#
# Root del progetto
#
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
from datetime import datetime, timezone

from core.config import config
from core.logger import log


BUSY_TIMEOUT_MS = 5000

#
# Le tre tabelle: colonne ESPLICITE (non SELECT *: se una futura
# migrazione aggiungesse colonne, l'archivio cambierebbe formato senza
# che nessuno lo decida), colonna temporale che stabilisce il mese,
# chiave primaria, eventuale condizione che esclude righe dalla
# rotazione.
#
TABLES = (
    {
        "table": "sonar_rx",
        "key": "id",
        "time": "observed_at",
        "where": None,
        "columns": (
            "id", "observed_at", "src_prefix", "seq", "scope_tag",
            "channel", "sender_timestamp", "msg_hash", "pkt_hash",
            "route_type", "transport_code", "path_hex", "hop_count",
            "hash_size", "rssi", "snr", "is_local"
        )
    },
    {
        "table": "sonar_tx",
        "key": "seq",
        "time": "created_at",
        #
        # 'pending' = invio in corso (o residuo di un riavvio, che il
        # daemon porta a 'unknown' alla partenza): mai ruotato.
        #
        "where": "status != 'pending'",
        "columns": (
            "seq", "created_at", "src_prefix", "channel", "scope_tag",
            "status", "sent_at", "msg_timestamp", "error"
        )
    },
    {
        "table": "advert_tx",
        "key": "id",
        "time": "created_at",
        "where": None,
        "columns": (
            "id", "created_at", "src_prefix", "kind", "status",
            "sent_at", "error"
        )
    }
)


def previous_month_range(today=None):
    """
    Identica a rotate_path_observations.previous_month_range() —
    duplicata qui deliberatamente invece di importata, per tenere gli
    script di rotazione indipendenti l'uno dall'altro (nessuna
    dipendenza incrociata tra tool di manutenzione). Restituisce
    (year, month, start_ts, end_ts) del mese IMMEDIATAMENTE precedente
    a 'today' (rollover dicembre->gennaio); start_ts/end_ts sono
    timestamp Unix in UTC, intervallo [start, end).

    'today', se non passato, è nel fuso ORARIO LOCALE di sistema, non
    UTC: v. il commento di rotate_path_observations.previous_month_range()
    e docs/CHANGES_rotate_month_local_time.md (con l'ora legale
    l'esecuzione delle 1:07 locali del giorno 1 è ancora il mese
    precedente in UTC).
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


def _table_exists(conn, name):

    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (name,)
    ).fetchone()

    return row is not None


def _read_archive(path):
    """
    Legge un archivio esistente. Solleva ValueError se non è una lista
    di oggetti: il chiamante NON deve in quel caso sovrascriverlo né
    cancellare righe dal database.
    """

    try:

        with gzip.open(path, "rt", encoding="utf-8") as f:
            data = json.load(f)

    except (OSError, EOFError, ValueError) as exc:

        raise ValueError(
            f"archivio esistente illeggibile ({path}): "
            f"{type(exc).__name__}: {exc}"
        ) from exc

    if not isinstance(data, list) or not all(
        isinstance(item, dict) for item in data
    ):

        raise ValueError(
            f"archivio esistente non valido ({path}): attesa una "
            "lista di oggetti"
        )

    return data


def _write_archive(path, rows):
    """
    File temporaneo poi rename atomico: un'interruzione a metà
    scrittura non lascia un .json.gz troncato al posto di quello
    buono. Se la scrittura fallisce (disco pieno, ...) il file
    temporaneo parziale viene tolto, l'eventuale archivio già
    presente resta quello di prima.
    """

    tmp_path = path.with_suffix(path.suffix + ".tmp")

    try:

        with gzip.open(tmp_path, "wt", encoding="utf-8") as f:
            json.dump(rows, f)

        os.replace(tmp_path, path)

    except BaseException:

        try:
            tmp_path.unlink()

        except OSError:
            pass

        raise


def rotate_table(
    conn,
    spec,
    backup_dir,
    year,
    month,
    start_ts,
    end_ts,
    dry_run=False
):
    """
    Rotazione di UNA tabella per il mese [start_ts, end_ts). Ritorna
    un dict:

        table     nome della tabella
        found     righe del mese selezionate
        archived  righe scritte nell'archivio (0 se nulla/dry-run)
        deleted   righe cancellate dalla tabella
        archive   Path dell'archivio, o None
        skipped   motivo se non c'era nulla da fare, altrimenti None

    Solleva in caso di errore, DOPO aver annullato la transazione: il
    chiamante (rotate()) lo registra e passa alla tabella successiva.
    Idempotente: rieseguita senza nuove righe non cambia nulla (né il
    database né l'archivio).
    """

    table = spec["table"]
    key = spec["key"]
    time_col = spec["time"]
    columns = spec["columns"]

    result = {
        "table": table,
        "found": 0,
        "archived": 0,
        "deleted": 0,
        "archive": None,
        "skipped": None
    }

    if not _table_exists(conn, table):

        result["skipped"] = "tabella assente"

        log.info(
            "rotate_sonar_advert: tabella %s assente (db.py non ancora "
            "aggiornato su questo nodo?), nulla da archiviare.",
            table
        )

        return result

    query = (
        f"SELECT {', '.join(columns)} FROM {table} "
        f"WHERE {time_col} >= ? AND {time_col} < ?"
    )

    if spec["where"]:
        query += f" AND ({spec['where']})"

    query += f" ORDER BY {time_col} ASC, {key} ASC"

    rows = [
        dict(r)
        for r in conn.execute(query, (start_ts, end_ts)).fetchall()
    ]

    result["found"] = len(rows)

    if not rows:

        result["skipped"] = "nessuna riga"

        log.info(
            "rotate_sonar_advert: %s: nessuna riga per %04d-%02d, nulla "
            "da archiviare.",
            table, year, month
        )

        return result

    out_path = backup_dir / f"{table}-{year:04d}-{month:02d}.json.gz"

    if dry_run:

        log.info(
            "rotate_sonar_advert: %s: [dry-run] %d righe per %04d-%02d "
            "verrebbero archiviate in %s%s.",
            table, len(rows), year, month, out_path,
            " (unite a quelle già presenti)" if out_path.exists() else ""
        )

        return result

    try:

        merged = rows

        if out_path.exists():

            #
            # ValueError se illegibile: l'eccezione esce, nessuna riga
            # viene cancellata (v. docstring del modulo).
            #
            existing = _read_archive(out_path)

            by_key = {item.get(key): item for item in existing}

            for item in rows:
                by_key[item[key]] = item

            merged = sorted(
                by_key.values(),
                key=lambda item: (item.get(time_col) or 0, item.get(key) or 0)
            )

            log.info(
                "rotate_sonar_advert: %s: archivio %s già presente "
                "(%d righe), unite %d righe del database (totale %d).",
                table, out_path, len(existing), len(rows), len(merged)
            )

        backup_dir.mkdir(parents=True, exist_ok=True)

        _write_archive(out_path, merged)

        #
        # Solo ora, con l'archivio al sicuro sul disco: si cancellano
        # ESATTAMENTE le righe che vi sono finite, per chiave.
        #
        cur = conn.executemany(
            f"DELETE FROM {table} WHERE {key} = ?",
            [(item[key],) for item in rows]
        )

        deleted = cur.rowcount

        conn.commit()

    except Exception:

        conn.rollback()

        raise

    result["archived"] = len(merged)
    result["deleted"] = deleted
    result["archive"] = out_path

    if deleted != len(rows):

        log.warning(
            "rotate_sonar_advert: %s: archiviate %d righe ma ne risultano "
            "cancellate %d (qualcuno le ha toccate nel frattempo?): "
            "controllare.",
            table, len(rows), deleted
        )

    log.info(
        "rotate_sonar_advert: %s: archiviate %d righe (%04d-%02d) in %s.",
        table, len(rows), year, month, out_path
    )

    return result


def rotate(db_path, backup_dir, year, month, start_ts, end_ts, dry_run=False):
    """
    Rotazione del mese per tutte e tre le tabelle. Ritorna
    (results, failed): la lista dei dict di rotate_table() e i nomi
    delle tabelle fallite. Una tabella che fallisce non impedisce le
    altre.
    """

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")

    results = []
    failed = []

    try:

        for spec in TABLES:

            try:

                results.append(
                    rotate_table(
                        conn, spec, backup_dir,
                        year, month, start_ts, end_ts,
                        dry_run=dry_run
                    )
                )

            except Exception:

                failed.append(spec["table"])

                log.exception(
                    "rotate_sonar_advert: %s: rotazione FALLITA per "
                    "%04d-%02d (nessuna riga cancellata da questa "
                    "tabella oltre a quelle già riportate sopra).",
                    spec["table"], year, month
                )

        if any(r["deleted"] for r in results):

            #
            # VACUUM una volta sola, fuori da qualunque transazione.
            # Protetto come nelle altre rotazioni (code review
            # 2026-08-20, §3.8): a questo punto archivio e DELETE sono
            # GIÀ committati, un VACUUM fallito non è una perdita di
            # dati, solo un file non compattato in questo giro.
            #
            try:
                conn.execute("VACUUM")

            except sqlite3.OperationalError:
                log.exception(
                    "rotate_sonar_advert: VACUUM fallito dopo "
                    "l'archiviazione di %04d-%02d (dati comunque al "
                    "sicuro, il DB resta solo temporaneamente non "
                    "compattato).",
                    year, month
                )

        return results, failed

    finally:
        conn.close()


def main():

    parser = argparse.ArgumentParser(
        description=(
            "Archivia mensilmente sonar_rx, sonar_tx e advert_tx "
            "da contacts.db"
        )
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

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Mostra cosa verrebbe archiviato senza scrivere nulla"
    )

    args = parser.parse_args()

    db_path = Path(
        config.get("contacts.db_file", "data/contacts.db")
    )

    if not db_path.exists():
        log.info(
            "rotate_sonar_advert: %s non trovato, nulla da fare.",
            db_path
        )
        return

    backup_dir = PROJECT_ROOT / "backup"

    #
    # Validazione --year/--month, stessa degli altri script di
    # rotazione (code review 2026-08-20, §3.8): niente argomenti
    # ignorati in silenzio, niente valori fuori range, e rifiuto del
    # mese corrente o futuro — una rotazione manuale sul mese in corso
    # cancellerebbe dati non ancora completi.
    #
    if (args.year is None) != (args.month is None):
        log.error(
            "rotate_sonar_advert: --year e --month vanno passati "
            "insieme, non uno alla volta."
        )
        sys.exit(1)

    if args.year is not None and args.month is not None:

        if not (1 <= args.month <= 12):
            log.error(
                "rotate_sonar_advert: --month non valido (%d), "
                "deve essere 1-12.",
                args.month
            )
            sys.exit(1)

        if not (2000 <= args.year <= 2100):
            log.error(
                "rotate_sonar_advert: --year non valido (%d), "
                "atteso un valore ragionevole (2000-2100).",
                args.year
            )
            sys.exit(1)

        #
        # 'now' in ora LOCALE (fix bug 2026-09-01, v.
        # previous_month_range()).
        #
        now = datetime.now().astimezone()

        if (args.year, args.month) >= (now.year, now.month):
            log.error(
                "rotate_sonar_advert: rifiuto di archiviare %04d-%02d, "
                "e' il mese corrente o un mese futuro (oggi: %04d-%02d). "
                "Si puo' archiviare solo un mese gia' concluso.",
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

    _, failed = rotate(
        db_path, backup_dir, year, month, start_ts, end_ts,
        dry_run=args.dry_run
    )

    if failed:

        log.error(
            "rotate_sonar_advert: tabelle NON ruotate: %s.",
            ", ".join(failed)
        )

        sys.exit(1)


if __name__ == "__main__":
    main()
