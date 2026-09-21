#!/home/meshcore/trace-mon/.venv/bin/python3

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

import asyncio
import signal
import time

from meshcore.events import EventType

from core import clock_reboot
from core.engine import Engine
from core.clock_sync import sync_clock
from core.clock_reboot import ClockRebootGuard
from core.config import config
from core.logger import log
from services.context import ServiceContext
from services.dispatcher import Dispatcher
from services.ipc_server import IPCServer
from services.loader import ServiceLoader


class ClockRebootReconnectError(RuntimeError):
    """
    Il companion, riavviato dal daemon per riallineare l'orologio
    (§79), non è tornato raggiungibile entro il timeout. L'UNICA
    eccezione che _sync_clock_at_startup() lascia uscire da start().
    """


class MeshCoreDaemon:
    """
    Processo residente proprietario della connessione MeshCore.

    Responsabilità:

        - mantiene aperta la connessione MeshCore
        - carica dinamicamente i servizi
        - gestisce il Dispatcher
        - gestisce il server IPC

    Il daemon non conosce alcun servizio applicativo.
    """

    def __init__(self):

        #
        # Engine
        #
        self.engine = Engine()

        #
        # Dispatcher
        #
        self.dispatcher = Dispatcher()

        #
        # Server IPC — usa il command_lock condiviso di Engine
        #
        self.ipc = IPCServer(
            self.dispatcher,
            self.engine
        )

        #
        # Shutdown event
        #
        self._shutdown = asyncio.Event()

        #
        # Esito di _check_ntp_sync() (True/False/None=sconosciuto),
        # conservato perché il riavvio automatico del companion per il
        # clock sync (_auto_reboot_for_clock, ARCHITECTURE.md §79) lo
        # richiede: solo con l'orologio del Raspberry sincronizzato
        # "device avanti" significa davvero "device avanti". Non
        # rilevato = None = niente riavvio automatico.
        #
        self._ntp_synchronized = None

        #
        # ClockRebootGuard, creato al primo uso da _get_clock_guard()
        # (legge daemon.clock_auto_reboot.* dalla configurazione).
        #
        self._clock_guard = None

    async def start(self):
        """
        Avvio del daemon.
        """

        log.info("Starting MeshCore daemon...")

        #
        # Controllo NTP — il sync dell'orologio del companion, subito
        # dopo la connessione, presuppone che l'orologio di QUESTO
        # Raspberry sia corretto: se non lo è, gli propaghiamo noi un
        # errore invece di correggerlo. Va prima di qualunque sync
        # verso il device, quindi è il primo passo in assoluto. L'esito
        # è conservato: il riavvio automatico del device per il clock
        # sync (§79) è consentito solo con NTP sincronizzato.
        #
        self._ntp_synchronized = await self._check_ntp_sync()

        #
        # Connessione MeshCore
        #
        await self.engine.connect()

        log.info(
            "MeshCore connection established (%s).",
            self.engine.connection_type.upper()
        )

        #
        # Sync orologio del companion — un riavvio del DEVICE (non
        # del daemon) gli fa perdere il conteggio orario; prima si
        # correggeva a mano con tools/sync_clock.py, che richiedeva
        # il daemon fermo per avere la connessione libera. Qui gira
        # sulla connessione già aperta da questo stesso daemon,
        # quindi ad ogni riavvio del SERVIZIO — anche quando il
        # device non si è mai spento e non ne avrebbe bisogno, nel
        # qual caso non fa nulla oltre a leggere l'ora e verificare
        # che lo scarto sia trascurabile.
        #
        # Con il device AVANTI (che il firmware non permette di
        # correggere con set_time) può anche riavviare il companion
        # e ripetere il sync, con i freni anti-loop di
        # core/clock_reboot.py (§79). Avviene qui, PRIMA di caricare i
        # servizi e di aprire l'IPC: nessun altro sta usando la
        # connessione, che il riavvio del device interrompe e che
        # viene ricreata (Engine.reconnect(force=True)) prima di
        # proseguire.
        #
        await self._sync_clock_at_startup()

        #
        # Un SIGTERM/SIGINT arrivato durante l'eventuale procedura di
        # riavvio del device (attese di decine di secondi) ferma
        # l'avvio qui: main() esegue comunque daemon.stop() nel finally.
        #
        if self._shutdown.is_set():

            log.info(
                "Arresto richiesto durante l'avvio: servizi e IPC non "
                "vengono avviati."
            )

            return

        #
        # Contesto condiviso
        #
        context = ServiceContext(
            engine=self.engine,
            dispatcher=self.dispatcher
        )

        #
        # Caricamento dinamico servizi
        #
        loader = ServiceLoader(
            dispatcher=self.dispatcher,
            context=context
        )

        loader.load()

        #
        # Avvio IPC
        #
        await self.ipc.start()

        log.info("IPC Server started.")

        #
        # Rimane residente
        #
        await self._shutdown.wait()

    async def _check_ntp_sync(self):
        """
        Controllo leggero, mai bloccante — un problema qui viene solo
        loggato, mai un motivo per fermare l'avvio (stesso principio
        di _sync_clock_at_startup più sotto).

        Ritorna True (sincronizzato), False (NON sincronizzato) o None
        (sconosciuto: timedatectl assente/lento/in errore/risposta
        inattesa). L'esito serve a _auto_reboot_for_clock() (§79), che
        procede solo con True. Prima di §79 non ritornava nulla e
        nessun chiamante ne usava il valore.

        timedatectl è lo stesso meccanismo sia con systemd-timesyncd
        sia con chrony su Raspberry Pi OS/Debian — nessun bisogno di
        distinguerli. Se proprio non disponibile, lo stato resta
        "sconosciuto" (solo loggato): niente euristiche via file di
        stato, meno affidabili di una risposta diretta e non ne vale
        la complessità per un controllo di questo peso.
        """

        try:
            proc = await asyncio.create_subprocess_exec(
                "timedatectl", "show", "-p", "NTPSynchronized", "--value",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            try:
                stdout, _ = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=5
                )

            except asyncio.TimeoutError:

                #
                # wait_for() interrompe solo l'ATTESA, non il
                # processo sottostante — senza kill()+wait()
                # espliciti resterebbe uno zombie. Scoperto con un
                # test mirato (comando che non risponde mai), non
                # solo per teoria.
                #
                proc.kill()
                await proc.wait()

                raise

            if proc.returncode != 0:

                log.warning(
                    "NTP: impossibile verificare lo stato di "
                    "sincronizzazione (timedatectl ha risposto con "
                    "errore, exit code %d) — stato sconosciuto, "
                    "proseguo comunque.",
                    proc.returncode
                )

                return None

            output = stdout.decode().strip()

        except (OSError, asyncio.TimeoutError):

            log.warning(
                "NTP: impossibile verificare lo stato di "
                "sincronizzazione (timedatectl non disponibile o "
                "troppo lento) — stato sconosciuto, proseguo "
                "comunque."
            )

            return None

        if output == "yes":

            log.info(
                "NTP: orologio di sistema sincronizzato."
            )

            return True

        if output == "no":

            log.warning(
                "NTP: orologio di sistema NON sincronizzato — il "
                "sync verso il companion userà comunque quest'ora, "
                "potenzialmente propagando un errore invece di "
                "correggerlo."
            )

            return False

        log.warning(
            "NTP: risposta inattesa da timedatectl ('%s'), stato "
            "sincronizzazione sconosciuto.",
            output
        )

        return None

    async def _run_clock_sync(self, label, context):
        """
        Esegue sync_clock() sulla connessione CORRENTE dell'Engine
        (self.engine.mesh è riletto ad ogni chiamata: dopo un riavvio
        del device è la connessione nuova) sotto command_lock.
        Ritorna il ClockSyncResult, oppure None se è successa
        un'eccezione imprevista (già loggata con `context`).
        """

        try:
            # acquire_command_lock() invece dell'accesso diretto al
            # lock (Finding 1/5, review affidabilità 2026-08-21 — v.
            # ARCHITECTURE.md §49), per coerenza con ogni altro punto
            # di produzione che invia un comando sulla connessione
            # condivisa.
            async with self.engine.acquire_command_lock(label):
                return await sync_clock(self.engine.mesh)

        except Exception:

            log.exception(
                "%s: errore imprevisto, proseguo comunque con "
                "l'avvio.",
                context
            )

            return None

    async def _sync_clock_at_startup(self):
        """
        Non solleva mai (con una sola eccezione voluta, in
        _auto_reboot_for_clock(): connessione non ripristinabile dopo
        un riavvio del device comandato dal daemon) — un problema di
        sync orario non deve impedire l'avvio del resto del daemon,
        viene solo loggato.

        Device AVANTI del Raspberry (result.device_ahead): warning
        dedicato, non il generico "fallito" — il firmware del
        companion accetta l'impostazione dell'ora solo in avanti
        (ERR_CODE_ILLEGAL_ARG altrimenti), quindi sync_clock() non
        invia nemmeno il comando. V. docs/ARCHITECTURE.md §78. Subito
        dopo, _auto_reboot_for_clock() (§79) decide se riavviare il
        device per riallineare l'orologio.
        """

        result = await self._run_clock_sync(
            "daemon:clock_sync_startup",
            "Clock sync all'avvio"
        )

        if result is None:
            return

        if not result.ok:

            log.warning(
                "Clock sync all'avvio fallito: %s",
                result.error
            )

            return

        if result.device_ahead:

            #
            # drift_before = ora Raspberry - ora device: qui è
            # negativo (device avanti), lo riportiamo come anticipo
            # positivo. Warning e non info: uno scarto >= soglia che
            # non possiamo correggere con set_time è una condizione
            # che chi gestisce il nodo deve poter vedere. L'ultima
            # frase copre il caso in cui sia il Raspberry a essere
            # indietro (NTP non sincronizzato, v. _check_ntp_sync())
            # invece del device ad essere avanti.
            #
            ahead_secs = -result.drift_before

            log.warning(
                "Clock sync: il device è in anticipo di %ds rispetto al "
                "Raspberry — il firmware del companion accetta "
                "l'impostazione dell'ora solo in avanti, quindi il "
                "comando non è stato inviato: l'orologio del device si "
                "riallinea solo con un suo riavvio. Se l'orologio del "
                "Raspberry non è sincronizzato via NTP, potrebbe "
                "essere il Raspberry a essere indietro.",
                ahead_secs
            )

            await self._auto_reboot_for_clock(ahead_secs)

            return

        #
        # Da qui il device è allineato (o è stato appena corretto in
        # avanti): un eventuale freno del riavvio automatico rimasto
        # da un tentativo precedente non ha più motivo di restare.
        #
        self._note_clock_aligned()

        if not result.synced:

            log.info(
                "Clock sync: device già allineato (scarto %+ds), "
                "nessuna correzione necessaria.",
                result.drift_before
            )

            return

        if result.drift_after is None:

            log.warning(
                "Clock sync: %s",
                result.error
            )

            return

        log.info(
            "Clock sync: corretto uno scarto di %+ds (residuo dopo "
            "la sincronizzazione: %+ds).",
            result.drift_before,
            result.drift_after
        )

    # ------------------------------------------------------------------
    # Riavvio automatico del companion per riallineare l'orologio (§79)
    # ------------------------------------------------------------------

    #
    # Tentativi del secondo sync dopo il riavvio del device (solo se
    # il sync ritorna ok=False, es. una lettura andata a vuoto mentre
    # il device sta ancora finendo l'avvio), a distanza di
    # clock_auto_reboot.reconnect_retry_secs. Non è configurabile:
    # non cambia la sicurezza (il conteggio dei riavvii sta nel
    # guard), solo la robustezza del singolo tentativo.
    #
    CLOCK_RESYNC_ATTEMPTS = 3

    def _get_clock_guard(self):
        """
        ClockRebootGuard creato al primo uso da daemon.clock_auto_reboot.*
        (default a livello di codice, deliberatamente assenti dal
        template — v. core/clock_reboot.py). Valori di configurazione
        non validi: warning una volta sola, mai un'eccezione.
        """

        if self._clock_guard is None:

            guard = ClockRebootGuard.from_config(config)

            for warning in guard.config_warnings:

                log.warning(
                    "Riavvio automatico per il clock sync: %s",
                    warning
                )

            self._clock_guard = guard

        return self._clock_guard

    def _note_clock_aligned(self):
        """
        Non solleva mai. Con il riavvio automatico abilitato, azzera il
        contatore dei tentativi falliti se un sync all'avvio trova il
        device allineato (ClockRebootGuard.note_startup_aligned()).
        Disabilitato in configurazione: non tocca il file di stato.
        """

        try:

            guard = self._get_clock_guard()

            if guard.enabled and guard.note_startup_aligned():

                log.info(
                    "Riavvio automatico per il clock sync: device "
                    "allineato, contatore dei tentativi falliti "
                    "azzerato."
                )

        except Exception:

            log.exception(
                "Riavvio automatico per il clock sync: aggiornamento "
                "dello stato fallito, proseguo comunque."
            )

    async def _wait_shutdown(self, timeout):
        """
        Attesa INTERROMPIBILE dallo shutdown: ritorna True se
        l'arresto è stato richiesto (prima o durante l'attesa), False
        se il timeout è trascorso.
        """

        if self._shutdown.is_set():
            return True

        if timeout <= 0:
            return False

        try:
            await asyncio.wait_for(self._shutdown.wait(), timeout=timeout)

        except asyncio.TimeoutError:
            return False

        return True

    async def _forced_reconnect_attempt(self):
        """
        UN tentativo di Engine.reconnect(force=True), interrompibile
        dallo shutdown. Ritorna ("connected", None), ("failed",
        errore) oppure ("shutdown", None).

        Il tentativo può durare fino a Engine.CREATE_MESH_TIMEOUT (30s):
        senza questa corsa contro _shutdown un SIGTERM arrivato
        durante la procedura dovrebbe attenderlo per intero.
        """

        reconnect_task = asyncio.ensure_future(
            self.engine.reconnect(force=True)
        )

        shutdown_task = asyncio.ensure_future(self._shutdown.wait())

        try:
            await asyncio.wait(
                {reconnect_task, shutdown_task},
                return_when=asyncio.FIRST_COMPLETED
            )

        except asyncio.CancelledError:

            reconnect_task.cancel()

            raise

        finally:
            shutdown_task.cancel()

        if not reconnect_task.done():

            reconnect_task.cancel()

            await asyncio.gather(reconnect_task, return_exceptions=True)

            return "shutdown", None

        if reconnect_task.cancelled():
            return "failed", "tentativo annullato"

        error = reconnect_task.exception()

        if error is not None:
            return "failed", f"{type(error).__name__}: {error}"

        return "connected", None

    async def _auto_reboot_for_clock(self, ahead_secs):
        """
        Chiamata quando il sync all'avvio ha trovato il device AVANTI
        di ahead_secs (>= 5) secondi: riavvia il companion (il suo
        avvio reimposta l'orologio a "ultimo contatto + 1 s", quindi
        sempre <= ora reale a meno di anticipi grandi) e ripete il
        sync, così l'operazione che prima richiedeva un intervento a
        mano diventa automatica. Docs: ARCHITECTURE.md §79.

        Ogni protezione anti-loop sta in ClockRebootGuard
        (core/clock_reboot.py) e nel suo stato SU FILE, quindi vale
        anche tra riavvii del daemon: NTP sincronizzato, anticipo
        <= max_ahead_secs, al più un tentativo ogni min_interval_hours,
        freno dopo max_consecutive_failures tentativi senza esito,
        write-ahead del tentativo PRIMA dell'invio del reboot, stato
        illeggibile/non scrivibile => nessun reboot.

        Non solleva, salvo un caso voluto: ClockRebootReconnectError
        (un RuntimeError) se dopo il reboot la connessione non si
        ripristina entro
        reconnect_timeout_secs. Senza connessione il daemon non ha
        nulla da servire, e il comportamento coincide con quello di un
        engine.connect() fallito all'avvio (l'eccezione esce da
        start(), main() fa stop() e systemd riavvia il servizio):
        il nuovo avvio NON può riavviare di nuovo il device, il
        tentativo è già registrato come fallito.
        """

        if self._shutdown.is_set():
            return

        try:

            guard = self._get_clock_guard()

            decision = guard.evaluate(
                time.time(),
                ahead_secs,
                self._ntp_synchronized
            )

            #
            # WRITE-AHEAD: il tentativo (con il contatore dei
            # fallimenti già incrementato) è su disco PRIMA di inviare
            # il reboot. Se non si può scrivere, niente reboot: senza
            # registro non c'è protezione dal loop. Nello stesso
            # try/except della valutazione: qualunque errore
            # imprevisto in questa fase significa "non riavviare".
            #
            recorded = (
                decision.allowed and
                guard.record_attempt_start(time.time(), ahead_secs)
            )

        except Exception:

            log.exception(
                "Riavvio automatico per il clock sync: valutazione "
                "fallita, il device NON viene riavviato."
            )

            return

        if not decision.allowed:

            log_fn = log.warning if decision.level == "warning" \
                else log.info

            log_fn(
                "Riavvio automatico del device per il clock sync NON "
                "eseguito: %s.",
                decision.reason
            )

            return

        if not recorded:

            log.warning(
                "Riavvio automatico del device per il clock sync NON "
                "eseguito: impossibile registrare il tentativo in %s "
                "(%s) — senza registro non c'è protezione da riavvii "
                "ripetuti.",
                guard.state_path,
                guard.last_write_error
            )

            return

        log.warning(
            "Riavvio automatico del device per il clock sync: anticipo "
            "di %ds con NTP sincronizzato — invio il comando reboot al "
            "companion e ripeto il sync appena torna raggiungibile "
            "(tentativo registrato in %s).",
            ahead_secs,
            guard.state_path
        )

        try:

            await self._reboot_device_and_resync(guard)

        except ClockRebootReconnectError:

            raise

        except Exception:

            #
            # Nessun esito registrato oltre al write-ahead: il
            # contatore resta incrementato (prudente). Il daemon
            # prosegue: il guard impedisce comunque un secondo
            # riavvio.
            #
            log.exception(
                "Riavvio automatico per il clock sync: errore "
                "imprevisto, proseguo comunque con l'avvio."
            )

            self._record_clock_outcome(
                guard,
                clock_reboot.RESULT_INTERRUPTED,
                False
            )

    def _record_clock_outcome(self, guard, result, success):
        """Registra l'esito senza mai sollevare; logga se non riesce."""

        try:
            saved = guard.record_outcome(result, success)

        except Exception:

            log.exception(
                "Riavvio automatico per il clock sync: registrazione "
                "dell'esito '%s' fallita.",
                result
            )

            return

        if not saved:

            log.warning(
                "Riavvio automatico per il clock sync: esito '%s' non "
                "registrato in %s (%s). Il tentativo resta comunque "
                "contato come fallito (write-ahead): il riavvio "
                "automatico resta sospeso finché un avvio non trova il "
                "device allineato o il file viene rimosso.",
                result,
                guard.state_path,
                guard.last_write_error
            )

    async def _reboot_device_and_resync(self, guard):
        """
        Il corpo della procedura di _auto_reboot_for_clock(), DOPO il
        write-ahead: invio reboot, attesa, riconnessione forzata,
        secondo sync, registrazione dell'esito. Ogni uscita registra
        un esito con guard.record_outcome() (success=True solo per
        "ok"); ClockRebootReconnectError solo per la connessione non
        ripristinata.
        """

        #
        # 1) Invio del reboot sulla connessione corrente, sotto
        #    command_lock (a questo punto dell'avvio nessun altro la
        #    usa, ma è lo stesso schema di ogni altro comando).
        #    commands.reboot() è fire-and-forget: il firmware non
        #    risponde, riavvia (v. docs/FIRMWARE_ANALYSIS.md), quindi
        #    "inviato" = nessuna eccezione e nessun evento ERROR.
        #
        #    Due esiti di fallimento, trattati DIVERSAMENTE:
        #      - evento ERROR: il device ha risposto e rifiutato =>
        #        certamente non riavviato: esito registrato, fine;
        #      - eccezione (connessione caduta a metà scrittura, ecc.):
        #        INCERTO — i byte possono essere arrivati e il device
        #        essersi riavviato ugualmente. Se ci si fermasse qui i
        #        servizi partirebbero con un device forse riavviato e
        #        con l'orologio indietro (finestra di
        #        FIRMWARE_ANALYSIS.md §11.1), senza che nessuno lo
        #        sincronizzi fino al riavvio successivo del daemon.
        #        Si prosegue quindi con attesa, riconnessione e
        #        secondo sync, che stabiliscono com'è davvero
        #        l'orologio (allineato => "ok"; ancora avanti =>
        #        "still_ahead"). Il tentativo è già contato (write-ahead).
        #
        send_uncertain = False

        try:

            async with self.engine.acquire_command_lock(
                "daemon:clock_reboot"
            ):
                sent = await self.engine.mesh.commands.reboot()

        except Exception as e:

            send_uncertain = True

            log.warning(
                "Riavvio automatico per il clock sync: invio del "
                "comando reboot terminato con un errore (%s: %s) — non "
                "so se il device sia stato riavviato, verifico comunque "
                "l'orologio dopo la riconnessione.",
                type(e).__name__,
                e
            )

        else:

            if sent is not None and sent.type == EventType.ERROR:

                log.error(
                    "Riavvio automatico per il clock sync: il device ha "
                    "rifiutato il comando reboot (%s) — nessun riavvio "
                    "effettuato, orologio non corretto.",
                    sent.payload
                )

                self._record_clock_outcome(
                    guard,
                    clock_reboot.RESULT_REBOOT_COMMAND_FAILED,
                    False
                )

                return

        if not send_uncertain:

            log.info(
                "Riavvio automatico per il clock sync: comando reboot "
                "inviato, attendo %ss prima di riconnettermi.",
                guard.boot_grace_secs
            )

        # 2) Attesa dell'avvio del device.
        if await self._wait_shutdown(guard.boot_grace_secs):

            self._abort_clock_reboot_on_shutdown(guard)

            return

        #
        # 3) Riconnessione FORZATA (Engine.reconnect(force=True)): la
        #    vecchia connessione è morta ma Engine.connected può
        #    restare True fino al prossimo heartbeat. Si riprova ogni
        #    reconnect_retry_secs finché il device non risponde o
        #    scade reconnect_timeout_secs (ogni tentativo ha già il
        #    proprio tetto di 30s, Engine.CREATE_MESH_TIMEOUT).
        #
        loop = asyncio.get_running_loop()
        deadline = loop.time() + guard.reconnect_timeout_secs

        attempt = 0
        last_error = None

        while True:

            attempt += 1

            status, error = await self._forced_reconnect_attempt()

            if status == "shutdown":

                self._abort_clock_reboot_on_shutdown(guard)

                return

            if status == "connected":
                break

            last_error = error

            log.info(
                "Riavvio automatico per il clock sync: riconnessione "
                "%d non riuscita (%s), il device potrebbe non aver "
                "finito l'avvio.",
                attempt,
                error
            )

            if loop.time() >= deadline:

                log.error(
                    "Riavvio automatico per il clock sync: device non "
                    "raggiungibile entro %ss dal riavvio (ultimo "
                    "errore: %s). Riavvio automatico sospeso: il "
                    "tentativo resta registrato come fallito in %s. "
                    "Il daemon esce e systemd lo riavvia.",
                    guard.reconnect_timeout_secs,
                    last_error,
                    guard.state_path
                )

                self._record_clock_outcome(
                    guard,
                    clock_reboot.RESULT_RECONNECT_FAILED,
                    False
                )

                raise ClockRebootReconnectError(
                    "Riavvio automatico per il clock sync: connessione "
                    "col companion non ripristinata dopo il riavvio."
                )

            if await self._wait_shutdown(guard.reconnect_retry_secs):

                self._abort_clock_reboot_on_shutdown(guard)

                return

        log.info(
            "Riavvio automatico per il clock sync: connessione "
            "ripristinata (tentativo %d), ripeto il sync.",
            attempt
        )

        #
        # 4) Secondo sync, sulla connessione NUOVA (engine.mesh riletto
        #    da _run_clock_sync). Riprova solo se ok=False.
        #
        resync = None

        for i in range(1, self.CLOCK_RESYNC_ATTEMPTS + 1):

            resync = await self._run_clock_sync(
                "daemon:clock_reboot_resync",
                "Clock sync dopo il riavvio del device"
            )

            if resync is not None and resync.ok:
                break

            if i < self.CLOCK_RESYNC_ATTEMPTS:

                log.info(
                    "Clock sync dopo il riavvio del device: tentativo "
                    "%d/%d non riuscito (%s), riprovo.",
                    i,
                    self.CLOCK_RESYNC_ATTEMPTS,
                    "errore imprevisto" if resync is None else resync.error
                )

                if await self._wait_shutdown(guard.reconnect_retry_secs):

                    self._abort_clock_reboot_on_shutdown(guard)

                    return

        # 5) Esito.
        if resync is None or not resync.ok:

            log.warning(
                "Riavvio automatico per il clock sync: il device è "
                "stato riavviato ma il sync successivo è fallito (%s) — "
                "orologio non verificato. Riavvio automatico sospeso "
                "finché un avvio non trova il device allineato.",
                "errore imprevisto" if resync is None else resync.error
            )

            self._record_clock_outcome(
                guard,
                clock_reboot.RESULT_RESYNC_FAILED,
                False
            )

            return

        if resync.device_ahead:

            log.warning(
                "Riavvio automatico per il clock sync: il device è "
                "ancora in anticipo di %ds dopo il riavvio (il suo "
                "orologio riparte dall'ultimo contatto salvato, che "
                "può essere molto recente o in anticipo esso stesso). "
                "Riavvio automatico sospeso: nessun secondo riavvio "
                "finché un avvio non trova il device allineato "
                "(o non si rimuove %s).",
                -resync.drift_before,
                guard.state_path
            )

            self._record_clock_outcome(
                guard,
                clock_reboot.RESULT_STILL_AHEAD,
                False
            )

            return

        if resync.synced and resync.drift_after is not None:

            log.info(
                "Riavvio automatico per il clock sync: riallineato — "
                "dopo il riavvio il device era indietro di %+ds, "
                "corretto (residuo %+ds).",
                resync.drift_before,
                resync.drift_after
            )

        else:

            log.info(
                "Riavvio automatico per il clock sync: riallineato — "
                "dopo il riavvio scarto %+ds, entro la soglia.",
                resync.drift_before
            )

        self._record_clock_outcome(guard, clock_reboot.RESULT_OK, True)

    def _abort_clock_reboot_on_shutdown(self, guard):
        """
        Arresto richiesto a procedura avviata: il reboot potrebbe
        essere già partito, quindi l'esito è "interrupted" (tentativo
        contato come non riuscito, come da write-ahead). Se il device
        risulta allineato al prossimo avvio, il contatore si azzera da
        solo (_note_clock_aligned).
        """

        log.warning(
            "Riavvio automatico per il clock sync: arresto richiesto "
            "durante la procedura, interrotta. Il tentativo resta "
            "registrato; se al prossimo avvio il device risulta "
            "allineato il contatore si azzera da solo."
        )

        self._record_clock_outcome(
            guard,
            clock_reboot.RESULT_INTERRUPTED,
            False
        )

    async def stop(self):
        """
        Arresto ordinato.
        """

        log.info("Stopping MeshCore daemon...")

        await self.ipc.stop()

        #
        # Chiamata INCONDIZIONATA (fix successivo a Rev.6, code
        # review 2026-08-20 — v. ARCHITECTURE.md §31; audit completo
        # di ogni chiamante di connected/connect/disconnect/reconnect
        # in tutto il progetto, nessun altro punto replica questo
        # pattern). Prima di questo fix, il guard "if
        # self.engine.connected" saltava interamente
        # Engine.disconnect() proprio nello scenario in cui la
        # protezione della funzione serve di più: una disconnessione
        # silenziosa già rilevata dall'health-check, con
        # _recovery_task attivo e in attesa di recovery_retry_interval
        # prima del prossimo tentativo di riconnessione — in quella
        # finestra self.mesh.is_connected (o self._connected) è
        # False, quindi "connected" è False, ma _recovery_task,
        # _heartbeat_task e gli eventuali _background_tasks sono
        # ancora vivi e NON venivano mai cancellati/attesi, vanificando
        # esattamente la garanzia introdotta con self._shutting_down
        # (v. disconnect() sotto) — che non serve a nulla se
        # disconnect() non viene proprio chiamata.
        #
        # Engine.disconnect() è già completamente idempotente e sicura
        # da chiamare incondizionatamente, incluso il caso "mai stato
        # connesso": _teardown_mesh() ritorna subito se self.mesh è
        # None, i controlli su _recovery_task/_heartbeat_task sono già
        # "if x is not None", e il loop su _background_tasks su un set
        # vuoto non fa nulla — verificato leggendo il corpo di
        # disconnect()/_teardown_mesh(), non assunto. L'unico effetto
        # collaterale è cosmetico: il log "Closing MeshCore
        # connection..." compare anche se il daemon non si è mai
        # connesso con successo (es. crash durante l'avvio) — innocuo.
        #
        await self.engine.disconnect()

        log.info("MeshCore daemon stopped.")

    def shutdown(self):
        self._shutdown.set()


async def main():
    daemon = MeshCoreDaemon()

    loop = asyncio.get_running_loop()

    loop.add_signal_handler(
        signal.SIGINT,
        daemon.shutdown
    )

    loop.add_signal_handler(
        signal.SIGTERM,
        daemon.shutdown
    )

    try:
        await daemon.start()

    finally:
        await daemon.stop()


if __name__ == "__main__":
    asyncio.run(main())
