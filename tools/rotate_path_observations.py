#!/home/meshcore/trace-mon/.venv/bin/python3

"""
tools/rotate_path_observations.py

Archivia mensilmente le osservazioni di path (tabella
path_observations in data/contacts.db), sullo stesso pattern già in
uso per trace.json (backup.sh): esporta il mese appena concluso in un
file JSON compresso, poi lo rimuove dalla tabella live e compatta il
DB con VACUUM.

A differenza di backup.sh (che ruota un intero file), qui si opera
per riga su una tabella condivisa con 'nodes', che NON va toccata —
solo path_observations cresce senza limite nel tempo (una riga per
ogni advert ricevuto), 'nodes' resta piccolo e sempre "corrente"
(docs/CONTACT_MANAGEMENT.md). Con questa rotazione, contacts.db resta
delimitato a 'nodes' + al più ~1 mese di path_observations, invece di
crescere indefinitamente — risolve sia il costo del VACUUM INTO di
contact_sync.sh (opera su un file bounded, non su uno che cresce per
sempre) sia la dimensione del trasferimento verso il Collettore.

Va eseguito il primo di ogni mese, PRIMA del prossimo giro di
contact_sync.sh — stesso ordine già in uso tra backup.sh e trace.sh —
così il Collettore riceve un contacts.db già compattato.

Concorrenza: il daemon (ContactSyncModule) scrive su questo stesso
file in tempo reale mentre questo script gira come processo separato.
mesh_modules/contact_sync/db.py usa WAL + busy_timeout=5000 apposta
per questo scenario — un conflitto di lock fa attendere la
connessione invece di fallire subito. Qui si usa lo stesso busy_timeout
sulla connessione di questo script.
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
import sqlite3
from datetime import datetime, timezone

from core.config import config
from core.logger import log


BUSY_TIMEOUT_MS = 5000


def previous_month_range(today=None):
    """
    Restituisce (year, month, start_ts, end_ts) del mese
    IMMEDIATAMENTE precedente a 'today' (mese corrente - 1, con
    rollover dicembre->gennaio) — stessa logica già usata in
    backup.sh per trace.json. start_ts/end_ts sono timestamp Unix in
    UTC, intervallo [start, end) — end è il primo istante del mese
    successivo a quello archiviato, quindi il confine è sempre
    corretto indipendentemente dal numero di giorni del mese.
    """

    today = today or datetime.now(timezone.utc)

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
    da archiviare per quel mese (idempotente: rieseguibile senza
    effetti se già fatto, o se il mese non ha osservazioni).
    """

    out_name = f"path_observations-{year:04d}-{month:02d}.json.gz"
    out_path = backup_dir / out_name

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")

    try:
        rows = conn.execute(
            """
            SELECT public_key, observed_at, adv_timestamp, pkt_hash,
                   path_hex, hop_count, route_type, transport_code,
                   rssi, snr
            FROM path_observations
            WHERE observed_at >= ? AND observed_at < ?
            ORDER BY observed_at ASC
            """,
            (start_ts, end_ts)
        ).fetchall()

        if not rows:
            log.info(
                "rotate_path_observations: nessuna riga per %04d-%02d, "
                "nulla da archiviare.",
                year, month
            )
            return None

        backup_dir.mkdir(parents=True, exist_ok=True)

        payload = [dict(r) for r in rows]

        #
        # File temporaneo poi rename atomico: se lo script viene
        # interrotto a metà scrittura non lascia un .json.gz
        # troncato/corrotto al suo posto.
        #
        tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")

        with gzip.open(tmp_path, "wt", encoding="utf-8") as f:
            json.dump(payload, f)

        tmp_path.rename(out_path)

        conn.execute(
            "DELETE FROM path_observations "
            "WHERE observed_at >= ? AND observed_at < ?",
            (start_ts, end_ts)
        )
        conn.commit()

        #
        # VACUUM fuori da qualunque transazione esplicita — richiede
        # di essere l'unica operazione in corso sulla connessione,
        # SQLite lo gestisce da sé.
        #
        # Protetto da sqlite3.OperationalError (code review 2026-08-20,
        # §3.8) — su hardware Raspberry Pi lento, o in caso di
        # contesa residua con un altro processo, VACUUM può fallire o
        # bloccarsi per secondi/minuti; prima un errore qui interrompeva
        # con un traceback grezzo l'intero script — ma a questo punto
        # l'archiviazione e il DELETE sono GIÀ committati con successo
        # (il dato è al sicuro): un VACUUM fallito significa solo che
        # il file DB non si compatta in questo giro, non una perdita
        # di dati. Va quindi solo loggato, non deve far fallire la
        # rotazione già riuscita.
        #
        try:
            conn.execute("VACUUM")

        except sqlite3.OperationalError:
            log.exception(
                "rotate_path_observations: VACUUM fallito dopo "
                "l'archiviazione di %04d-%02d (dati comunque al "
                "sicuro, il DB resta solo temporaneamente non "
                "compattato).",
                year, month
            )

        log.info(
            "rotate_path_observations: archiviate %d righe (%04d-%02d) "
            "in %s, tabella compattata.",
            len(rows), year, month, out_path
        )

        return out_path

    finally:
        conn.close()


def main():

    parser = argparse.ArgumentParser(
        description="Archivia mensilmente path_observations da contacts.db"
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
            "rotate_path_observations: %s non trovato, nulla da fare.",
            db_path
        )
        return

    backup_dir = PROJECT_ROOT / "backup"

    #
    # Validazione --year/--month (code review 2026-08-20, §3.8):
    # prima, passare solo uno dei due argomenti veniva ignorato in
    # silenzio (ricadeva sul mese precedente di default, senza alcun
    # avviso) e valori fuori range arrivavano crudi al costruttore
    # datetime(), con un traceback poco leggibile invece di un
    # messaggio d'errore chiaro.
    #
    if (args.year is None) != (args.month is None):
        log.error(
            "rotate_path_observations: --year e --month vanno passati "
            "insieme, non uno alla volta."
        )
        sys.exit(1)

    if args.year is not None and args.month is not None:

        if not (1 <= args.month <= 12):
            log.error(
                "rotate_path_observations: --month non valido (%d), "
                "deve essere 1-12.",
                args.month
            )
            sys.exit(1)

        if not (2000 <= args.year <= 2100):
            log.error(
                "rotate_path_observations: --year non valido (%d), "
                "atteso un valore ragionevole (2000-2100).",
                args.year
            )
            sys.exit(1)

        #
        # Protezione dal mese corrente (§3.8): una rotazione manuale
        # eseguita per errore sul mese in corso (o su un mese futuro)
        # rimuoverebbe da path_observations dati non ancora completi,
        # e la successiva rotazione automatica del mese giusto non
        # potrebbe più recuperarli — perdita permanente.
        #
        now = datetime.now(timezone.utc)

        if (args.year, args.month) >= (now.year, now.month):
            log.error(
                "rotate_path_observations: rifiuto di archiviare "
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
