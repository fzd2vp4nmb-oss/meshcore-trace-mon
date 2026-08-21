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
        # Riferimenti ai task "fire-and-forget" creati da
        # report_possible_failure() (code review 2026-08-20, §3.1) —
        # asyncio non garantisce che un task senza riferimenti
        # sopravviva fino al completamento (rischio di garbage
        # collection imprevedibile, sconsigliato esplicitamente dalla
        # documentazione asyncio). Il set si autopulisce a fine task.
        #
        self._background_tasks = set()

        #
        # Flag impostato ESCLUSIVAMENTE da disconnect() (mai da
        # _teardown_mesh(), condiviso anche con reconnect() di
        # routine — un reconnect() di routine deve poter continuare a
        # far ripartire il recovery normalmente). Impedisce in modo
        # sincrono, indipendentemente da come lo scheduler asyncio
        # interfoglia i task, che un _start_recovery_loop() chiamato
        # DOPO che disconnect() ha già dichiarato concluso il proprio
        # lavoro possa comunque creare un nuovo _recovery_task
        # orfano — race concreta tra un task in background avviato da
        # report_possible_failure() (es. trace.py/bot.py/advert.py su
        # un comando fallito) e uno shutdown in corso: cancellare e
        # attendere i task esistenti (vedi disconnect()) chiude il
        # caso comune, ma non basta da solo a coprire ogni possibile
        # timing di consegna della cancellazione.
        #
        self._shutting_down = False

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

        #
        # Chiavi pubbliche verso cui è in corso una sessione CLI
        # (login+comandi, vedi NeighborMonitorModule._query_cli_config).
        # Le risposte in arrivo da queste chiavi condividono lo stesso
        # evento CONTACT_MSG_RECV delle DM vere — non c'è modo di
        # distinguerle a livello di protocollo. Un repeater non avvia
        # mai una DM legittima verso il bot di sua iniziativa (solo i
        # device chat lo fanno): se la chiave è qui dentro, la
        # risposta è certamente per neighbor_monitor, non per il bot.
        # Vedi BotModule._on_contact_message().
        #
        self.active_cli_sessions = set()

    def mark_cli_session_active(self, public_key):
        self.active_cli_sessions.add(public_key)

    def mark_cli_session_done(self, public_key):
        self.active_cli_sessions.discard(public_key)

    @property
    def connected(self):
        return (
            self.mesh is not None and
            self._connected and
            self.mesh.is_connected
        )

    async def connect(self):

        #
        # Protetto dallo stesso _reconnect_lock di reconnect() (code
        # review 2026-08-20, §4) — prima connect() non acquisiva
        # alcun lock, a differenza di reconnect(): un avvio (connect())
        # che si sovrapponesse a un ciclo di recovery già in corso
        # (reconnect(), es. triggerato da un heartbeat fallito
        # arrivato a ridosso dell'avvio) avrebbe potuto far eseguire
        # _create_mesh() due volte in concorrenza, con due connessioni
        # MeshCore create ma solo una tracciata in self.mesh (l'altra
        # persa, mai chiusa). Il controllo "if self.connected" resta
        # fuori dal lock come fast-path per il caso comune (già
        # connesso, nessuna contesa) — solo il percorso che crea
        # davvero la connessione è serializzato.
        #
        if self.connected:
            return self.mesh

        async with self._reconnect_lock:

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

    #
    # Timeout attorno all'intera creazione/apertura della connessione
    # (code review 2026-08-20, Rev.6, §4 — verificato leggendo il
    # sorgente di meshcore_py, non assunto): MeshCore.create_tcp()/
    # create_ble() delegano l'apertura del socket/canale a
    # TCPConnection.connect()/BLEConnection.connect(), NESSUNO dei due
    # ha un proprio timeout (loop.create_connection()/BleakClient.connect()
    # chiamati senza alcun asyncio.wait_for) — un host irraggiungibile
    # che non rifiuta subito la connessione (es. firewall che scarta i
    # pacchetti invece di rispondere RST) può bloccare questa chiamata
    # indefinitamente. Solo create_serial() ha un timeout proprio
    # (10.0s di default, in SerialConnection.connect()). Dopo l'apertura
    # del trasporto, l'handshake applicativo (send_appstart(), dentro
    # MeshCore.connect()) ha comunque un timeout proprio di libreria
    # (CommandHandler.DEFAULT_TIMEOUT = 15.0s) — questo wrapper deve
    # quindi restare più ampio di 15s per non tagliare un handshake
    # lento ma legittimo. 30s scelto per coerenza con
    # DEFAULT_IPC_TIMEOUT già usato altrove nel progetto per operazioni
    # di rete senza un valore più specifico (clients/ipc_client.py).
    # Protegge sia connect() (avvio) sia reconnect() (recovery loop),
    # che condividono entrambi questo stesso metodo.
    #
    CREATE_MESH_TIMEOUT = 30.0

    async def _create_mesh(self):

        common_kwargs = dict(
            debug=False,
            only_error=False,
            auto_reconnect=True,
            max_reconnect_attempts=self.max_reconnect_attempts
        )

        if self.connection_type == "tcp":

            coro = MeshCore.create_tcp(
                host=config["connection.tcp.host"],
                port=config["connection.tcp.port"],
                **common_kwargs
            )

        elif self.connection_type == "serial":

            coro = MeshCore.create_serial(
                port=config["connection.serial.device"],
                baudrate=config["connection.serial.baudrate"],
                **common_kwargs
            )

        elif self.connection_type == "ble":

            coro = MeshCore.create_ble(
                address=config["connection.ble.address"],
                **common_kwargs
            )

        else:

            raise RuntimeError(
                f"Tipo di connessione non supportato: {self.connection_type}"
            )

        try:
            return await asyncio.wait_for(
                coro,
                timeout=self.CREATE_MESH_TIMEOUT
            )

        except asyncio.TimeoutError:

            log.error(
                "Apertura connessione %s: nessuna risposta entro %ss, "
                "abbandono il tentativo (verrà ritentato dal recovery "
                "loop se in corso).",
                self.connection_type.upper(),
                self.CREATE_MESH_TIMEOUT
            )

            raise

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
        task = asyncio.create_task(
            self._run_heartbeat_check()
        )

        self._background_tasks.add(task)
        task.add_done_callback(
            self._background_tasks.discard
        )

    def register_rebind(self, callback):
        if callback not in self._rebind_callbacks:
            self._rebind_callbacks.append(callback)

    def unregister_rebind(self, callback):
        if callback in self._rebind_callbacks:
            self._rebind_callbacks.remove(callback)

    def _start_recovery_loop(self):

        #
        # Controllo sincrono, primo statement: blocca l'avvio di un
        # nuovo recovery loop se disconnect() è già in corso o
        # concluso, indipendentemente da CHI chiama questo metodo o
        # da QUANDO arriva la chiamata rispetto alla cancellazione
        # dei task esistenti (vedi commento su self._shutting_down in
        # __init__). Non dipende dal fatto che una CancelledError
        # venga consegnata in tempo.
        #
        if self._shutting_down:
            log.info(
                "Recovery loop ignorato: shutdown già in corso."
            )
            return

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

        #
        # Prima di questo fix (code review 2026-08-20, §3.1),
        # .cancel() veniva chiamato senza mai attendere l'effettiva
        # terminazione dei task prima di procedere con
        # _teardown_mesh(): una race concreta era possibile tra lo
        # shutdown pulito e un tentativo di riconnessione ancora in
        # volo nella finestra tra cancel() e la terminazione
        # effettiva del task (es. _recovery_loop() nel mezzo di un
        # self.reconnect() quando arriva la cancellazione).
        # CancelledError è l'esito atteso qui, non un errore.
        #
        # Impostato per PRIMA cosa, prima di ogni cancellazione (fix
        # successivo a Rev.6, code review 2026-08-20 — vedi
        # ARCHITECTURE.md §30): self._recovery_task/
        # self._heartbeat_task NON sono gli unici task che possono
        # chiamare _start_recovery_loop(). report_possible_failure()
        # (chiamato da trace.py/bot.py/advert.py su un comando
        # fallito) avvia un _run_heartbeat_check() "fire-and-forget"
        # tracciato in self._background_tasks: se fallisce DOPO che
        # disconnect() ha già cancellato/atteso i task noti a quel
        # momento, il suo except Exception chiamerebbe comunque
        # _start_recovery_loop(), creando un _recovery_task orfano
        # che riconnette realmente il device dopo che il daemon
        # crede lo shutdown concluso. Solo disconnect() imposta
        # questo flag — MAI _teardown_mesh(), condiviso con
        # reconnect() di routine, che deve continuare a poter
        # riavviare il recovery normalmente.
        #
        self._shutting_down = True

        tasks_to_await = []

        if self._recovery_task is not None:
            self._recovery_task.cancel()
            tasks_to_await.append(self._recovery_task)
            self._recovery_task = None

        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            tasks_to_await.append(self._heartbeat_task)
            self._heartbeat_task = None

        #
        # Stessa cancellazione anche per i task "fire-and-forget" di
        # report_possible_failure() (fix successivo a Rev.6, code
        # review 2026-08-20 — vedi ARCHITECTURE.md §30) — chiude il
        # caso comune (task ancora in sospensione quando
        # arriva disconnect()); il flag self._shutting_down sopra
        # copre invece il caso in cui uno di questi task sia già
        # oltre il proprio await e stia per richiamare
        # _start_recovery_loop() indipendentemente da questa
        # cancellazione.
        #
        for task in list(self._background_tasks):
            task.cancel()
            tasks_to_await.append(task)

        if tasks_to_await:
            await asyncio.gather(
                *tasks_to_await,
                return_exceptions=True
            )

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
