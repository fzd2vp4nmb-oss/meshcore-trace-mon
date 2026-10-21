import asyncio
import functools
import time

from meshcore.events import EventType

from core.config import config
from core.logger import log

from mesh_modules.contact_sync.db import (
    ADVERT_KIND_FLOOD,
    ADVERT_KIND_ZERO_HOP,
    ADVERT_TX_FAILED,
    ADVERT_TX_SENT,
    ADVERT_TX_UNKNOWN,
    ContactDB
)
from mesh_modules.sonar.protocol import src_prefix_from_public_key

#
# Motivi con cui la libreria segnala che NON ha ricevuto risposta dal
# companion (stessi valori e stessa logica di mesh_modules/sonar/
# sonar.py::_is_indeterminate, docs/ARCHITECTURE.md §87.2 F5: duplicati
# qui invece di importati per non far dipendere questo modulo dal
# servizio sonar, di cui userebbe solo queste poche righe).
#
_TIMEOUT_REASONS = ("timeout", "no_event_received")


def _is_indeterminate(payload):
    """
    True se l'Event(ERROR) NON è un rifiuto del firmware ma un esito
    sconosciuto (timeout in attesa della risposta, o eccezione di
    trasporto: 'error' senza 'error_code'): il comando potrebbe
    comunque essere stato eseguito. Un ERROR con 'error_code' (o
    vuoto) è invece un rifiuto esplicito: il comando NON è stato
    eseguito.
    """

    if not isinstance(payload, dict):
        return True

    if payload.get("reason") in _TIMEOUT_REASONS:
        return True

    return "error" in payload and "error_code" not in payload


def _short(payload, limit=120):
    """Rappresentazione breve e sicura di un payload di errore."""

    text = repr(payload)

    return text if len(text) <= limit else text[:limit] + "..."


