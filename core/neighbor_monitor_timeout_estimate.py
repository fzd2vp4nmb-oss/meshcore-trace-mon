"""
core/neighbor_monitor_timeout_estimate.py

Stima locale (lato client IPC, PRIMA di inviare 'neighbor_monitor run'
al daemon) del margine di timeout IPC necessario per un'intera
interrogazione neighbor_monitor su un repeater — equivalente, per
questo modulo, di core/trace_timeout_estimate.py per TraceEngine.

Contesto (2026-08-23, v.
claude/ricerca-neighbor-monitor-timeout-dinamico-2026-08-23.md): il
margine storico (NeighborMonitorEngine.run(): 'ipc_timeout=900',
costante fissa) è stato dimensionato a mano più volte (code review
Rev.6, poi docs/NEIGHBOR_MONITORING.md §22.1 / docs/ARCHITECTURE.md
§29) assumendo un timeout FISSO di 10s (CLI_RESPONSE_TIMEOUT) per
login e gli 11 comandi CLI — la possibilità di un timeout dinamico per
quelle richieste non era mai stata esplorata fino ad oggi (a
differenza delle 5 richieste binarie/anonime, che già usano
'suggested_timeout' dinamicamente e sono già documentate come tali).
Con mesh_modules/neighbor_monitor/neighbor_monitor.py aggiornato (
stessa giornata) per usare 'suggested_timeout' anche per login/CLI,
questo modulo stima il margine IPC aggregato coerentemente con quel
comportamento — SEMPRE con un pavimento al valore storico (900s), MAI
un margine inferiore a quello già in uso oggi (stesso principio di
core/trace_timeout_estimate.py::estimate_ipc_timeout()).

IMPORTANTE — cosa NON fa questo modulo: non decide MAI il timeout
reale di un singolo tentativo (quello resta interamente locale al
daemon, in NeighborMonitorModule, sul valore REALE ricevuto dal
firmware per QUELLA specifica richiesta — v. CLI_RESPONSE_TIMEOUT /
send_login_sync in neighbor_monitor.py). Le funzioni qui servono solo
a dimensionare, lato client IPC, un margine sufficientemente ampio da
non abbandonare la richiesta mentre il daemon sta ancora
legittimamente elaborando l'intera sessione.

Formula (calcDirectTimeoutMillisFor, la stessa di
core/trace_timeout_estimate.py::estimate_direct_timeout_ms(), non
duplicata qui) e dimensioni pacchetto verificate riga per riga contro
il firmware reale (repository pubblico meshcore-dev/MeshCore, stesso
tag companion-v1.17.1 già usato in tutto il progetto):

- status/neighbours/telemetry (PAYLOAD_TYPE_REQ): 22 byte raw fissi,
  indipendenti dal numero di hop — docs/FIRMWARE_ANALYSIS.md §13.2.
- region/basic (PAYLOAD_TYPE_ANON_REQ): 53 byte raw fissi — idem.
- login/comandi CLI (PAYLOAD_TYPE_TXT_MSG): raw variabile —
  verificato (2026-08-23) in BaseChatMesh.cpp
  (sendLogin()/sendCommandData()/sendMessage(), tutte e tre chiamano
  calcDirectTimeoutMillisFor() con lo stesso schema delle altre),
  examples/companion_radio/MyMesh.cpp (handler seriali
  CMD_SEND_LOGIN/CMD_SEND_TXT_MSG, copiano 'est_timeout' nella
  risposta MSG_SENT esattamente come per REQ/ANON_REQ/TRACE) e
  src/Mesh.cpp::createDatagram() (composizione pacchetto: header(2) +
  dest hash(1) + src hash(1) + MAC(2) + testo in chiaro
  [timestamp(4)+flag(1)+testo] arrotondato al blocco AES(16)).
  A differenza di REQ/ANON_REQ (e della formula di trace, calibrata
  allo 0.02% contro un 'suggested_timeout' osservato realmente in
  produzione), QUESTA parte non è ancora stata confrontata con un
  valore osservato realmente per un invio CLI/login — è una stima
  costruita dalla sola lettura del firmware. Il pavimento a 900s (v.
  sopra) è la protezione esplicita contro questo margine di incertezza
  aggiuntivo.

Il numero di hop verso il repeater NON è noto lato client IPC (solo il
daemon lo scopre, dentro NeighborMonitorModule.query(), via
get_contacts() — a differenza di trace, dove il path arriva già
completo dal chiamante) — v. DEFAULT_ASSUMED_HOP_COUNT.
"""

