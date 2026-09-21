"""
core/clock_reboot.py

Politica di sicurezza e stato persistente del RIAVVIO AUTOMATICO del
companion per riallineare il suo orologio (docs/ARCHITECTURE.md §79).

Contesto (§78): il firmware del companion accetta l'impostazione
dell'ora solo in AVANTI (CMD_SET_DEVICE_TIME -> ERR_CODE_ILLEGAL_ARG
altrimenti), quindi un device che guadagna tempo non è correggibile con
set_time. Un riavvio del device invece sì: MyMesh::begin() esegue
incondizionatamente bootstrapRTCfromContacts(), che imposta l'ora a
"lastmod più recente tra i contatti + 1 s" senza confronto con l'ora
corrente; il sync all'avvio del daemon la porta poi al valore giusto.

Questo modulo NON parla con il device né con l'Engine: decide SE un
riavvio automatico è consentito e tiene il registro dei tentativi.
L'orchestrazione (invio del reboot, attesa, riconnessione, nuovo sync)
sta in services/daemon.py. Nessun log qui dentro — stesso principio di
core/clock_sync.py: il chiamante riceve una Decision/un esito e decide
come riportarlo.

PROTEZIONE ANTI-LOOP (requisito esplicito dell'utente: il sistema non
deve poter riavviare il device all'infinito per una condizione
anomala). Tutte le difese sono nello STATO SU FILE, quindi valgono
anche tra riavvii del daemon e crash-loop di systemd (Restart=always):

  1. write-ahead: il tentativo è registrato (con il contatore dei
     fallimenti già incrementato) PRIMA di inviare il reboot; se il
     file non è scrivibile il reboot NON viene inviato. Un daemon
     ucciso a metà procedura lascia quindi comunque traccia.
  2. intervallo minimo tra due tentativi (min_interval_secs).
  3. freno: dopo max_consecutive_failures tentativi consecutivi senza
     esito il riavvio automatico si sospende; si riabilita quando un
     avvio trova il device allineato (note_startup_aligned) o
     rimuovendo il file di stato.
  4. file di stato illeggibile/incoerente => niente reboot (fail-safe);
     un timestamp dell'ultimo tentativo troppo nel futuro (orologio
     saltato) è trattato come stato non utilizzabile.
  5. limite superiore all'anticipo (max_ahead_secs): un reboot cancella
     solo lo "scarto di aggiornamento" dell'ultimo contatto, quindi
     oltre una certa soglia è probabile un'anomalia e non una deriva.
  6. solo con l'orologio del Raspberry sincronizzato via NTP: altrimenti
     "device avanti" può voler dire "Raspberry indietro", e un reboot
     seguito da un sync sul Raspberry sbagliato spingerebbe il device a
     un'ora sbagliata.
  7. record_attempt_start() rilegge e RIVALUTA lo stato sotto un flock
     esclusivo non bloccante (<stato>.lock): due processi che hanno
     entrambi visto "consentito" non possono registrare entrambi il
     tentativo; chi non ottiene il lock o trova lo stato cambiato non
     riavvia.
  8. limiti minimi/massimi imposti dal codice sulla configurazione:
     min_interval_hours >= 1 e max_consecutive_failures <= 3, così un
     valore sbagliato in config.yaml non può riaprire un loop.
  9. il percorso del file di stato relativo è risolto rispetto alla
     radice del progetto, non alla directory di lavoro del processo:
     lo stesso file, da qualunque directory venga avviato il daemon.

Parametri in config.yaml sotto daemon.clock_auto_reboot.* — default a
livello di codice, deliberatamente ASSENTI dal template (stesso pattern
di daemon.socket_path/daemon.dispatch_timeout, ARCHITECTURE.md §44/§45;
la sezione "daemon" è già in TEMPLATE_EXEMPT_SECTIONS di
tools/edit_config.py, quindi `align` non la tocca).
"""

import fcntl
import json
import math
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path


