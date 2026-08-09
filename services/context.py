from core.config import config
from core.logger import log

class ServiceContext:
    """
    Contesto condiviso tra tutti i servizi.

    Contiene esclusivamente le dipendenze comuni messe a
    disposizione dal daemon. Non espone più un riferimento diretto
    a `mesh`: i servizi devono sempre passare da `engine.mesh`,
    letto dinamicamente, per restare validi anche dopo una
    riconnessione completa.

    Non deve contenere logica applicativa.
    """

    def __init__(
        self,
        *,
        engine,
        dispatcher
    ):
        #
        # Engine proprietario della connessione
        #
        self.engine = engine

        #
        # Dispatcher centrale
        #
        self.dispatcher = dispatcher

        #
        # Configurazione globale
        #
        self.config = config

        #
        # Logger applicativo
        #
        self.logger = log
