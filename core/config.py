from pathlib import Path

import yaml

class Config:
    """
    Lettura della configurazione dell'applicazione.
    """

    def __init__(self, filename="config/config.yaml"):
        self.filename = Path(filename)
        self.reload()

    def reload(self):
        with self.filename.open(
            "r",
            encoding="utf-8"
        ) as f:

            self.data = yaml.safe_load(f) or {}

    def get(self, key, default=None):
        value = self.data

        for part in key.split("."):
            if not isinstance(value, dict):
                return default

            value = value.get(part)

            if value is None:
                return default

        return value

    def exists(self, key):
        return self.get(key) is not None

    def __getitem__(self, key):
        value = self.get(key)

        if value is None:
            raise KeyError(key)

        return value

#
# Singleton globale
#
config = Config()