from core.trace_timeout_estimate import estimate_direct_timeout_ms

#
# docs/FIRMWARE_ANALYSIS.md §13.2 — dimensione raw fissa, verificata,
# per le 5 richieste binarie/anonime (indipendente dal numero di hop:
# l'hop count entra solo nel moltiplicatore di
# calcDirectTimeoutMillisFor, mai nel payload di queste richieste, a
# differenza di TRACE).
#
REQ_PAYLOAD_RAW_BYTES = 22
ANON_REQ_PAYLOAD_RAW_BYTES = 53

#
# src/Mesh.cpp::createDatagram() (PAYLOAD_TYPE_TXT_MSG), verificato
# 2026-08-23: header pacchetto(2) + dest hash(1) + src hash(1) +
# MAC(2), poi il testo in chiaro arrotondato al blocco AES a valle.
#
TXT_MSG_FIXED_OVERHEAD_BYTES = 2 + 1 + 1 + 2
CIPHER_BLOCK_SIZE = 16

#
# BaseChatMesh.cpp::sendMessage()/sendCommandData(): timestamp(4) + 1
# byte di flag (attempt/tipo CLI) prima del testo vero e proprio.
#
TXT_MSG_PLAINTEXT_HEADER_BYTES = 4 + 1

#
# get_contacts() è una query LOCALE al Companion (seriale/BLE/TCP), non
# una richiesta radio — nessun suggested_timeout, nessuna dipendenza
# dai parametri radio o dal numero di hop. Valore già documentato
# altrove nel progetto (docs/HANDOFF_nuova_chat_2026-08-20.md,
# "diciottesimo stadio... timeout fisso 5s").
#
GET_CONTACTS_LOCAL_TIMEOUT_SECONDS = 5.0

#
# Margine applicato sopra la stima aggregata — stesso principio di
# core/trace_timeout_estimate.py, qui più ampio (1.5 invece di 1.25,
# 30s invece di 15s) per l'incertezza aggiuntiva della parte TXT_MSG,
# non calibrata contro un dato reale (v. docstring di modulo).
#
DEFAULT_MARGIN_FACTOR = 1.5
DEFAULT_MARGIN_FLAT_SECONDS = 30

#
# Hop verso il repeater assunto quando non altrimenti noto (questo
# processo, come TraceEngine, non conosce l'out_path_len reale prima
# di inviare la richiesta IPC — solo il daemon lo scopre). Default
# conservativo: lo stesso limite superiore già usato nelle tabelle di
# confronto pubblicate (docs/NEIGHBOR_MONITORING.md §22.1,
# docs/ARCHITECTURE.md §29) — NON il caso reale attuale (0 hop,
# raccomandazione operativa già in vigore: repeater limitati a 0 hop).
# Configurabile con neighbor_monitoring.assumed_max_hop_count per un
# deployment che si discosti da quella raccomandazione.
#
DEFAULT_ASSUMED_HOP_COUNT = 3


