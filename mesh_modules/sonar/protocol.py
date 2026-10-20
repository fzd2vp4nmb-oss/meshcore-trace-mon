"""
mesh_modules/sonar/protocol.py

Formato del messaggio sonar e normalizzazione dello scope — SOLO
funzioni pure, nessun accesso a device, DB, config o logger: tutto
ciò che decide "cosa si scrive" e "cosa si accetta" sta qui, così
trasmissione e ricezione condividono per costruzione la stessa
definizione e i test possono verificarla senza alcun mock.
(docs/ARCHITECTURE.md §87)

Formato (versione 1), testo del messaggio di canale:

    TM1|<src_prefix>|<seq>|<scope_tag>

    src_prefix  8 caratteri esadecimali MINUSCOLI: primi 4 byte della
                chiave pubblica del companion trasmittente. Identifica
                il mittente senza dipendere dal nome (ambiguo, v.
                core/contact_lookup.py) e si collega a
                nodes.public_key per prefisso, come gli hash dei path.
    seq         progressivo decimale del mittente, senza zeri iniziali,
                da 1 a MAX_SEQ (12 cifre). NON è un identificatore
                globale: due nodi hanno sequenze indipendenti.
    scope_tag   'U' = inviato con scope unscoped forzato, 'D' = scope di
                default del device, altrimenti il nome della regione.
                Dichiarato dal mittente, non verificato dal ricevente.

Il firmware antepone al testo "<nome device>: " (v. docs/ARCHITECTURE.md
§16): il ricevente lo riceve quindi come "<nome>: TM1|...". Il formato
non inizia mai con '!' (prefisso dei comandi del bot) e il bot non
legge comunque questo canale.

Il formato NON è configurabile (v. docs/ARCHITECTURE.md §87): tutti i
nodi devono condividere lo stesso parser, e un nodo con un formato
diverso produrrebbe dati scartati in silenzio da tutti gli altri.
Cambiare il formato = nuova versione del tag ('TM2'), mai una
modifica silenziosa di 'TM1'.
"""

import re


PROTOCOL_TAG = "TM1"

SEPARATOR = "|"

#
# Lunghezza in caratteri esadecimali del prefisso della chiave pubblica
# scritto nel testo (4 byte).
#
SRC_PREFIX_LEN = 8

#
# 12 cifre decimali: ben oltre qualunque progressivo realistico (un
# messaggio ogni minuto per 1,9 milioni di anni) e ampiamente dentro
# l'intervallo degli INTEGER di SQLite (8 byte). Il tetto serve
# soprattutto in ricezione: un seq enorme in un messaggio malformato
# non deve mai arrivare al database.
#
MAX_SEQ = 999_999_999_999

#
# Lunghezza massima del testo ricevuto che si accetta di analizzare:
# il payload di un messaggio di canale è limitato a 184 byte dal
# firmware, ma un messaggio sonar ben formato ne occupa meno di 70
# (nome device incluso). Oltre questa soglia è certamente altro.
#
MAX_TEXT_LEN = 200

SCOPE_TAG_UNSCOPED = "U"
SCOPE_TAG_DEFAULT = "D"

#
# Valori passati a mesh.commands.set_flood_scope() (v.
# docs/ARCHITECTURE.md §17): "*" = unscoped FORZATO (comando diverso
# sul filo), "" = ritorno al default del device, altrimenti il nome
# di una regione.
#
SCOPE_CMD_UNSCOPED = "*"
SCOPE_CMD_DEFAULT = ""

#
# Nome di regione ammesso: stessi caratteri dei nomi in
# bot.known_regions (minuscole, cifre, '-'), più maiuscole e '_' per
# non rifiutare un nome valido scritto in modo diverso. Inizia con un
# carattere alfanumerico: niente '-' iniziale, e soprattutto niente
# '!' né '|' (separatore del formato) né spazi.
#
_REGION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$")

_SRC_PREFIX_RE = re.compile(r"^[0-9a-f]{%d}$" % SRC_PREFIX_LEN)

#
# Corpo del messaggio ancorato in CODA al testo ricevuto, preceduto da
# inizio testo o dal separatore ": " del firmware. L'ancoraggio in coda
# rende il risultato deterministico anche se il nome del mittente
# contiene a sua volta ": " o testo simile al formato.
#
_BODY_RE = re.compile(
    r"(?:^|: )"
    + re.escape(PROTOCOL_TAG)
    + r"\|(?P<src>[0-9a-f]{%d})" % SRC_PREFIX_LEN
    + r"\|(?P<seq>[1-9][0-9]{0,11})"
    + r"\|(?P<tag>[A-Za-z0-9][A-Za-z0-9_-]{0,30})"
    + r"[\s\x00]*$"
)


