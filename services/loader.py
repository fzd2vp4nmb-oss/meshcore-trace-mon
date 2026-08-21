import importlib

from core.logger import log

class ServiceLoader:
    """
    Caricatore dinamico dei servizi.
    I servizi vengono definiti nel file config.yaml
    e caricati automaticamente all'avvio del daemon.

    Il Loader non conosce alcun servizio applicativo.
    """

    MODULE_PREFIX = "mesh_modules."

    def __init__(
        self,
        *,
        dispatcher,
        context
    ):

        self.dispatcher = dispatcher
        self.context = context

    def load(self):
        """
        Carica e registra tutti i servizi abilitati.
        """

        services = self.context.config.get(
            "services",
            []
        )

        for service in services:

            #
            # 'name' è richiesto SEMPRE, anche per un'entry
            # disabilitata (code review 2026-08-20 §3.1, verifica
            # logica post-deploy): prima di questo fix, un'entry
            # malformata in 'services:' (campo 'name' mancante)
            # sollevava una KeyError non loggata da log.exception, a
            # differenza di ogni altro errore di caricamento gestito
            # sotto — incoerenza nella gestione errori.
            #
            try:
                name = service["name"]

            except KeyError as exc:
                log.exception(
                    "Entry 'services' malformata (chiave mancante: "
                    "%s).",
                    exc
                )

                raise

            if not service.get(
                "enabled",
                True
            ):

                log.info(
                    "Service '%s' disabled.",
                    name
                )

                continue

            #
            # 'module'/'class' vengono richiesti solo per le entry
            # ABILITATE (verifica logica post-deploy 2026-08-20) — un
            # primo tentativo di questo fix li estraeva insieme a
            # 'name', prima del controllo 'enabled': questo rompeva
            # il pattern preesistente e legittimo di un'entry
            # disabilitata/segnaposto (es. {name: futuro,
            # enabled: false}) senza 'module'/'class' ancora
            # definiti, che prima veniva saltata senza errori e con
            # questa versione del fix avrebbe invece fatto fallire
            # l'avvio dell'intero daemon, bloccando anche tutti gli
            # altri servizi correttamente configurati — l'opposto
            # dell'intento del fix originale.
            #
            try:
                module_name = (
                    self.MODULE_PREFIX +
                    service["module"]
                )
                class_name = service["class"]

            except KeyError as exc:
                log.exception(
                    "Entry 'services' malformata (chiave mancante: "
                    "%s) — service='%s'.",
                    exc,
                    name
                )

                raise

            log.info(
                "Loading service '%s'...",
                name
            )

            try:
                #
                # Import dinamico del modulo
                #
                module = importlib.import_module(
                    module_name
                )

                #
                # Recupero della classe
                #
                cls = getattr(
                    module,
                    class_name
                )

                #
                # Creazione dell'istanza
                #
                instance = cls(
                    self.context
                )

                #
                # Registrazione nel Dispatcher
                #
                self.dispatcher.register(
                    name,
                    instance
                )

                log.info(
                    "Service '%s' loaded.",
                    name
                )

            except Exception:
                log.exception(
                    "Unable to load service '%s'.",
                    name
                )

                raise
