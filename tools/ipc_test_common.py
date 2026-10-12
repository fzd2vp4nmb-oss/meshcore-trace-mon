"""
tools/ipc_test_common.py

Helper condiviso dai vari script diagnostici tools/test_*.py
(test_ping.py, test_status.py, test_trace.py, test_contact.py,
test_contact_list.py) — code review 2026-08-20, §4.

Prima ognuno di questi script costruiva il proprio IPCClient() e
chiamava .request() senza alcuna gestione di errore attorno: se il
daemon non è in esecuzione (uno scenario tutt'altro che raro per
script pensati proprio per verificarne lo stato — es. subito dopo
l'installazione, o durante un riavvio), ognuno falliva con un
traceback Python grezzo (ConnectionRefusedError se il socket non
esiste/non accetta connessioni, o clients.ipc_client.IPCError in caso
di timeout/risposta malformata) invece di un messaggio leggibile.
Stessa gestione mancante, non scritta identicamente ma assente allo
stesso modo, ripetuta in 5 file diversi — centralizzata qui in
un'unica implementazione.
"""

import sys

from clients.ipc_client import IPCClient, IPCError


async def send_ipc_request(service, command, **kwargs):
    """
    Invia una richiesta IPC al daemon, con gestione uniforme degli
    errori di connessione/timeout. Su errore stampa un messaggio
    leggibile su stderr ed esce con codice 1 — comportamento coerente
    e prevedibile per uno script CLI diagnostico, invece di propagare
    un traceback diverso a seconda di quale symptom si manifesta.

    kwargs viene passato così com'è a IPCClient.request() (es.
    ipc_timeout, o parametri specifici del comando come path/timeout
    per 'trace run').
    """

    client = IPCClient()

    try:
        return await client.request(
            service=service,
            command=command,
            **kwargs
        )

    except IPCError as e:

        print(
            f"ERRORE IPC: {e}",
            file=sys.stderr
        )

        sys.exit(1)

    except (ConnectionRefusedError, FileNotFoundError, OSError) as e:

        print(
            f"ERRORE: impossibile contattare il daemon trace-mon "
            f"({e}) — è in esecuzione?",
            file=sys.stderr
        )

        sys.exit(1)