def _txt_msg_raw_bytes(plaintext_extra_bytes):
    """
    Byte raw di un pacchetto PAYLOAD_TYPE_TXT_MSG (login o comando
    CLI) il cui contenuto testuale (password o comando) occupa
    'plaintext_extra_bytes' byte — v. docstring di modulo per la
    derivazione.
    """

    plaintext_bytes = TXT_MSG_PLAINTEXT_HEADER_BYTES + max(
        plaintext_extra_bytes,
        0
    )

    ciphertext_bytes = -(
        -plaintext_bytes // CIPHER_BLOCK_SIZE
    ) * CIPHER_BLOCK_SIZE

    return TXT_MSG_FIXED_OVERHEAD_BYTES + ciphertext_bytes


def estimate_query_worst_case_seconds(
    radio,
    max_retries,
    cli_text_byte_lengths,
    login_text_bytes=0,
    hop_count=DEFAULT_ASSUMED_HOP_COUNT,
    margin_factor=DEFAULT_MARGIN_FACTOR,
    margin_flat=DEFAULT_MARGIN_FLAT_SECONDS
):
    """
    Stima (secondi) il worst-case di UNA interrogazione
    NeighborMonitorModule.query() completa su un singolo repeater, dati
    i parametri radio reali del device — somma di tutte le 18
    richieste-tipo (get_contacts + login + 11 CLI_QUERIES + 5
    binarie/anonime), ciascuna ripetuta fino a 'max_retries' volte,
    più il margine di modulo. Stessa struttura di calcolo già usata (a
    mano, con parametri radio fissi) in docs/NEIGHBOR_MONITORING.md
    §22.1 e docs/ARCHITECTURE.md §29.

    'cli_text_byte_lengths' è la lista delle lunghezze (byte, UTF-8)
    del testo di ciascun comando in CLI_QUERIES — passata dal
    chiamante (mesh_modules/neighbor_monitor/engine.py, che importa
    CLI_QUERIES dalla singola fonte di verità in neighbor_monitor.py)
    invece che duplicata qui: questo modulo resta puro, senza
    dipendenze da mesh_modules/ — stessa convenzione di
    core/trace_timeout_estimate.py.

    Ritorna None se non calcolabile (radio assente/parziale) — il
    chiamante deve sempre prevedere un fallback al margine storico
    fisso (900s), mai un margine inferiore a quello già in uso oggi.
    """

    req_ms = estimate_direct_timeout_ms(
        REQ_PAYLOAD_RAW_BYTES,
        hop_count,
        radio
    )

    if req_ms is None:
        return None

    anon_req_ms = estimate_direct_timeout_ms(
        ANON_REQ_PAYLOAD_RAW_BYTES,
        hop_count,
        radio
    )

    login_ms = estimate_direct_timeout_ms(
        _txt_msg_raw_bytes(login_text_bytes),
        hop_count,
        radio
    )

    if anon_req_ms is None or login_ms is None:
        return None

    total_ms = 0.0

    #
    # 3 richieste REQ (status/neighbours/telemetry) + 2 ANON_REQ
    # (region/basic) — v. docstring di modulo, docs/FIRMWARE_ANALYSIS.md
    # §13.2.
    #
    total_ms += (3 * req_ms + 2 * anon_req_ms) * max_retries

    #
    # login — un solo invio per interrogazione.
    #
    total_ms += login_ms * max_retries

    #
    # 11 comandi CLI — testo specifico di ciascuno, non un'unica stima
    # "peggiore" applicata a tutti e 11: più precisa, e comunque mai
    # meno conservativa (ogni comando pesa per la propria lunghezza
    # reale, non per quella del più lungo).
    #
    for cli_bytes in cli_text_byte_lengths:

        cli_ms = estimate_direct_timeout_ms(
            _txt_msg_raw_bytes(cli_bytes),
            hop_count,
            radio
        )

        if cli_ms is None:
            return None

        total_ms += cli_ms * max_retries

    #
    # get_contacts() — locale, non radio, non dipende da 'radio' né da
    # 'hop_count'.
    #
    total_seconds = total_ms / 800.0 + (
        GET_CONTACTS_LOCAL_TIMEOUT_SECONDS * max_retries
    )

    return total_seconds * margin_factor + margin_flat


