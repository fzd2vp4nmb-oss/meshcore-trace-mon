from dataclasses import dataclass
from typing import Optional


@dataclass
class CommandContext:
    """
    Contesto passato a ogni comando del bot — normalizzato, così i
    comandi non devono sapere se il messaggio arriva da canale o DM.

    engine          Engine condiviso.
    is_dm           True se il messaggio è un DM (CONTACT_MSG_RECV),
                     False se è un messaggio di canale.
    sender_name     Nome del mittente (estratto dal testo per il
                     canale, da contact['adv_name'] per i DM).
    region          Scope/regione risolta (solo canale, sempre None
                     per i DM in questa versione — vedi
                     ARCHITECTURE.md).
    path_hex        Stringa esadecimale del path, già normalizzata:
                     canale -> payload['path']; DM -> contact['out_path'].
                     None se il path non è noto (DM con out_path_len
                     255 o -1, "instradamento sconosciuto" — v.
                     UNKNOWN_OUT_PATH_VALUES in bot.py).
    path_len        Numero di hop corrispondente a path_hex. None con
                     lo stesso significato di path_hex=None.
    rssi            RSSI rilevato, None se non disponibile (i DM non
                     lo espongono sempre).
    snr             SNR rilevato.
    reply_budget    Caratteri disponibili per il CONTENUTO della
                     risposta (già al netto di eventuale prefisso
                     "@[nome] ", che i DM non usano).
    arg             Testo dopo il nome del comando (es. "Milano" per
                     "!meteo Milano"), None se il comando è stato
                     invocato senza argomento — comportamento
                     invariato per i comandi che non lo usano
                     (!path, !ping, !info). Non normalizzato (case
                     preservato così come digitato), a differenza del
                     nome comando.
    channel         Info canale (solo messaggi di canale, None per i
                     DM).
    contact         Contatto risolto (solo DM, None per i messaggi di
                     canale) — usato da BotModule per sapere a chi
                     inviare la risposta, i comandi non ne hanno
                     normalmente bisogno.
    """

    engine: object
    is_dm: bool
    sender_name: str
    region: Optional[str]
    path_hex: Optional[str]
    path_len: Optional[int]
    rssi: Optional[float]
    snr: Optional[float]
    reply_budget: int
    arg: Optional[str] = None
    channel: Optional[dict] = None
    contact: Optional[dict] = None
