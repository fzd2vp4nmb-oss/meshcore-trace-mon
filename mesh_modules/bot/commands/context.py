from dataclasses import dataclass
from typing import Optional


@dataclass
class CommandContext:
    """
    Contesto passato a ogni comando del bot — normalizzato, così i
    comandi non devono sapere da dove arriva il messaggio (in
    precedenza poteva essere canale o DM; le DM sono state rimosse il
    2026-08-23, v. ARCHITECTURE.md — sezione dedicata — restano solo
    i messaggi di canale, ma il contesto resta normalizzato per non
    accoppiare i comandi al canale specificamente).

    engine          Engine condiviso.
    sender_name     Nome del mittente, estratto dal testo del
                     messaggio di canale.
    region          Scope/regione risolta del messaggio.
    path_hex        Stringa esadecimale del path da payload['path'].
    path_len        Numero di hop corrispondente a path_hex.
    rssi            RSSI rilevato, None se non disponibile.
    snr             SNR rilevato.
    reply_budget    Caratteri disponibili per il CONTENUTO della
                     risposta (già al netto del prefisso "@[nome] ").
    arg             Testo dopo il nome del comando (es. "Milano" per
                     "!meteo Milano"), None se il comando è stato
                     invocato senza argomento — comportamento
                     invariato per i comandi che non lo usano
                     (!path, !ping, !info). Non normalizzato (case
                     preservato così come digitato), a differenza del
                     nome comando.
    channel         Info canale del messaggio.
    """

    engine: object
    sender_name: str
    region: Optional[str]
    path_hex: Optional[str]
    path_len: Optional[int]
    rssi: Optional[float]
    snr: Optional[float]
    reply_budget: int
    arg: Optional[str] = None
    channel: Optional[dict] = None
