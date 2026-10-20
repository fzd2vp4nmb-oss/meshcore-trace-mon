#!/home/meshcore/trace-mon/.venv/bin/python3

"""
tools/send_sonar.py

Chiede al daemon di trasmettere UN messaggio sonar sul canale dedicato
(docs/ARCHITECTURE.md §87). Invocato da sonar.sh (crontab); utilizzabile
anche a mano.

Il daemon è l'unico proprietario del device: questo script parla SOLO
con l'IPC (servizio 'sonar', comando 'send'), non apre mai la
connessione al companion. Progressivo, scope, guardia sull'intervallo
minimo e registrazione dell'esito sono tutti lato daemon.

Uso:
    tools/send_sonar.py                 scope di sonar.tx.scope
    tools/send_sonar.py --scope U       unscoped forzato   (anche '*')
    tools/send_sonar.py --scope D       default del device (anche '')
    tools/send_sonar.py --scope lombardia   regione

Codici di uscita (sonar.sh li interpreta):
    0   messaggio accettato dal companion
    10  nessun invio PERCHÉ ATTESO, non è un errore: troppo presto
        rispetto a sonar.tx.min_interval, oppure trasmissione
        disabilitata (sonar.tx.enabled=false)
    1   errore (daemon non raggiungibile, device non disponibile,
        canale non utilizzabile, invio fallito o dall'esito incerto)
    2   argomenti non validi

Una riga di esito su stdout (0/10) o stderr (1):
    OK seq=<n> scope=<tag> canale=<nome>
    SKIP <codice>: <motivo>
    ERRORE <codice>: <motivo>
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

from mesh_modules.sonar.protocol import normalize_scope
from tools.ipc_test_common import send_ipc_request

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_SKIPPED = 10

#
# Esiti attesi che non sono un errore (v. docstring del modulo).
#
SKIP_CODES = ("too_soon", "tx_disabled")

#
# Margine IPC: il comando può comprendere verifica del canale, set
# dello scope, invio e ripristino, ciascuno con il timeout (15 s)
# della libreria, più l'eventuale attesa del command_lock. Il default
# del client (30 s) non basta nel caso peggiore.
#
IPC_TIMEOUT = 120.0


def build_parser():

    parser = argparse.ArgumentParser(
        description="Trasmette un messaggio sonar sul canale dedicato."
    )

    parser.add_argument(
        "--scope",
        default=None,
        help="scope dell'invio: '*' o U (unscoped), '' o D (default "
             "del device), oppure un nome di regione. Se omesso: "
             "sonar.tx.scope.",
    )

    return parser


async def main(argv=None):

    parser = build_parser()

    args = parser.parse_args(argv)

    if args.scope is not None:

        #
        # Validazione anticipata (la stessa funzione del daemon): un
        # errore di scrittura nel crontab si vede subito, senza
        # nemmeno contattare il daemon.
        #
        try:
            normalize_scope(args.scope)

        except ValueError as exc:
            parser.error(str(exc))

    kwargs = {"ipc_timeout": IPC_TIMEOUT}

    if args.scope is not None:
        kwargs["scope"] = args.scope

    response = await send_ipc_request("sonar", "send", **kwargs)

    if response.get("status") == "ok":

        print(
            f"OK seq={response.get('seq')} "
            f"scope={response.get('scope_tag')} "
            f"canale={response.get('channel')}"
        )

        return EXIT_OK

    code = response.get("code", "errore")
    message = response.get("message", "errore sconosciuto")

    if code in SKIP_CODES:

        print(f"SKIP {code}: {message}")

        return EXIT_SKIPPED

    seq = response.get("seq")

    print(
        f"ERRORE {code}{f' (seq={seq})' if seq is not None else ''}: "
        f"{message}",
        file=sys.stderr
    )

    return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(
        asyncio.run(main())
    )