class SonarMessage:
    """Risultato del parsing di un messaggio sonar (sola lettura)."""

    __slots__ = ("src_prefix", "seq", "scope_tag")

    def __init__(self, src_prefix, seq, scope_tag):
        self.src_prefix = src_prefix
        self.seq = seq
        self.scope_tag = scope_tag

    def __eq__(self, other):
        return (
            isinstance(other, SonarMessage)
            and self.src_prefix == other.src_prefix
            and self.seq == other.seq
            and self.scope_tag == other.scope_tag
        )

    def __repr__(self):
        return (
            f"SonarMessage(src_prefix={self.src_prefix!r}, "
            f"seq={self.seq!r}, scope_tag={self.scope_tag!r})"
        )


def normalize_scope(scope):
    """
    Normalizza uno scope scritto dall'utente (config.yaml, riga di
    comando) in (comando, tag): 'comando' è l'argomento da passare a
    set_flood_scope(), 'tag' è la stringa scritta nel messaggio.

    Ammessi:
      "*" oppure "U"          -> ("*", "U")   unscoped forzato
      ""  oppure "D"          -> ("", "D")    default del device
      "nome" oppure "#nome"   -> ("nome", "nome")   regione

    Le due scritture alternative esistono perché '*' e la stringa
    vuota sono scomodi da passare dalla shell/cron (glob, argomento
    vuoto) mentre 'U'/'D' no; entrambe valgono ovunque. Un nome di
    regione uguale a 'U' o 'D' è rifiutato per non essere ambiguo.

    Solleva ValueError con un messaggio leggibile se lo scope non è
    valido (il chiamante lo trasforma in errore di configurazione o
    di richiesta — questa funzione non conosce né l'uno né l'altra).
    """

    if not isinstance(scope, str):
        raise ValueError(
            f"scope deve essere una stringa (ricevuto "
            f"{type(scope).__name__})"
        )

    scope = scope.strip()

    if scope in ("*", SCOPE_TAG_UNSCOPED):
        return SCOPE_CMD_UNSCOPED, SCOPE_TAG_UNSCOPED

    if scope in ("", SCOPE_TAG_DEFAULT):
        return SCOPE_CMD_DEFAULT, SCOPE_TAG_DEFAULT

    if scope.startswith("#"):
        scope = scope[1:]

    if not _REGION_RE.match(scope):
        raise ValueError(
            "scope non valido: ammessi '*' (o 'U') per unscoped, '' "
            "(o 'D') per il default del device, oppure un nome di "
            "regione di lettere, cifre, '-' e '_' (max 31 caratteri)"
        )

    if scope in (SCOPE_TAG_UNSCOPED, SCOPE_TAG_DEFAULT):
        raise ValueError(
            f"nome di regione '{scope}' ambiguo con i tag riservati "
            f"'U'/'D'"
        )

    return scope, scope


def build_message(src_prefix, seq, scope_tag):
    """
    Costruisce il testo del messaggio sonar. Solleva ValueError se un
    campo non rispetta il formato — mai un messaggio malformato
    trasmesso in aria.
    """

    if not isinstance(src_prefix, str) or not _SRC_PREFIX_RE.match(src_prefix):
        raise ValueError(
            f"src_prefix deve essere di {SRC_PREFIX_LEN} caratteri "
            f"esadecimali minuscoli"
        )

    if (
        not isinstance(seq, int)
        or isinstance(seq, bool)
        or not 1 <= seq <= MAX_SEQ
    ):
        raise ValueError(f"seq deve essere un intero tra 1 e {MAX_SEQ}")

    if not isinstance(scope_tag, str) or not (
        scope_tag in (SCOPE_TAG_UNSCOPED, SCOPE_TAG_DEFAULT)
        or _REGION_RE.match(scope_tag)
    ):
        raise ValueError("scope_tag non valido")

    return SEPARATOR.join((PROTOCOL_TAG, src_prefix, str(seq), scope_tag))


def parse_channel_text(text):
    """
    Analizza il testo di un messaggio di canale (con o senza il
    prefisso "<nome device>: " del firmware) e ritorna un
    SonarMessage, oppure None se non è un messaggio sonar ben formato
    (testo qualunque di un utente, versione diversa del formato,
    campi fuori formato, troppo lungo). Non solleva mai.

    Rigoroso di proposito: nessuna normalizzazione indulgente (niente
    maiuscole nell'hex, niente zeri iniziali nel seq) — un testo non
    prodotto da build_message() non è un sonar di questa versione.
    """

    if not isinstance(text, str) or len(text) > MAX_TEXT_LEN:
        return None

    match = _BODY_RE.search(text)

    if match is None:
        return None

    seq = int(match.group("seq"))

    if seq > MAX_SEQ:
        return None

    return SonarMessage(
        src_prefix=match.group("src"),
        seq=seq,
        scope_tag=match.group("tag")
    )


def src_prefix_from_public_key(public_key):
    """
    Prefisso (SRC_PREFIX_LEN esadecimali minuscoli) di una chiave
    pubblica esadecimale — tipicamente mesh.self_info["public_key"] —
    oppure None se non è utilizzabile (assente, non esadecimale, più
    corta del prefisso).
    """

    if not isinstance(public_key, str):
        return None

    prefix = public_key[:SRC_PREFIX_LEN].lower()

    if not _SRC_PREFIX_RE.match(prefix):
        return None

    return prefix
