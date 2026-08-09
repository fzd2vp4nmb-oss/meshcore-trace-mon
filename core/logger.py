import logging
from pathlib import Path
from core.config import config

class Logger:
    """
    Logger centralizzato dell'applicazione.

    Configura sia il logger dell'applicazione ("trace-mon")
    sia il logger della libreria meshcore, utilizzando
    le impostazioni definite in config.yaml.
    """
    def __init__(self):
        logfile = Path(config["logging.file"])
        logfile.parent.mkdir(
            parents=True,
            exist_ok=True
        )

        level = getattr(
            logging,
            config.get("logging.level", "INFO").upper(),
            logging.INFO
        )

        formatter = logging.Formatter(
            fmt="%(asctime)s %(levelname)-8s %(name)-10s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S"
        )

        #
        # Handler file (comune)
        #
        file_handler = logging.FileHandler(
            logfile,
            encoding="utf-8"
        )

        file_handler.setFormatter(formatter)

        #
        # Handler console (opzionale)
        #
        console_handler = None

        if config.get("logging.console", False):
            console_handler = logging.StreamHandler()
            console_handler.setFormatter(formatter)

        #
        # Logger applicazione
        #
        self.logger = logging.getLogger("trace-mon")

        self._configure_logger(
            self.logger,
            level,
            file_handler,
            console_handler
        )

        #
        # Logger meshcore_py
        #
        meshcore_logger = logging.getLogger("meshcore")

        self._configure_logger(
            meshcore_logger,
            level,
            file_handler,
            console_handler
        )

    def _configure_logger(
        self,
        logger,
        level,
        file_handler,
        console_handler
    ):
        """
        Configura un logger evitando duplicazioni.
        """

        logger.setLevel(level)

        #
        # Evita propagazione verso il root logger
        #
        logger.propagate = False

        #
        # Rimuove eventuali handler già presenti
        #
        logger.handlers.clear()
        logger.addHandler(file_handler)

        if console_handler is not None:
            logger.addHandler(console_handler)

    def __getattr__(self, item):
        return getattr(self.logger, item)


#
# Singleton globale
#
log = Logger()
