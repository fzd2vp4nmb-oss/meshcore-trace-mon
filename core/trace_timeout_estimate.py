"""
core/trace_timeout_estimate.py

Stima locale (lato client IPC, PRIMA di inviare il comando 'trace run'
al daemon) del valore di 'suggested_timeout' che il firmware calcolerà
per un dato path TRACE, dati i parametri radio reali del device — usata
per dimensionare un margine di timeout IPC lato client (ipc_timeout)
sufficientemente ampio anche per path lunghi.

Contesto della modifica (2026-08-23, v.
docs/CHANGES_trace_timeout_dinamico_hop.md): TraceModule._resolve_timeout()
non applica più 'trace.timeout' (config.yaml) come tetto massimo al
timeout dinamico ricevuto dal firmware — quando il firmware fornisce un
suggested_timeout, quello viene usato COSÌ COM'È, anche se più grande
del valore di config.yaml. L'attesa reale di TraceModule.trace() può
quindi ora superare 'trace.timeout' senza alcun limite legato a
config.yaml. Il margine di timeout IPC storico ('self.timeout + 15',
calcolato PRIMA di inviare la richiesta, senza alcuna conoscenza del
valore che il firmware restituirà) non è più garantito sufficiente per
path lunghi — questo modulo lo sostituisce con una stima per-path basata
sui parametri radio reali del device (mesh.self_info, esposti da
mesh_modules/system/service.py via IPC), quando disponibili.

IMPORTANTE — cosa NON fa questo modulo: non decide MAI quanto
TraceModule attende realmente TRACE_DATA — quella decisione resta
interamente locale al daemon, in TraceModule._resolve_timeout(), sul
valore REALE ricevuto dal firmware per QUESTA specifica richiesta. Le
funzioni qui servono solo a dimensionare, lato client IPC, un margine
sufficientemente ampio da non abbandonare la richiesta mentre il daemon
sta ancora aspettando legittimamente — una stima conservativa che sbaglia
per eccesso è innocua (il client aspetta qualche secondo in più),
mentre una stima che sbagliasse per difetto riprodurrebbe esattamente il
fallimento che questa modifica vuole evitare (v. Rev.6 §1.5 per lo
stesso pattern di fallimento, causato allora da una causa diversa).

Formula e costanti verificate contro il firmware reale (repository
pubblico MeshCore, commit d929643):
- calcDirectTimeoutMillisFor() — examples/companion_radio/MyMesh.cpp
- Mesh::createTrace() — src/Mesh.cpp (composizione payload iniziale)
- Packet::getRawLength() — src/Packet.cpp
- preambleLengthForSF() — src/helpers/radiolib/RadioLibWrappers.h
(v. docs/FIRMWARE_ANALYSIS.md §13 e
claude/analisi-pattern-trace-meshcore-2026-08-23.md §5.1/§5.3 per il
dettaglio completo). Calibrata contro un valore di suggested_timeout
osservato realmente in produzione (2026-08-23, path a 3 hop, hash a 2
byte): stima 9782.1ms contro 9780ms osservati — errore 0.02%.
"""

import math

#
# examples/companion_radio/MyMesh.cpp — calcDirectTimeoutMillisFor()
#
SEND_TIMEOUT_BASE_MILLIS = 500
DIRECT_SEND_PERHOP_FACTOR = 6.0
DIRECT_SEND_PERHOP_EXTRA_MILLIS = 250

#
# src/Mesh.cpp — Mesh::createTrace(): payload iniziale del pacchetto
# TRACE = tag(4) + auth_code(4) + flags(1), PRIMA di appendere il path
# (il path viene accodato subito dopo, in Mesh::sendDirect()).
#
TRACE_PAYLOAD_HEADER_BYTES = 9

#
# src/Packet.cpp — Packet::getRawLength(): 2 byte di header di
# pacchetto + payload_len (path_len è 0 in fase di stima per un
# pacchetto TRACE — v. Mesh::sendDirect()).
#
PACKET_HEADER_BYTES = 2

#
# Margine applicato SOPRA la stima dinamica (non sopra il valore reale
# del firmware, che qui non è ancora noto): assorbe sia il residuo
# errore del modello (~0.02% nella calibrazione contro un dato di
# produzione reale) sia l'overhead non-radio del giro IPC stesso
# (scheduling asyncio, apertura socket, round-trip locale) — v.
# docstring del modulo.
#
DEFAULT_MARGIN_FACTOR = 1.25
DEFAULT_MARGIN_FLAT_SECONDS = 15


def _symbol_time_ms(sf, bw_hz):
    return (2 ** sf) / bw_hz * 1000


def _lora_airtime_ms(
    payload_bytes,
    sf,
    bw_hz,
    cr,
    preamble_symbols,
    crc=1,
    header=0,
    de=0
):
    """
    Formula LoRa standard (Semtech/RadioLib) per l'airtime di un
    singolo pacchetto — stessa formula già usata in
    docs/FIRMWARE_ANALYSIS.md §13.1 per le richieste binarie/anonime di
    neighbor_monitor, qui applicata al pacchetto TRACE.
    """

    ts = _symbol_time_ms(sf, bw_hz)

    t_preamble = (preamble_symbols + 4.25) * ts

    numerator = 8 * payload_bytes - 4 * sf + 28 + 16 * crc - 20 * header
    denom = 4 * (sf - 2 * de)

    n_payload_symbols = 8 + max(
        math.ceil(numerator / denom) * (cr + 4),
        0
    )

    t_payload = n_payload_symbols * ts

    return t_preamble + t_payload


