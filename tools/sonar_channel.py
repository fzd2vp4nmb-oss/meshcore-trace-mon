#!/home/meshcore/trace-mon/.venv/bin/python3

"""
tools/sonar_channel.py

Verifica, crea e consulta il canale dedicato del sonar sul companion
(docs/ARCHITECTURE.md §87), tramite il daemon (servizio 'sonar',
comando 'ensure_channel'): come ogni strumento di trace-mon NON apre
la connessione al device, che appartiene al daemon. Richiede quindi il
daemon in esecuzione e il servizio 'sonar' abilitato (config.sh, menu
Servizi).

Uso tipico — l'AMMINISTRATORE genera la chiave UNA volta per tutta la
rete (crea il canale sul proprio nodo e ricava la chiave):

    tools/sonar_channel.py --create --show-secret --save-config

  cerca il canale 'sonar.channel_name' (default TM-Sonar); se manca lo
  crea in uno slot libero con un segreto casuale (16 byte); scrive il
  segreto in config/config.yaml (sonar.channel_secret) e, con
  --show-secret, lo mostra: quel valore va scritto UNA volta nel
  TEMPLATE (config/config.yaml.template, riga sonar.channel_secret),
  da cui arriva a tutti i nodi (nuovi: setup.sh; già installati:
  config.sh, voce "Allinea al template"). Senza --show-secret il
  segreto viene salvato ma NON stampato: si rivela solo su richiesta
  esplicita. Un canale già esistente con lo stesso nome non viene mai
  sovrascritto.

Tutti gli altri nodi: la chiave è già nel loro config.yaml (dal
template) e basta il servizio abilitato — il daemon crea il canale da
solo all'avvio, con quel segreto, se manca sul companion. Questo
strumento serve solo per verificarlo:

    tools/sonar_channel.py              (solo verifica, non scrive nulla
                                         sul device)

Opzioni:
    --create        crea il canale se manca (segreto configurato, o
                    generato se non ce n'è uno)
    --show-secret   stampa il segreto del canale (esadecimale). È il
                    segreto condiviso: trattarlo come riservato
    --save-config   scrive il segreto in config/config.yaml
                    (sonar.channel_secret) se lì è vuoto/non impostato;
                    non sovrascrive mai un segreto diverso. Implica la
                    lettura del segreto. Il daemon va riavviato per
                    rileggere la configurazione.

Codici di uscita: 0 ok, 1 errore, 2 argomenti non validi.
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
import re

from tools.ipc_test_common import send_ipc_request

EXIT_OK = 0
EXIT_ERROR = 1

#
# Scansione degli slot + eventuale creazione + verifica: ciascun
# comando verso il device ha il timeout (15 s) della libreria.
#
IPC_TIMEOUT = 90.0

CONFIG_KEY = "sonar.channel_secret"

_PLACEHOLDER_RE = re.compile(r"^__[A-Z0-9_]+__$")


def build_parser():

    parser = argparse.ArgumentParser(
        description="Verifica/crea il canale dedicato del sonar sul "
                    "companion e ne ricava il segreto."
    )

    parser.add_argument(
        "--create",
        action="store_true",
        help="crea il canale se manca (segreto configurato, o generato)",
    )

    parser.add_argument(
        "--show-secret",
        action="store_true",
        help="stampa il segreto del canale (esadecimale, RISERVATO)",
    )

    parser.add_argument(
        "--save-config",
        action="store_true",
        help="scrive il segreto in config/config.yaml "
             "(sonar.channel_secret) se non ancora impostato",
    )

    return parser


def save_secret_to_config(secret_hex):
    """
    Scrive il segreto in config/config.yaml con le stesse funzioni di
    tools/edit_config.py (backup con timestamp, scrittura atomica,
    validazione, permessi 0600) — nessuna scrittura alternativa del
    file di configurazione. Non sovrascrive mai un segreto diverso già
    presente. Ritorna (esito, messaggio).
    """

    from tools import edit_config

    if not edit_config.CONFIG_PATH.exists():
        return False, (
            f"{edit_config.CONFIG_PATH} non trovato (eseguire lo "
            f"strumento dalla directory di installazione)"
        )

    data = edit_config.load_config()

    current = edit_config.get_path(data, CONFIG_KEY)

    if isinstance(current, str):
        current = current.strip()

    unset = (
        current is None
        or current == ""
        or (isinstance(current, str) and _PLACEHOLDER_RE.match(current))
    )

    if not unset:

        if isinstance(current, str) and current.lower() == secret_hex.lower():
            return True, f"{CONFIG_KEY} già impostato allo stesso valore"

        return False, (
            f"{CONFIG_KEY} contiene già un segreto DIVERSO da quello del "
            f"canale: non viene sovrascritto (correggerlo a mano con "
            f"config.sh se è quello sbagliato)"
        )

    backup_path = edit_config.backup_config()

    edit_config.set_path(data, CONFIG_KEY, secret_hex)

    edit_config.save_config(data, backup_path)

    return True, f"{CONFIG_KEY} scritto in {edit_config.CONFIG_PATH}"


async def main(argv=None):

    args = build_parser().parse_args(argv)

    reveal = args.show_secret or args.save_config

    response = await send_ipc_request(
        "sonar",
        "ensure_channel",
        create=args.create,
        reveal_secret=reveal,
        ipc_timeout=IPC_TIMEOUT
    )

    if response.get("status") != "ok":

        print(
            f"ERRORE {response.get('code', 'errore')}: "
            f"{response.get('message', 'errore sconosciuto')}",
            file=sys.stderr
        )

        return EXIT_ERROR

    print(
        f"Canale '{response.get('channel_name')}': slot "
        f"{response.get('channel_idx')}, hash "
        f"{response.get('channel_hash')} — "
        f"{'CREATO ora' if response.get('created') else 'già presente'}."
    )

    secret = response.get("channel_secret")

    if args.show_secret and secret:

        print()
        print(f"Segreto del canale (esadecimale, RISERVATO): {secret}")
        print(
            "Da scrivere (una volta) in config/config.yaml.template, riga "
            "sonar.channel_secret: arriva da lì a tutti i nodi."
        )

    if args.save_config:

        if not secret:

            print(
                "ERRORE: il daemon non ha restituito il segreto.",
                file=sys.stderr
            )

            return EXIT_ERROR

        ok, message = save_secret_to_config(secret)

        print()
        print(message if ok else f"ERRORE: {message}",
              file=None if ok else sys.stderr)

        if not ok:
            return EXIT_ERROR

        print(
            "Riavviare il daemon (sudo systemctl restart trace-mon) per "
            "rileggere la configurazione."
        )

    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(
        asyncio.run(main())
    )
