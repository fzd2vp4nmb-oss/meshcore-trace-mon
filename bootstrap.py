from pathlib import Path

#
# Root del progetto
#
PROJECT_ROOT = Path(__file__).resolve().parent

def bootstrap():
    """
    Bootstrap dell'applicazione.
    Attualmente:

      - restituisce la root del progetto

    In futuro sarà il punto unico di inizializzazione
    dell'intera piattaforma.
    """

    return PROJECT_ROOT
