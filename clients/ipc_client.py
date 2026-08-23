import asyncio
import json
from pathlib import Path

from core.config import config

#
# Path del socket centralizzato via config (code review 2026-08-20,
# §3.1) — prima hardcoded e duplicato identico qui e in
# services/ipc_server.py, mai reso configurabile via
# 'daemon.socket_path' nonostante ARCHITECTURE.md §8 lo desse per
# previsto. Il default resta invariato.
#
SOCKET_FILE = Path(
    config.get(
        "daemon.socket_path",
        "run/trace-mon.sock"
    )
)

#
# Timeout di default per l'intero scambio IPC (apertura socket + invio
# richiesta + attesa della riga di risposta), usato quando il chiamante
# non specifica un valore più adatto al comando invocato.
#
# Motivazione (v. docs/ARCHITECTURE.md §8, "timeout lato client... per
# non bloccare cron indefinitamente"): senza questo limite, un daemon
# bloccato (es. comando appeso sulla connessione condivisa) o già
# terminato senza ripulire il socket lascia il processo chiamante
# (cron, tool manuale) appeso indefinitamente su reader.readline() —
# con cron che rilancia lo script periodicamente, i processi bloccati
# si accumulano nel tempo (esaurimento fd/memoria sul Raspberry Pi).
#
# Storico: portato da 30s a 90s il 2026-08-21 (Finding 1, review
# affidabilità, ARCHITECTURE.md §49) perché comandi "brevi" (system.
# status/ping/contact, advert, floodadv) condividevano Engine.
# command_lock con BotModule._send_dm_reply() — la risposta DM del bot
# poteva restare titolare del lock fino a 3 tentativi di invio+attesa
# ACK (uno dei quali in flood), mettendo in coda un comando breve ben
# oltre la propria durata "propria".
#
# Riportato a 30s il 2026-08-23: la gestione dei DM è stata rimossa
# del tutto da BotModule (v. ARCHITECTURE.md §54) — l'unico invio
# rimasto, _send_channel_reply()/send_chan_msg(), è un fire-and-forget
# locale (attende solo [OK, ERROR], nessun ACK radio, nessun retry),
# quindi la motivazione originale del margine da 90s non esiste più.
# 30s torna a coprire il solo caso "lock libero, comando realmente
# breve" per cui era stato pensato in origine. Comandi che possono
# legittimamente richiedere molto più tempo (trace con timeout alto,
# neighbor_monitor con retry su repeater irraggiungibile) DEVONO
# comunque passare un ipc_timeout esplicito più ampio — vedi
# mesh_modules/trace/engine.py e mesh_modules/neighbor_monitor/engine.py.
# Engine.acquire_command_lock() resta comunque la rete di sicurezza
# diagnostica per ogni attesa anomala sul lock (log WARNING oltre
# COMMAND_LOCK_WAIT_WARNING_THRESHOLD, v. §49).
#
DEFAULT_IPC_TIMEOUT = 30.0


class IPCError(Exception):
    """Errore di dominio per problemi di comunicazione IPC in sé
    (timeout, connessione rifiutata, risposta vuota o non JSON) —
    distinto da un errore applicativo del servizio invocato, che
    arriva invece regolarmente come {"status": "error", ...}."""


class IPCClient:
    async def request(
        self,
        service,
        command,
        ipc_timeout=DEFAULT_IPC_TIMEOUT,
        **kwargs
    ):
        try:
            return await asyncio.wait_for(
                self._request(service, command, **kwargs),
                timeout=ipc_timeout
            )

        except asyncio.TimeoutError:
            raise IPCError(
                f"Timeout IPC ({ipc_timeout}s) in attesa di risposta "
                f"da '{service}.{command}' — il daemon potrebbe essere "
                "bloccato, sovraccarico o non raggiungibile."
            )

    async def _request(
        self,
        service,
        command,
        **kwargs
    ):
        reader, writer = await asyncio.open_unix_connection(
            str(SOCKET_FILE)
        )

        try:
            request = {
                "version": 1,
                "service": service,
                "command": command
            }

            request.update(kwargs)

            writer.write(
                (
                    json.dumps(request) + "\n"
                ).encode()
            )

            await writer.drain()
            raw = await reader.readline()

            if not raw:
                #
                # EOF senza alcun byte scritto: il server ha chiuso la
                # connessione senza rispondere (es. shutdown del daemon
                # a metà di una richiesta). json.loads("") solleverebbe
                # una JSONDecodeError poco chiara — la trasformiamo in
                # un errore di dominio esplicito.
                #
                raise IPCError(
                    f"Risposta IPC vuota da '{service}.{command}' — "
                    "il daemon ha chiuso la connessione senza "
                    "rispondere (possibile shutdown in corso)."
                )

            try:
                return json.loads(raw.decode())

            except json.JSONDecodeError as exc:
                raise IPCError(
                    f"Risposta IPC non valida da '{service}.{command}': "
                    f"{exc}"
                )

        finally:
            writer.close()
            await writer.wait_closed()
