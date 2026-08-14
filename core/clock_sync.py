"""
core/clock_sync.py

Sincronizzazione dell'orologio del companion MeshCore con quello del
Raspberry — logica condivisa tra services/daemon.py (all'avvio, sulla
connessione già aperta dal daemon) e tools/sync_clock.py (invocazione
manuale standalone, con una propria connessione esclusiva).

Nessun I/O di presentazione qui dentro — né print() né log — il
chiamante riceve un ClockSyncResult e decide come riportarlo
(log.info nel daemon, print colorato nel tool CLI).
"""

import time
from dataclasses import dataclass
from typing import Optional

from meshcore.events import EventType


#
# Sotto questa soglia lo scarto è considerato rumore di misura (round
# trip del comando stesso, arrotondamenti) — stessa soglia già in uso
# nella versione standalone del tool prima di questa estrazione.
#
DRIFT_THRESHOLD_SECS = 5


@dataclass
class ClockSyncResult:

    #
    # False solo per un errore di comunicazione col device (lettura
    # o scrittura fallita) — uno scarto trascurabile che NON richiede
    # sync resta comunque ok=True, synced=False.
    #
    ok: bool

    device_time_before: Optional[int] = None
    local_time: Optional[int] = None
    drift_before: Optional[int] = None

    synced: bool = False
    device_time_after: Optional[int] = None
    drift_after: Optional[int] = None

    error: Optional[str] = None


async def sync_clock(mesh, dry_run=False):
    """
    Legge l'ora del device, la confronta con quella locale, e la
    corregge se lo scarto supera DRIFT_THRESHOLD_SECS secondi.

    dry_run=True legge e riporta lo scarto senza modificare nulla
    (equivalente a --check nel tool CLI).

    Non solleva mai — un fallimento di comunicazione è riportato in
    ClockSyncResult.ok/error, non un'eccezione: il chiamante più
    delicato (il daemon in avvio) non deve mai interrompere lo
    startup per un problema di sync orario.
    """

    get_result = await mesh.commands.get_time()

    if get_result.type == EventType.ERROR:

        return ClockSyncResult(
            ok=False,
            error=f"lettura ora device fallita: {get_result.payload}"
        )

    device_time = get_result.payload["time"]
    local_time = int(time.time())
    drift = local_time - device_time

    result = ClockSyncResult(
        ok=True,
        device_time_before=device_time,
        local_time=local_time,
        drift_before=drift
    )

    if dry_run or abs(drift) < DRIFT_THRESHOLD_SECS:
        return result

    set_result = await mesh.commands.set_time(local_time)

    if set_result.type == EventType.ERROR:

        result.ok = False
        result.error = f"impostazione ora device fallita: {set_result.payload}"

        return result

    #
    # Rilettura per conferma — non ci fidiamo del solo OK locale,
    # stesso principio già applicato altrove nel progetto (un comando
    # accettato localmente non prova che l'effetto desiderato sia
    # avvenuto).
    #
    verify_result = await mesh.commands.get_time()

    if verify_result.type == EventType.ERROR:

        #
        # Il comando di set è stato accettato — synced resta True —
        # solo la verifica successiva è fallita. Diverso da un set
        # fallito vero e proprio (ok=False sopra).
        #
        result.synced = True
        result.error = "sync inviato ma verifica lettura fallita"

        return result

    new_device_time = verify_result.payload["time"]

    result.synced = True
    result.device_time_after = new_device_time
    result.drift_after = int(time.time()) - new_device_time

    return result
