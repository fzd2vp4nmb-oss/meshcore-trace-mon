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
            name = service["name"]

            if not service.get(
                "enabled",
                True
            ):

                log.info(
                    "Service '%s' disabled.",
                    name
                )

                continue

            module_name = (
                self.MODULE_PREFIX +
                service["module"]
            )

            class_name = service["class"]

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
