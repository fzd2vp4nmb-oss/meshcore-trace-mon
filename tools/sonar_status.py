#!/home/meshcore/trace-mon/.venv/bin/python3

"""
tools/sonar_status.py

Mostra lo stato del servizio sonar e i contatori della ricezione
(docs/ARCHITECTURE.md §87.14). Solo lettura: parla con l'IPC (servizio
'sonar', comando 'status'), non apre il device e non scrive nulla.

A cosa serve: dire FIN DOVE arrivano i pacchetti del canale. I contatori
sono un imbuto, azzerato a ogni avvio del daemon:

    eventi RX_LOG_DATA visti          ogni pacchetto sentito dal companion
      messaggi di canale (GRP_TXT)    di qualunque canale (Public, #bot...)
        con l'hash del nostro canale  GRP_TXT col byte di hash del canale
          -> un'unica uscita fra:
          non verificati (MAC)        hash uguale ma MAC non valido
          senza testo                 verificati ma non decifrati
          testo non TM1 (ignorati)    testo libero di un utente del canale
          eco del proprio messaggio   nostro mittente: NON registrata
          path incoerente             scartati
          registrati in sonar_rx      ricezioni degli altri nodi
          scrittura DB fallita        ricezione persa (loggata)

    a parte: errori imprevisti (eccezione nel ricevitore, in qualunque punto)
    e «prefisso locale ignoto» (nota: la ricezione si registra comunque).

Letture tipiche:
    eventi fermi mentre il companion è in ascolto -> il ricevitore non
        riceve eventi (sottoscrizione, canale non pronto, daemon appena
        riavviato);
    eventi in aumento ma «messaggi di canale» fermo -> il companion
        sente traffico, ma nessun messaggio di canale;
    «messaggi di canale» in aumento ma «con l'hash del nostro canale»
        fermo -> si sentono altri canali, non il nostro (per esempio
        nessun repeater ha ripetuto il nostro messaggio);
    «non verificati» in aumento -> stesso hash a 1 byte ma segreto diverso.

Uso:
    tools/sonar_status.py

Codici di uscita: 0 stato mostrato; 1 errore (daemon non raggiungibile
o risposta di errore).
"""

from pathlib import Path
import sys

#
# Root del progetto
#
PROJECT_ROOT = Path(__file__).resolve().parent.parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

#
# Bootstrap applicazione
#
from bootstrap import bootstrap

bootstrap()

import argparse
import asyncio
import time

from tools.ipc_test_common import send_ipc_request

EXIT_OK = 0
EXIT_ERROR = 1

IPC_TIMEOUT = 30.0

#
# (chiave del contatore, etichetta). Ordine = ordine dell'imbuto.
#
FUNNEL_TOP = (
    ("rx_events", "eventi RX_LOG_DATA visti (qualunque pacchetto)"),
    ("rx_grp_txt", "di cui messaggi di canale (qualunque canale)"),
    ("rx_channel_hash", "di cui con l'hash del nostro canale"),
)

FUNNEL_EXITS = (
    ("rx_unverified", "non verificati (MAC non valido)"),
    ("rx_no_text", "verificati ma senza testo decifrato"),
    ("rx_ignored_text", "testo non TM1 (ignorati)"),
    ("rx_local_echo", "eco del proprio messaggio (non registrata)"),
    ("rx_bad_path", "path incoerente (scartati)"),
    ("rx_stored", "registrati in sonar_rx"),
    ("rx_db_errors", "scrittura nel database fallita"),
    ("rx_errors", "(a parte) errori imprevisti nel ricevitore"),
    ("rx_local_unknown", "(nota, non è un'uscita) prefisso locale ancora ignoto"),
)

TX_COUNTERS = (
    ("tx_sent", "inviati"),
    ("tx_failed", "falliti"),
    ("tx_unknown", "esito incerto"),
    ("tx_skipped", "saltati (troppo presto / disabilitata)"),
)