def _infer_path_hash_len(path):
    """
    Ritorna la lunghezza in byte degli hash di QUESTO path (1/2/4/8),
    dedotta dalla lunghezza esadecimale del primo elemento — stessa
    convenzione già usata da meshcore_py stesso per determinare 'flags'
    in send_trace() quando path è una stringa (v. commands/messaging.py,
    send_trace()).

    Ritorna None se il path non è nel formato atteso — il chiamante
    deve trattarlo come stima non disponibile, MAI sollevare
    un'eccezione: questo modulo non deve mai essere la causa di un
    fallimento della campagna trace.
    """

    if not path:
        return None

    first = path.split(",")[0].strip()

    if not first or len(first) % 2 != 0:
        return None

    try:
        bytes.fromhex(first)

    except ValueError:
        return None

    return len(first) // 2


def estimate_suggested_timeout_ms(path, radio):
    """
    Stima il valore di 'suggested_timeout' (ms) che il firmware
    calcolerà per QUESTO path, dati i parametri radio reali del device.

    'radio' è il dict esposto da SystemService.status (v.
    mesh_modules/system/service.py) — chiavi 'freq'/'bw'/'sf'/'cr',
    stessa convenzione di mesh.self_info: 'bw' in kHz, 'cr' nella
    convenzione RAW RadioLib (5-8, non l'addendo 1-4 della formula
    standard — v. sotto).

    Ritorna None se la stima non è calcolabile (radio assente/parziale,
    path malformato) — il chiamante deve SEMPRE prevedere un fallback
    per questo caso, mai trattarlo come un errore da propagare.
    """

    if not radio:
        return None

    try:
        bw_hz = float(radio["bw"]) * 1000
        sf = int(radio["sf"])
        cr_raw = int(radio["cr"])

    except (KeyError, TypeError, ValueError):
        return None

    if bw_hz <= 0 or sf <= 0:
        return None

    path_hash_len = _infer_path_hash_len(path)

    if path_hash_len is None:
        return None

    n_elem = len(
        [p for p in path.split(",") if p.strip()]
    )

    if n_elem == 0:
        return None

    payload_len = TRACE_PAYLOAD_HEADER_BYTES + n_elem * path_hash_len
    raw_packet_bytes = PACKET_HEADER_BYTES + payload_len

    #
    # mesh.self_info riporta il valore RAW RadioLib (5-8) per 'cr' — la
    # formula standard Semtech/RadioLib usa invece l'addendo (1-4) da
    # sommare a 4 per ottenere lo stesso denominatore (v.
    # docs/FIRMWARE_ANALYSIS.md §13.3: "CR=8 raw (-> CR effettivo
    # 4/8)").
    #
    cr = cr_raw - 4

    if cr < 1:
        return None

    #
    # src/helpers/radiolib/RadioLibWrappers.h — preambleLengthForSF():
    # preambolo più lungo per SF bassi ("longer preamble for lower SF
    # improves reliability").
    #
    preamble_symbols = 32 if sf <= 8 else 16

    airtime_ms = _lora_airtime_ms(
        raw_packet_bytes,
        sf,
        bw_hz,
        cr,
        preamble_symbols,
        header=0
    )

    #
    # calcDirectTimeoutMillisFor() — path_hash_count è n_elem, non
    # n_elem-1 (stessa nota già presente in
    # TraceModule._resolve_timeout() e nell'analisi firmware).
    #
    return SEND_TIMEOUT_BASE_MILLIS + (
        airtime_ms * DIRECT_SEND_PERHOP_FACTOR +
        DIRECT_SEND_PERHOP_EXTRA_MILLIS
    ) * (n_elem + 1)


def estimate_ipc_timeout(
    path,
    radio,
    static_timeout,
    margin_factor=DEFAULT_MARGIN_FACTOR,
    margin_flat=DEFAULT_MARGIN_FLAT_SECONDS
):
    """
    Calcola il timeout IPC lato client da usare per QUESTO path — il
    massimo fra:

    - la stima dinamica basata sui parametri radio reali (quando
      disponibile): la stessa conversione /800 usata da
      TraceModule._resolve_timeout() applicata alla stima di
      suggested_timeout, con un margine addizionale (v.
      DEFAULT_MARGIN_FACTOR/DEFAULT_MARGIN_FLAT_SECONDS);
    - la formula statica storica ('static_timeout + 15'), usata SEMPRE
      come pavimento — mai un margine inferiore a quello già in uso
      oggi, qualunque cosa succeda alla stima dinamica.

    Quando la stima dinamica non è calcolabile (parametri radio non
    disponibili — device non connesso, self_info non ancora popolato,
    path malformato), ritorna semplicemente la formula statica: la sola
    indisponibilità di un dato opzionale non riduce mai il margine
    rispetto al comportamento preesistente.
    """

    static_margin = static_timeout + 15

    suggested_ms = estimate_suggested_timeout_ms(path, radio)

    if suggested_ms is None:
        return static_margin

    dynamic_wait_s = suggested_ms / 800

    dynamic_margin = dynamic_wait_s * margin_factor + margin_flat

    return max(static_margin, dynamic_margin)