#
# Radice del progetto (core/ -> ..): i percorsi relativi del file di
# stato sono risolti qui, non rispetto alla directory di lavoro (v.
# difesa 9 nel docstring del modulo).
#
PROJECT_ROOT = Path(__file__).resolve().parent.parent

CONFIG_PREFIX = "daemon.clock_auto_reboot"

DEFAULT_ENABLED = True
DEFAULT_MAX_AHEAD_SECS = 60
DEFAULT_MIN_INTERVAL_HOURS = 168          # 7 giorni
DEFAULT_MAX_CONSECUTIVE_FAILURES = 1
DEFAULT_BOOT_GRACE_SECS = 15
DEFAULT_RECONNECT_TIMEOUT_SECS = 120
DEFAULT_RECONNECT_RETRY_SECS = 5
DEFAULT_STATE_FILE = "run/clock_reboot_state.json"

STATE_VERSION = 1

#
# Limiti imposti dal codice (difesa 8): valori fuori intervallo in
# config.yaml tornano al default con un warning.
#
MIN_INTERVAL_HOURS_FLOOR = 1
MAX_CONSECUTIVE_FAILURES_CEILING = 3

#
# Un last_attempt_ts più avanti di così rispetto a "adesso" non è una
# piccola correzione NTP ma un orologio saltato: stato non utilizzabile.
#
FUTURE_TIMESTAMP_TOLERANCE_SECS = 86400

#
# Esiti registrati in state["last_result"]. "in_progress" è scritto
# prima dell'invio del reboot (write-ahead) e sopravvive solo se la
# procedura è stata interrotta prima di registrare l'esito.
#
RESULT_IN_PROGRESS = "in_progress"
RESULT_OK = "ok"
RESULT_STILL_AHEAD = "still_ahead"
RESULT_RESYNC_FAILED = "resync_failed"
RESULT_REBOOT_COMMAND_FAILED = "reboot_command_failed"
RESULT_RECONNECT_FAILED = "reconnect_failed"
RESULT_INTERRUPTED = "interrupted"
RESULT_ALIGNED_AT_STARTUP = "aligned_at_startup"


@dataclass
class Decision:
    """
    Esito di ClockRebootGuard.evaluate(): allowed=True solo se TUTTE le
    condizioni sono soddisfatte. level ("info"/"warning") suggerisce
    con che gravità il chiamante dovrebbe riportare un rifiuto: un
    intervallo minimo non ancora trascorso è normale, un file di stato
    corrotto o un freno scattato no.
    """
    allowed: bool
    reason: str
    level: str = "info"


def _format_ts(ts):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))


def _format_duration(secs):
    secs = max(0, int(secs))

    if secs >= 86400:
        return f"{secs / 86400:.1f} giorni"

    if secs >= 3600:
        return f"{secs / 3600:.1f} ore"

    return f"{secs // 60} minuti"