class AdvertModule:
    """
    Wrapper delle funzionalità Advert offerte da meshcore_py.

    Legge l'istanza MeshCore corrente dinamicamente da Engine ad
    ogni chiamata — non ne tiene mai una copia locale.

    Registro degli invii (docs/ARCHITECTURE.md §87.17): ogni tentativo
    di invio che arriva fino al companion lascia una riga in
    contacts.db, tabella advert_tx, con il suo esito. La scrittura è
    solo un'annotazione, mai una condizione dell'invio: avviene DOPO
    l'invio, non solleva mai (un database non disponibile fa solo
    perdere la riga, con un avviso nel log) e non cambia in nulla il
    valore restituito né le eccezioni di _send(). Non viene registrato
    nulla quando l'invio è annullato a monte perché la connessione non
    è attiva: nessun comando è arrivato al companion.
    """

    def __init__(self, engine, db_path=None):
        self.engine = engine

        #
        # Percorso di contacts.db: lo stesso di contact_sync e sonar
        # (contacts.db_file). Letto al primo uso, non qui: il
        # costruttore di un servizio non deve poter fallire (v.
        # services/loader.py). db_path esplicito solo per i test.
        #
        self._db_path = db_path
        self._db = None
        self._db_lock = asyncio.Lock()

    async def advert(self):
        return await self._send(flood=False)

    async def floodadv(self):
        return await self._send(flood=True)

    async def _send(self, flood):

        label = "flood advert" if flood else "zero-hop advert"

        if not self.engine.connected:

            log.warning(
                "ADVERT: connessione non attiva, invio annullato (%s).",
                label
            )

            return None

        log.info(
            "ADVERT: sending %s...",
            label
        )

        kind = ADVERT_KIND_FLOOD if flood else ADVERT_KIND_ZERO_HOP

        #
        # Letti PRIMA dell'invio (nessun await): l'istante di partenza
        # e il prefisso della chiave del companion che sta davvero
        # trasmettendo, non quello di una eventuale riconnessione
        # avvenuta nel frattempo.
        #
        created_at = int(time.time())
        src_prefix = self._local_src_prefix()

        status = None
        sent_at = None
        error = None

        try:

            try:

                event = await self.engine.mesh.commands.send_advert(
                    flood=flood
                )

            except asyncio.CancelledError:

                #
                # Richiesta annullata (watchdog IPC, arresto del
                # daemon) mentre si attendeva il companion: il comando
                # potrebbe essere già partito.
                #
                status, error = (
                    ADVERT_TX_UNKNOWN, "richiesta interrotta"
                )

                raise

            except Exception as exc:

                status, error = (
                    ADVERT_TX_UNKNOWN,
                    f"send_advert: {type(exc).__name__}"
                )

                log.exception(
                    "ADVERT: send_advert() failed"
                )

                self.engine.report_possible_failure()

                raise

            if event.type == EventType.ERROR:

                if _is_indeterminate(event.payload):
                    status = ADVERT_TX_UNKNOWN

                else:
                    status = ADVERT_TX_FAILED

                error = f"send_advert: {_short(event.payload)}"

                log.warning(
                    "ADVERT: %s failed: %r",
                    label,
                    event.payload
                )

                #
                # Errore sul comando stesso (link locale al companion),
                # non su un evento radio successivo — segnala subito.
                #
                self.engine.report_possible_failure()

                return event

            status, sent_at = ADVERT_TX_SENT, int(time.time())

            log.info(
                "ADVERT: %s completed.",
                label
            )

            return event

        finally:

            #
            # Nel finally: ogni tentativo lascia la sua riga, anche
            # quando _send() esce con un'eccezione o per cancellazione
            # (status è sempre valorizzato prima di arrivare qui; il
            # ramo 'unknown' sotto è solo una rete di sicurezza).
            #
            if status is None:
                status, error = ADVERT_TX_UNKNOWN, "interrotto prima dell'esito"

            await self._register(
                created_at, kind, status, src_prefix, sent_at, error
            )

    def _local_src_prefix(self):
        """
        Prefisso (8 esadecimali) della chiave pubblica di QUESTO
        companion, da mesh.self_info (stessa sorgente e stessa
        funzione del sonar), oppure None se non disponibile.
        """

        mesh = getattr(self.engine, "mesh", None)

        info = getattr(mesh, "self_info", None)

        if not isinstance(info, dict):
            return None

        return src_prefix_from_public_key(info.get("public_key"))

    def _open_db_sync(self):
        """
        Apre contacts.db (crea le tabelle mancanti, idempotente — v.
        ContactDB.SCHEMA). Eseguito in un thread da _register().
        """

        path = self._db_path or config.get(
            "contacts.db_file",
            "data/contacts.db"
        )

        return ContactDB(path)

    async def _register(
        self,
        created_at,
        kind,
        status,
        src_prefix,
        sent_at,
        error
    ):
        """
        Scrive la riga di advert_tx. NON solleva mai (salvo
        CancelledError): un fallimento della registrazione non deve
        cambiare l'esito di un invio già fatto. SQLite è bloccante e
        con busy_timeout può attendere secondi: lavoro in un thread
        (stesso criterio di SonarModule._run_db), serializzato da un
        lock perché la connessione è condivisa tra i thread
        dell'executor. Il database si apre al primo uso e, se
        l'apertura fallisce, si ritenta all'invio successivo.
        """

        try:

            loop = asyncio.get_event_loop()

            async with self._db_lock:

                if self._db is None:
                    self._db = await loop.run_in_executor(
                        None,
                        self._open_db_sync
                    )

                await loop.run_in_executor(
                    None,
                    functools.partial(
                        self._db.insert_advert_tx,
                        created_at,
                        kind,
                        status,
                        src_prefix=src_prefix,
                        sent_at=sent_at,
                        error=error
                    )
                )

        except Exception:

            log.warning(
                "ADVERT: registrazione in advert_tx non riuscita (non "
                "fatale: l'advert non ne risente, la riga è persa).",
                exc_info=True
            )