def _fmt_time(value):

    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return "-"

    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(value))


def _num(counters, key):

    value = counters.get(key, 0)

    if isinstance(value, bool) or not isinstance(value, int):
        return 0

    return value


def _counter_lines(title, counters, rows, indent):

    lines = [title]

    width = max(len(label) for _, label in rows)

    for key, label in rows:
        lines.append(
            f"{indent}{label.ljust(width)}  {_num(counters, key):>8}"
        )

    return lines


def format_status(response):
    """
    Testo leggibile della risposta IPC 'status' del servizio sonar
    (funzione pura: nessun I/O, usata anche dai test).
    """

    sonar = response.get("sonar")

    if not isinstance(sonar, dict):
        sonar = {}

    settings = sonar.get("settings")

    if not isinstance(settings, dict):
        settings = {}

    counters = sonar.get("counters")

    if not isinstance(counters, dict):
        counters = {}

    lines = []

    lines.append("Sonar — stato")

    lines.append(
        f"  canale            {settings.get('channel_name', '?')}  "
        f"stato={sonar.get('channel_status', '?')}  "
        f"slot={sonar.get('channel_idx', '-')}  "
        f"hash={sonar.get('channel_hash', '-')}"
    )

    detail = sonar.get("channel_detail")

    if detail:
        lines.append(f"  dettaglio         {detail}")

    lines.append(
        f"  ricevitore        "
        f"{'sottoscritto' if sonar.get('subscribed') else 'NON sottoscritto'}"
    )

    lines.append(
        f"  questo companion  {sonar.get('src_prefix') or 'sconosciuto'}"
    )

    collision = sonar.get("hash_collision_with")

    if collision:
        lines.append(
            f"  ATTENZIONE        stesso hash a 1 byte del canale '{collision}'"
        )

    errors = settings.get("errors")

    if errors:
        lines.append(f"  errori di configurazione: {errors}")

    lines.append(
        f"  trasmissione      "
        f"{'abilitata' if settings.get('tx_enabled') else 'disabilitata'}"
        f"  scope={settings.get('tx_scope', '?')}"
        f"  min_interval={settings.get('min_interval', '?')} s"
    )

    last_tx = response.get("last_tx")

    if isinstance(last_tx, dict):
        lines.append(
            f"  ultimo invio      seq={last_tx.get('seq')}  "
            f"stato={last_tx.get('status')}  "
            f"alle {_fmt_time(last_tx.get('created_at'))}"
            + (
                f"  errore={last_tx.get('error')}"
                if last_tx.get("error") else ""
            )
        )

    elif response.get("db_error"):
        lines.append("  ultimo invio      non leggibile (errore del database)")

    else:
        lines.append("  ultimo invio      nessuno")

    lines.append("")

    lines.extend(
        _counter_lines(
            "Ricezione (dall'ultimo avvio del daemon)",
            counters,
            FUNNEL_TOP,
            "  "
        )
    )

    lines.extend(
        _counter_lines(
            "  di quelli con l'hash del canale:",
            counters,
            FUNNEL_EXITS,
            "    "
        )
    )

    lines.append("")

    lines.extend(
        _counter_lines(
            "Trasmissione (dall'ultimo avvio del daemon)",
            counters,
            TX_COUNTERS,
            "  "
        )
    )

    return "\n".join(lines)


def build_parser():

    return argparse.ArgumentParser(
        description="Mostra stato e contatori del servizio sonar."
    )


async def main(argv=None):

    build_parser().parse_args(argv)

    response = await send_ipc_request(
        "sonar", "status", ipc_timeout=IPC_TIMEOUT
    )

    if response.get("status") != "ok":

        print(
            f"ERRORE {response.get('code', 'errore')}: "
            f"{response.get('message', 'errore sconosciuto')}",
            file=sys.stderr
        )

        return EXIT_ERROR

    print(format_status(response))

    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(
        asyncio.run(main())
    )
