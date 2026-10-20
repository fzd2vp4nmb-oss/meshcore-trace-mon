import asyncio

from core.logger import log
from mesh_modules.sonar.sonar import SonarModule


class SonarService:
    """
    Servizio SONAR (docs/ARCHITECTURE.md §87).

    Ricezione: autonoma ed event-driven (come BotService/
    ContactSyncService), parte in background all'avvio e non richiede
    comandi.

    Comandi IPC (servizio 'sonar'):

        send            trasmette UN messaggio sonar sul canale
                        dedicato. Parametro opzionale 'scope' (str):
                        '*'/'U' unscoped, ''/'D' default del device,
                        oppure un nome di regione; se assente vale
                        sonar.tx.scope. Invocato da cron tramite
                        sonar.sh / tools/send_sonar.py.

        status          stato diagnostico (canale, contatori, ultimo
                        invio). Non espone MAI il segreto del canale.

        ensure_channel  cerca il canale sul device e lo adotta;
                        'create' (bool) lo crea se manca;
                        'reveal_secret' (bool) include il segreto
                        (esadecimale) nella risposta, per propagarlo
                        agli altri nodi tramite sonar.channel_secret
                        (tools/sonar_channel.py).

    Il costruttore NON solleva mai: services/loader.py ferma l'intero
    daemon (bot, trace, advert compresi) se il costruttore di un
    servizio solleva, e un errore del sonar (configurazione, database)
    non deve avere questo effetto. Un servizio che non riesce a
    inizializzarsi risponde a ogni comando con un errore leggibile.
    """

    def __init__(self, context):

        self.context = context

        self.sonar = None

        self._start_task = None

        try:

            self.sonar = SonarModule(self.context.engine)

            #
            # Il costruttore del servizio non può essere asincrono, ma
            # l'avvio richiede chiamate al device e al database —
            # parte in background. Riferimento mantenuto sull'istanza
            # (code review 2026-08-20, §3.1 — v.
            # mesh_modules/bot/service.py per la motivazione).
            #
            self._start_task = asyncio.create_task(
                self._start()
            )

        except Exception:

            log.exception(
                "SonarService: inizializzazione fallita, servizio "
                "inattivo (il resto del daemon non è toccato)."
            )

            self.sonar = None

    async def _start(self):

        try:
            await self.sonar.start()

        except Exception:
            log.exception(
                "SonarService: avvio fallito."
            )

    @staticmethod
    def _error(message, **extra):

        response = dict(extra)

        response["version"] = 1
        response["status"] = "error"
        response["message"] = message

        return response

    @classmethod
    def _from_result(cls, result):
        """
        Traduce il dict di SonarModule ({"ok": bool, ...}) nella
        risposta IPC. 'version' e 'status' sono scritti per ultimi:
        nessun campo del risultato può sovrascriverli.
        """

        extra = {
            key: value for key, value in result.items()
            if key not in ("ok", "message")
        }

        if not result.get("ok"):
            return cls._error(
                result.get("message", "errore sconosciuto"), **extra
            )

        extra["version"] = 1
        extra["status"] = "ok"

        return extra

    @staticmethod
    def _optional_bool(request, key):
        """Valore booleano STRETTO di un parametro opzionale: una
        stringa come "false" sarebbe truthy se passata a bool()."""

        value = request.get(key, False)

        if not isinstance(value, bool):
            raise ValueError(f"'{key}' deve essere true o false")

        return value

    async def execute(self, request):

        command = request.get("command")

        if self.sonar is None:
            return self._error(
                "servizio sonar non inizializzato (v. log del daemon)"
            )

        try:

            if command == "send":

                scope = request.get("scope")

                if scope is not None and not isinstance(scope, str):
                    return self._error("'scope' deve essere una stringa")

                log.info("SonarService: send (scope=%r)", scope)

                return self._from_result(await self.sonar.send(scope))

            if command == "status":

                response = {
                    "version": 1,
                    "status": "ok",
                    "sonar": self.sonar.status(),
                }

                try:
                    response["last_tx"] = await self.sonar._run_db(
                        "last_sonar_tx"
                    )

                except Exception:
                    log.exception("SonarService: lettura sonar_tx fallita.")
                    response["last_tx"] = None
                    response["db_error"] = True

                return response

            if command == "ensure_channel":

                try:
                    create = self._optional_bool(request, "create")
                    reveal = self._optional_bool(request, "reveal_secret")

                except ValueError as exc:
                    return self._error(str(exc))

                log.info(
                    "SonarService: ensure_channel (create=%s, "
                    "reveal_secret=%s)", create, reveal
                )

                return self._from_result(
                    await self.sonar.ensure_channel(
                        create=create,
                        reveal_secret=reveal
                    )
                )

        except asyncio.CancelledError:
            raise

        except Exception:

            #
            # SonarModule non dovrebbe sollevare, ma un'eccezione
            # sfuggita non deve diventare un errore opaco del
            # dispatcher (che la loggherebbe senza contesto).
            #
            log.exception(
                "SonarService: comando '%s' fallito con eccezione.",
                command
            )

            return self._error(
                f"errore interno nel comando '{command}' (v. log del "
                f"daemon)"
            )

        return self._error(f"unknown command '{command}'")