def estimate_ipc_timeout(
    radio,
    max_retries,
    cli_text_byte_lengths,
    static_ipc_timeout,
    login_text_bytes=0,
    hop_count=DEFAULT_ASSUMED_HOP_COUNT,
    margin_factor=DEFAULT_MARGIN_FACTOR,
    margin_flat=DEFAULT_MARGIN_FLAT_SECONDS,
    hop_count_is_real=False
):
    """
    Calcola il timeout IPC lato client da usare per l'interrogazione di
    UN repeater — il massimo fra la stima dinamica aggregata (quando
    calcolabile) e 'static_ipc_timeout' (il margine storico fisso, v.
    NeighborMonitorEngine.run(), oggi 900s) — usato come pavimento SOLO
    quando 'hop_count' è un'assunzione, mai un dato reale osservato (v.
    'hop_count_is_real' sotto). Stesso principio di
    core/trace_timeout_estimate.py::estimate_ipc_timeout(), qui con un
    pavimento esplicito invece che implicito nella formula statica
    storica: non esiste un equivalente "config.yaml + 15" per questo
    caso, 900s stesso è già il valore rivisto e documentato più volte
    (v. docstring di modulo) — nessuna nuova formula "storica" da
    ricalcolare, il pavimento resta il numero già in produzione oggi
    per il caso "hop count assunto".

    'hop_count_is_real' (default False, 2026-08-23, v.
    claude/ricerca-neighbor-monitor-timeout-dinamico-2026-08-23.md,
    follow-up successivo alla scoperta dell'hop count reale via
    system.contact): quando True, 'hop_count' non è più il caso
    peggiore assunto per mancanza di dati (DEFAULT_ASSUMED_HOP_COUNT o
    neighbor_monitoring.assumed_max_hop_count) ma l'out_path_len REALE
    appena osservato sul device per QUESTO repeater
    (NeighborMonitorEngine._fetch_repeater_contact(), stesso comando
    IPC system.contact) — in quel caso il pavimento storico da 900s
    NON viene applicato: viene ritornata direttamente la stima
    dinamica, che con un dato reale è già essa stessa un margine di
    sicurezza sufficiente (margin_factor/margin_flat sopra il worst
    case a 'max_retries' pieni), non un valore "ottimistico" da
    proteggere con un secondo pavimento. Verificato con un caso reale
    (repeater 0 hop, IK2XYP-RPT, 2026-08-23): 29s di tempo RF
    effettivo contro una stima dinamica worst-case di ~389.7s (già
    2.3x più bassa del pavimento 900s) — il pavimento in quello
    scenario non aggiungeva sicurezza, solo un margine sprecato.
    Rischio residuo accettato esplicitamente dall'utente: il path può
    in teoria cambiare nella breve finestra fra la verifica
    system.contact e l'esecuzione vera della query — v. discussione
    completa nel documento sopra.

    Se 'hop_count' resta un'assunzione (hop_count_is_real=False,
    default — include SEMPRE il caso 'dynamic_estimate is None', dati
    radio non disponibili: lì non c'è alcuna stima dinamica da
    ritornare, quindi il pavimento resta l'unica scelta possibile a
    prescindere da questo parametro), il comportamento resta
    esattamente quello storico: il massimo fra le due stime, mai un
    margine inferiore al pavimento.
    """

    dynamic_estimate = estimate_query_worst_case_seconds(
        radio,
        max_retries,
        cli_text_byte_lengths,
        login_text_bytes=login_text_bytes,
        hop_count=hop_count,
        margin_factor=margin_factor,
        margin_flat=margin_flat
    )

    if dynamic_estimate is None:
        return static_ipc_timeout

    if hop_count_is_real:
        return dynamic_estimate

    return max(static_ipc_timeout, dynamic_estimate)
