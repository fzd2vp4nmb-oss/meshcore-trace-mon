from core.logger import log

class Dispatcher:
    """
    Dispatcher centrale dei servizi.
    Ogni servizio viene registrato con un nome
    (es. system, trace, bot...) ed espone il metodo:

        execute(request)

    Il Dispatcher non conosce il contenuto dei servizi,
    ma si limita ad instradare la richiesta.
    """

    def __init__(self):
        self._services = {}

    def register(
        self,
        name,
        service
    ):
        """
        Registra un servizio.
        """

        self._services[name] = service

        log.info(
            "Service registered: %s",
            name
        )

    def unregister(
        self,
        name
    ):
        """
        Rimuove un servizio.
        """

        if name in self._services:
            del self._services[name]

            log.info(
                "Service unregistered: %s",
                name
            )

    def exists(
        self,
        name
    ):

        return name in self._services

    def services(self):
        return sorted(
            self._services.keys()
        )

    async def dispatch(
        self,
        request
    ):
        """
        Instrada una richiesta verso il servizio corretto.
        """

        service_name = request.get(
            "service"
        )

        if service_name is None:
            return {
                "version": 1,
                "status": "error",
                "message": "missing service"
            }

        service = self._services.get(
            service_name
        )

        if service is None:
            return {
                "version": 1,
                "status": "error",
                "message": f"unknown service '{service_name}'"
            }

        return await service.execute(
            request
        )