def _resolve_state_path(path):
    p = Path(path)

    return p if p.is_absolute() else PROJECT_ROOT / p


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class ClockRebootGuard:

    def __init__(
        self,
        enabled=DEFAULT_ENABLED,
        max_ahead_secs=DEFAULT_MAX_AHEAD_SECS,
        min_interval_secs=DEFAULT_MIN_INTERVAL_HOURS * 3600,
        max_consecutive_failures=DEFAULT_MAX_CONSECUTIVE_FAILURES,
        boot_grace_secs=DEFAULT_BOOT_GRACE_SECS,
        reconnect_timeout_secs=DEFAULT_RECONNECT_TIMEOUT_SECS,
        reconnect_retry_secs=DEFAULT_RECONNECT_RETRY_SECS,
        state_path=DEFAULT_STATE_FILE,
    ):

        self.enabled = enabled
        self.max_ahead_secs = max_ahead_secs
        self.min_interval_secs = min_interval_secs
        self.max_consecutive_failures = max_consecutive_failures
        self.boot_grace_secs = boot_grace_secs
        self.reconnect_timeout_secs = reconnect_timeout_secs
        self.reconnect_retry_secs = reconnect_retry_secs
        self.state_path = _resolve_state_path(state_path)

        #
        # Diagnostica per il chiamante (mai eccezioni da questo modulo):
        # valori di config scartati in from_config(), e il motivo
        # dell'ultimo fallimento di una scrittura/registrazione dello
        # stato (record_attempt_start/record_outcome ritornano False e
        # lo spiegano qui).
        #
        self.config_warnings = []
        self.last_write_error = None

        #
        # Copia IN MEMORIA del tentativo registrato da
        # record_attempt_start(): record_outcome() la riscrive nello
        # stato anche se nel frattempo il file è sparito o è stato
        # corrotto, così l'intervallo minimo non si perde mai.
        #
        self._attempt = None

    @classmethod
    def from_config(cls, config):
        """
        Legge daemon.clock_auto_reboot.* da `config` (l'oggetto
        core.config.Config), applicando i default a livello di codice.
        Un valore di tipo/intervallo non valido NON solleva: torna al
        default e finisce in guard.config_warnings, che il daemon logga.
        Unica eccezione al "torna al default": `enabled` non booleano
        => DISABILITATO, perché la funzione riavvia hardware e un
        valore ambiguo non deve poterla attivare.

        I parametri numerici sono accettati anche come stringa
        numerica ("30"): `tools/edit_config.py set` scrive come
        stringa ogni valore la cui chiave non termina con uno dei
        NUMERIC_SUFFIXES (nessuno di questi lo fa), quindi
        `set daemon.clock_auto_reboot.max_ahead_secs 30` produce
        `max_ahead_secs: '30'` nel YAML. NaN e infinito sono scartati.
        """

        warnings = []

        def read(name, default, kind, minimum, maximum=None):

            key = f"{CONFIG_PREFIX}.{name}"
            value = config.get(key, default)

            if isinstance(value, str):

                try:
                    value = float(value.strip())

                except ValueError:
                    pass

            if (
                not _is_number(value)
                or not math.isfinite(value)
                or value < minimum
                or (maximum is not None and value > maximum)
            ):

                atteso = (
                    f"numero >= {minimum}" if maximum is None
                    else f"numero tra {minimum} e {maximum}"
                )

                warnings.append(
                    f"{key}={value!r} non valido ({atteso} atteso): "
                    f"uso il default {default}."
                )
                return default

            return kind(value)

        enabled = config.get(f"{CONFIG_PREFIX}.enabled", DEFAULT_ENABLED)

        if not isinstance(enabled, bool):
            warnings.append(
                f"{CONFIG_PREFIX}.enabled={enabled!r} non è un booleano: "
                f"riavvio automatico DISABILITATO per sicurezza."
            )
            enabled = False

        state_file = config.get(
            f"{CONFIG_PREFIX}.state_file",
            DEFAULT_STATE_FILE
        )

        if not isinstance(state_file, str) or not state_file.strip():
            warnings.append(
                f"{CONFIG_PREFIX}.state_file={state_file!r} non valido: "
                f"uso il default {DEFAULT_STATE_FILE}."
            )
            state_file = DEFAULT_STATE_FILE

        guard = cls(
            enabled=enabled,
            max_ahead_secs=read(
                "max_ahead_secs", DEFAULT_MAX_AHEAD_SECS, int, 5
            ),
            min_interval_secs=read(
                "min_interval_hours", DEFAULT_MIN_INTERVAL_HOURS, float,
                MIN_INTERVAL_HOURS_FLOOR
            ) * 3600,
            max_consecutive_failures=read(
                "max_consecutive_failures",
                DEFAULT_MAX_CONSECUTIVE_FAILURES, int, 1,
                MAX_CONSECUTIVE_FAILURES_CEILING
            ),
            boot_grace_secs=read(
                "boot_grace_secs", DEFAULT_BOOT_GRACE_SECS, float, 0
            ),
            reconnect_timeout_secs=read(
                "reconnect_timeout_secs",
                DEFAULT_RECONNECT_TIMEOUT_SECS, float, 1
            ),
            reconnect_retry_secs=read(
                "reconnect_retry_secs",
                DEFAULT_RECONNECT_RETRY_SECS, float, 0
            ),
            state_path=state_file,
        )

        guard.config_warnings = warnings

        return guard

    # ------------------------------------------------------------------
    # Stato su file
    # ------------------------------------------------------------------

    def _read_state(self):
        """
        Ritorna (stato, errore). File assente => ({}, None) (nessun
        tentativo precedente). File presente ma illeggibile o
        incoerente => (None, motivo): chi chiama deve trattarlo come
        "non posso escludere un loop" e NON procedere.
        """

        try:
            raw = self.state_path.read_text(encoding="utf-8")

        except FileNotFoundError:
            return {}, None

        except (OSError, UnicodeDecodeError) as e:
            return None, f"lettura fallita: {e}"

        try:
            data = json.loads(raw)

        except ValueError as e:
            return None, f"JSON non valido: {e}"

        if not isinstance(data, dict):
            return None, "formato inatteso (non è un oggetto JSON)"

        for key in ("last_attempt_ts", "consecutive_failures"):

            if key in data and (not _is_int(data[key]) or data[key] < 0):
                return None, f"campo '{key}' non valido: {data[key]!r}"

        if "last_result" in data and not isinstance(data["last_result"], str):
            return None, f"campo 'last_result' non valido: {data['last_result']!r}"

        return data, None

    def _write_state(self, state):
        """
        Scrittura atomica (file temporaneo nella stessa directory +
        os.replace, con fsync): un crash a metà non lascia mai un file
        parziale. Non solleva: ritorna False e imposta last_write_error.
        """

        state = dict(state)
        state["version"] = STATE_VERSION

        tmp_path = None

        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)

            fd, tmp_path = tempfile.mkstemp(
                dir=str(self.state_path.parent),
                prefix=self.state_path.name + ".",
                suffix=".tmp"
            )

            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=2, sort_keys=True)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())

            os.replace(tmp_path, self.state_path)

            tmp_path = None

            #
            # fsync anche della directory: senza, dopo un'interruzione
            # di corrente a ridosso del reboot la rinomina potrebbe non
            # essere persistita e tornare lo stato PRECEDENTE (il
            # write-ahead perso). Best effort: non tutti i filesystem lo
            # supportano.
            #
            try:
                dir_fd = os.open(str(self.state_path.parent), os.O_RDONLY)

                try:
                    os.fsync(dir_fd)

                finally:
                    os.close(dir_fd)

            except OSError:
                pass

            self.last_write_error = None

            return True

        except (OSError, ValueError, TypeError) as e:

            self.last_write_error = str(e)

            return False

        finally:

            if tmp_path is not None:

                try:
                    os.unlink(tmp_path)

                except OSError:
                    pass

    def state_summary(self):
        """
        (consecutive_failures, last_result, last_attempt_ts) per i log
        del chiamante; (0, None, 0) se il file manca o non è leggibile.
        """

        state, _ = self._read_state()

        if not state:
            return 0, None, 0

        return (
            state.get("consecutive_failures", 0),
            state.get("last_result"),
            state.get("last_attempt_ts", 0)
        )

    # ------------------------------------------------------------------
    # Decisione
    # ------------------------------------------------------------------

    def evaluate(self, now, ahead_secs, ntp_synchronized):
        """
        now: epoch corrente (il chiamante passa time.time()).
        ahead_secs: anticipo del device in secondi, POSITIVO (>= 5).
        ntp_synchronized: True / False / None (sconosciuto), come
        restituito da MeshCoreDaemon._check_ntp_sync().

        Ordine delle verifiche: dalle più economiche/certe a quelle che
        richiedono di leggere il file di stato. Solo True/False esplicito
        di NTP consente di procedere con True.
        """

        if not self.enabled:

            return Decision(
                False,
                f"disabilitato in configurazione "
                f"({CONFIG_PREFIX}.enabled)",
                "info"
            )

        if ahead_secs > self.max_ahead_secs:

            return Decision(
                False,
                f"anticipo di {ahead_secs}s oltre il limite di "
                f"{self.max_ahead_secs}s per il riavvio automatico "
                f"({CONFIG_PREFIX}.max_ahead_secs): un reboot corregge "
                f"solo anticipi piccoli, oltre è più probabile "
                f"un'anomalia (orologio del Raspberry o dei contatti) "
                f"da verificare a mano",
                "warning"
            )

        if ntp_synchronized is not True:

            stato = "non sincronizzato" if ntp_synchronized is False \
                else "sconosciuto"

            return Decision(
                False,
                f"orologio del Raspberry via NTP {stato}: non si può "
                f"stabilire se sia il device ad essere avanti o il "
                f"Raspberry ad essere indietro, e un reboot seguito "
                f"da un sync su un'ora sbagliata la propagherebbe al "
                f"device",
                "warning"
            )

        state, error = self._read_state()

        if state is None:

            return Decision(
                False,
                f"file di stato {self.state_path} non utilizzabile "
                f"({error}): non posso escludere un loop di riavvii, "
                f"riavvio automatico sospeso — correggere o rimuovere "
                f"il file per riabilitarlo",
                "warning"
            )

        return self._check_state(state, now)

    def _check_state(self, state, now):
        """
        Le verifiche che dipendono SOLO dallo stato su file (freno,
        timestamp implausibile, intervallo minimo). Usata da evaluate()
        e, sotto lock, da record_attempt_start() che le rifà su uno
        stato appena riletto (difesa 7).
        """

        failures = state.get("consecutive_failures", 0)

        if failures >= self.max_consecutive_failures:

            last_ts = state.get("last_attempt_ts", 0)

            quando = f", il {_format_ts(last_ts)}" if last_ts else ""

            return Decision(
                False,
                f"riavvio automatico sospeso: {failures} tentativo/i "
                f"consecutivo/i senza esito (ultimo esito: "
                f"{state.get('last_result')}{quando}). Si riabilita da "
                f"solo quando un avvio trova il device allineato, "
                f"oppure rimuovendo {self.state_path}",
                "warning"
            )

        last_ts = state.get("last_attempt_ts", 0)

        if last_ts - now > FUTURE_TIMESTAMP_TOLERANCE_SECS:

            return Decision(
                False,
                f"il file di stato {self.state_path} riporta un ultimo "
                f"tentativo nel futuro ({_format_ts(last_ts)}): "
                f"l'orologio del Raspberry è saltato o il file è "
                f"stato scritto con un'ora sbagliata — non posso "
                f"calcolare l'intervallo minimo, riavvio automatico "
                f"sospeso; rimuovere il file per riabilitarlo",
                "warning"
            )

        if last_ts:

            elapsed = now - last_ts

            if elapsed < self.min_interval_secs:

                remaining = self.min_interval_secs - max(elapsed, 0)

                return Decision(
                    False,
                    f"ultimo riavvio automatico il "
                    f"{_format_ts(last_ts)}: intervallo minimo di "
                    f"{_format_duration(self.min_interval_secs)} non "
                    f"ancora trascorso (prossimo tentativo possibile "
                    f"tra circa {_format_duration(remaining)}; "
                    f"{CONFIG_PREFIX}.min_interval_hours)",
                    "info"
                )

        return Decision(True, "condizioni soddisfatte", "info")

    # ------------------------------------------------------------------
    # Registro dei tentativi
    # ------------------------------------------------------------------

    def record_attempt_start(self, now, ahead_secs):
        """
        WRITE-AHEAD: da chiamare PRIMA di inviare il reboot. Registra il
        tentativo con il contatore dei fallimenti già incrementato e
        last_result="in_progress".

        Sotto un flock esclusivo NON bloccante su <stato>.lock rilegge lo
        stato e RIFA le verifiche basate su di esso (freno, timestamp,
        intervallo minimo): evaluate() e questa chiamata non sono atomiche
        tra loro, quindi due processi che hanno entrambi visto
        "consentito" si escludono qui — il secondo trova lo stato già
        aggiornato (o il lock occupato) e non riavvia.

        Ritorna False — e spiega il motivo in last_write_error — se il
        lock è occupato o non ottenibile, se lo stato non è leggibile o
        nel frattempo non consente più il riavvio, o se non è scrivibile:
        in ognuno di questi casi il chiamante NON deve inviare il reboot
        (senza registro non c'è protezione dal loop).
        """

        lock_path = str(self.state_path) + ".lock"

        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)

            lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)

        except OSError as e:

            self.last_write_error = f"lock {lock_path} non creabile: {e}"

            return False

        try:

            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

            except OSError as e:

                self.last_write_error = (
                    f"lock {lock_path} non ottenuto (un altro processo "
                    f"sta registrando un tentativo?): {e}"
                )

                return False

            state, error = self._read_state()

            if state is None:

                self.last_write_error = f"stato non leggibile: {error}"

                return False

            decision = self._check_state(state, now)

            if not decision.allowed:

                self.last_write_error = (
                    f"lo stato non consente più il riavvio: "
                    f"{decision.reason}"
                )

                return False

            new_state = {
                "last_attempt_ts": int(now),
                "last_ahead_secs": int(ahead_secs),
                "consecutive_failures":
                    state.get("consecutive_failures", 0) + 1,
                "last_result": RESULT_IN_PROGRESS,
            }

            if not self._write_state(new_state):
                return False

            self._attempt = {
                "last_attempt_ts": new_state["last_attempt_ts"],
                "last_ahead_secs": new_state["last_ahead_secs"],
            }

            return True

        finally:
            os.close(lock_fd)          # rilascia anche il flock

    def record_outcome(self, result, success):
        """
        Registra l'esito. success=True azzera il contatore dei
        fallimenti; success=False lo lascia (già incrementato dal
        write-ahead), garantendo comunque almeno 1. Ritorna False se la
        scrittura fallisce (il chiamante lo logga, non è fatale: il
        write-ahead ha già lasciato lo stato in modo prudente).

        Se questo processo ha registrato un tentativo
        (record_attempt_start), ts e anticipo di quel tentativo sono
        SEMPRE riportati nello stato scritto, anche se nel frattempo il
        file è sparito o è stato corrotto: senza, uno stato ricreato
        senza last_attempt_ts riaprirebbe subito l'intervallo minimo.
        """

        state, _ = self._read_state()

        state = dict(state) if state else {}

        if self._attempt is not None:

            state["last_attempt_ts"] = max(
                state.get("last_attempt_ts", 0),
                self._attempt["last_attempt_ts"]
            )

            state.setdefault(
                "last_ahead_secs", self._attempt["last_ahead_secs"]
            )

        state["last_result"] = result

        if success:
            state["consecutive_failures"] = 0

        else:
            state["consecutive_failures"] = max(
                1, state.get("consecutive_failures", 0)
            )

        return self._write_state(state)

    def note_startup_aligned(self):
        """
        Da chiamare quando un sync all'avvio trova il device allineato
        (ok e non in anticipo): azzera un eventuale freno scattato, così
        il riavvio automatico si riabilita da solo dopo una correzione
        avvenuta per altra via (o dopo un riavvio andato a buon fine
        ma interrotto prima di registrare l'esito). Non tocca il file se
        non c'è nulla da azzerare, né un file illeggibile. Ritorna True
        se ha modificato lo stato.
        """

        state, _ = self._read_state()

        if not state or state.get("consecutive_failures", 0) <= 0:
            return False

        state = dict(state)
        state["consecutive_failures"] = 0
        state["last_result"] = RESULT_ALIGNED_AT_STARTUP

        return self._write_state(state)
