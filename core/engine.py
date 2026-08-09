import asyncio

from meshcore.meshcore import MeshCore
from meshcore.events import EventType

from core.config import config
from core.logger import log


class Engine:
    """
    Gestisce la connessione al Companion MeshCore.

    Il tipo di connessione (TCP, Seriale o BLE) viene determinato
    automaticamente dal file config.yaml.

    Le disconnessioni "pulite" (rilevate dalla libreria) sono gestite
    dall'auto-reconnect nativo di meshcore_py sulla stessa istanza
    MeshCore. Le disconnessioni "silenziose" sono rilevate da un
    health-check attivo periodico (get_bat, query locale al companion,
    nessun traffico radio). reconnect() è protetto da un lock, così
    anche se più trigger lo richiamano in rapida successione, la
    ricreazione effettiva della connessione avviene una sola volta.

    command_lock è un lock CONDIVISO tra tutti i chiamanti (IPCServer,
    BotModule, e qualsiasi futuro consumatore) che devono inviare
    comandi sulla connessione: serializza l'invio, indipendentemente
    da chi lo richiede, per evitare che comandi provenienti da
    percorsi diversi (IPC vs bot event-driven) finiscano per essere
    inviati in concorrenza sulla stessa connessione condivisa.
    """

    def __init__(self):

        self.mesh = None
        self.connection_type = config["connection.type"]

        self.max_reconnect_attempts = config.get(
            "connection.max_reconnect_attempts",
            5
        )

        self.recovery_retry_interval = config.get(
            "connection.recovery_retry_interval",
            30
        )

        self.heartbeat_interval = config.get(
            "connection.heartbeat_interval",
            15
        )

        self.heartbeat_timeout = config.get(
            "connection.heartbeat_timeout",
            5
        )

        self._connected = False
        self._recovery_task = None
        self._heartbeat_task = None

        #
        # Serializza le esecuzioni di reconnect(): se più trigger lo
        # richiamano quasi in contemporanea, solo la prima esegue
        # davvero il lavoro.
        #
        self._reconnect_lock = asyncio.Lock()

        #
        # Serializza l'INVIO di comandi sulla connessione, condiviso
        # tra IPCServer e BotModule (e futuri consumatori). Non va
        # confuso con _reconnect_lock, che protegge la ricreazione
        # della connessione stessa.
        #
        self.command_lock = asyncio.Lock()

        self._rebind_callbacks = []

    @property
    def connected(self):
        return (
            self.mesh is not None and
            self._connected and
            self.mesh.is_connected
        )

    async def connect(self):

        if self.connected:
            return self.mesh

        log.info(
            "Opening %s connection...",
            self.connection_type.upper()
        )

        self.mesh = await self._create_mesh()

        self._subscribe_connection_events()

        self._connected = True

        if self._heartbeat_task is None:
            self._heartbeat_task = asyncio.create_task(
                self._heartbeat_loop()
            )

        log.info(
            "%s connection established.",
            self.connection_type.upper()
        )

        return self.mesh

    async def _create_mesh(self):

        common_kwargs = dict(
            debug=False,
            only_error=False,
            auto_reconnect=True,
            max_reconnect_attempts=self.max_reconnect_attempts
        )

        if self.connection_type == "tcp":

            return await MeshCore.create_tcp(
                host=config["connection.tcp.host"],
                port=config["connection.tcp.port"],
                **common_kwargs
            )

        elif self.connection_type == "serial":

            return await MeshCore.create_serial(
                port=config["connection.serial.device"],
                baudrate=config["connection.serial.baudrate"],
                **common_kwargs
            )

        elif self.connection_type == "ble":

            return await MeshCore.create_ble(
                address=config["connection.ble.address"],
                **common_kwargs
            )

        else:

            raise RuntimeError(
                f"Tipo di connessione non supportato: {self.connection_type}"
            )

    def _subscribe_connection_events(self):

        self.mesh.subscribe(
            EventType.CONNECTED,
            self._on_connected
        )

        self.mesh.subscribe(
            EventType.DISCONNECTED,
            self._on_disconnected
        )

    async def _on_connected(self, event):

        self._connected = True

        if event.payload.get("reconnected"):
            log.info(
                "MeshCore connection restored (auto-reconnect)."
            )
        else:
            log.info(
                "MeshCore CONNECTED event received."
            )

    async def _on_disconnected(self, event):

        self._connected = False

        log.warning(
            "MeshCore connection lost (reason=%s).",
            event.payload.get("reason")
        )

        if event.payload.get("max_attempts_exceeded"):

            log.error(
                "Auto-reconnect exhausted its attempts. "
                "Starting manual recovery loop."
            )

            self._start_recovery_loop()

    async def _heartbeat_loop(self):

        while True:

            await asyncio.sleep(self.heartbeat_interval)

            await self._run_heartbeat_check()

    async def _run_heartbeat_check(self):

        if self.mesh is None:
            return

        if (
            self._recovery_task is not None and
            not self._recovery_task.done()
        ):
            return

        try:
            #
            # NON avvolto in command_lock, a differenza di ogni
            # altro comando sulla connessione — scelta deliberata,
            # non una svista. command_lock non ha timeout
            # sull'acquisizione: se un altro comando è bloccato in
            # attesa di risposta da un device già silenziosamente
            # disconnesso (lo scenario stesso che l'heartbeat deve
            # rilevare), tiene il lock indefinitamente. Se
            # l'heartbeat dovesse aspettare lo stesso lock, non
            # scatterebbe mai il recovery — il wait_for(timeout=...)
            # qui sotto protegge solo la singola chiamata, non
            # l'attesa del lock. L'heartbeat deve poter verificare la
            # connessione indipendentemente da cosa sta bloccando
            # altrove, quindi ha priorità sul resto.
            #
            result = await asyncio.wait_for(
                self.mesh.commands.get_bat(),
                timeout=self.heartbeat_timeout
            )

            if result.type == EventType.ERROR:
                raise RuntimeError(
                    f"heartbeat error: {result.payload}"
                )

            self._connected = True

        except Exception as e:

            log.warning(
                "Heartbeat: il device non risponde (%s). "
                "Connessione considerata caduta.",
                e
            )

            self._connected = False

            self._start_recovery_loop()

    def report_possible_failure(self):
        asyncio.create_task(
            self._run_heartbeat_check()
        )

    def register_rebind(self, callback):
        if callback not in self._rebind_callbacks:
            self._rebind_callbacks.append(callback)

    def unregister_rebind(self, callback):
        if callback in self._rebind_callbacks:
            self._rebind_callbacks.remove(callback)

    def _start_recovery_loop(self):

        if (
            self._recovery_task is not None and
            not self._recovery_task.done()
        ):
            return

        self._recovery_task = asyncio.create_task(
            self._recovery_loop()
        )

    async def _recovery_loop(self):

        while not self.connected:

            log.info(
                "Recovery: retrying full reconnect in %ss...",
                self.recovery_retry_interval
            )

            await asyncio.sleep(
                self.recovery_retry_interval
            )

            try:
                await self.reconnect()

            except Exception:
                log.exception(
                    "Recovery: reconnect attempt failed."
                )

        log.info(
            "Recovery: connection restored."
        )

    async def _teardown_mesh(self):

        if self.mesh is None:
            return

        try:
            await self.mesh.disconnect()

        finally:
            self.mesh = None
            self._connected = False

    async def disconnect(self):

        if self._recovery_task is not None:
            self._recovery_task.cancel()
            self._recovery_task = None

        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None

        log.info("Closing MeshCore connection...")

        await self._teardown_mesh()

    async def reconnect(self):
        """
        Ricrea completamente la connessione MeshCore. Protetto da
        lock: se un'altra chiamata concorrente ha già ripristinato
        la connessione mentre eravamo in attesa del lock, non fa
        nulla.
        """

        async with self._reconnect_lock:

            if self.connected:
                log.info(
                    "Reconnect: connessione già ripristinata da "
                    "un'altra chiamata concorrente, nessuna azione."
                )
                return self.mesh

            log.warning(
                "MeshCore full reconnect requested."
            )

            await self._teardown_mesh()

            self.mesh = await self._create_mesh()

            self._subscribe_connection_events()

            self._connected = True

            log.info(
                "Rebinding %d module(s)...",
                len(self._rebind_callbacks)
            )

            for callback in list(self._rebind_callbacks):

                try:
                    callback(self.mesh)

                except Exception:

                    log.exception(
                        "Module rebind failed."
                    )

            return self.mesh
