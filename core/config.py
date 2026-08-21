from pathlib import Path

import yaml

#
# Sentinella per distinguere "chiave assente" da "chiave presente ma
# esplicitamente null/None" (code review 2026-08-20, §4) — prima
# get() usava "value is None" sia per fermare la discesa sui livelli
# intermedi assenti, sia come valore finale, quindi una chiave YAML
# scritta come "foo: null" o "foo:" (vuota) era indistinguibile da
# una chiave del tutto assente: get("foo", "bar") tornava "bar" in
# entrambi i casi, anche se l'utente aveva esplicitamente voluto
# null. Con la sentinella, solo l'assenza reale (a qualunque livello
# del path) fa scattare il default; un valore null esplicito
# all'ultimo livello viene restituito come None.
#
_MISSING = object()


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
        parts = key.split(".")

        for i, part in enumerate(parts):
            if not isinstance(value, dict):
                return default

            if part not in value:
                return default

            value = value[part]

            #
            # None a un livello INTERMEDIO del path (es. "a.b.c" con
            # "a.b" esplicitamente null) non può contenere altre
            # chiavi sotto di sé: è comunque "assente" ai fini della
            # discesa, quindi cade sul default. Solo un None
            # sull'ULTIMO segmento del path è un valore esplicito
            # legittimo, restituito così com'è.
            #
            if value is None and i < len(parts) - 1:
                return default

        return value

    def exists(self, key):
        value = self.data

        for part in key.split("."):
            if not isinstance(value, dict) or part not in value:
                return False

            value = value[part]

        return True

    def __getitem__(self, key):
        value = self.get(key)

        if value is None:
            raise KeyError(key)

        return value

#
# Singleton globale
#
config = Config()
