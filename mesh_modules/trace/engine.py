import asyncio

from core.config import config
from core.logger import log
from core.trace_paths import parse_path_entry
from core.trace_timeout_estimate import estimate_ipc_timeout
from clients.ipc_client import IPCClient
from mesh_modules.trace.writer import TraceWriter

class TraceEngine:
    """
    Coordina una campagna di acquisizione TRACE.

    I trace vengono richiesti al daemon tramite IPC,
    mentre la scrittura del file trace.json rimane
    locale a questo processo.
    """

    def __init__(self):
        #
        # Client IPC verso il daemon
        #
        self.client = IPCClient()

        #
        # Writer del file trace.json
        #
        self.writer = TraceWriter(
            config["trace.output_file"]
        )

        #
        # Configurazione — ogni entry può portare un suffisso
        # ,true/,false per abilitare/disabilitare il path senza
        # rimuoverlo da config.yaml (vedi core/trace_paths.py).
        #
        self.paths = config["trace.paths"]

        self.interval = config.get(
            "trace.interval",
            10
        )

        self.timeout = config.get(
            "trace.timeout",
            15
        )

    async def _fetch_radio_params(self):
        """
        Interroga il daemon per i parametri radio reali del device
        (mesh.self_info, esposti via IPC da
        mesh_modules/system/service.py, comando 'system.status') PRIMA
        di eseguire la campagna — usati per stimare un margine di
        timeout IPC più accurato per ciascun path (v.
        core/trace_timeout_estimate.py), invece della formula statica
        storica 'self.timeout + 15'.

        Decisione 2026-08-23 (v.
        docs/CHANGES_trace_timeout_dinamico_hop.md): dato che
        TraceModule._resolve_timeout() non applica più 'trace.timeout'
        come tetto massimo al timeout dinamico dal firmware, l'attesa
        reale di una trace può ora superare quel valore senza limite —
        il margine IPC statico storico non è più garantito sufficiente
        per path lunghi.

        Un fallimento qui (daemon non raggiungibile, socket assente,
        device non ancora connesso, self_info non ancora popolato) NON
        deve MAI interrompere la campagna né un singolo path: ritorna
        semplicemente None, e ogni path di questa esecuzione userà la
        formula statica storica come già accadeva prima di questa
        modifica — un dato accessorio la cui assenza non deve mai
        precludere l'esecuzione delle trace vere e proprie. Interrogato
        una sola volta per l'intera campagna (non per singolo path): i
        parametri radio del device non cambiano nel corso di una stessa
        esecuzione di TraceEngine.
        """

        try:
            response = await self.client.request(
                service="system",
                command="status"
            )

        except Exception as e:
            log.warning(
                "TRACE: impossibile ottenere i parametri radio dal "
                "daemon (%s) — userò il margine di timeout IPC statico "
                "per tutti i path di questa campagna.",
                e
            )
            return None

        if response.get("status") != "ok":
            log.info(
                "TRACE: system.status non disponibile (%s) — userò il "
                "margine di timeout IPC statico per tutti i path di "
                "questa campagna.",
                response.get("message", "risposta IPC senza dettagli")
            )
            return None

        radio = response.get("result", {}).get("radio")

        if not radio:
            log.info(
                "TRACE: parametri radio non ancora disponibili dal "
                "daemon (device non connesso, o self_info non ancora "
                "ricevuto) — userò il margine di timeout IPC statico "
                "per tutti i path di questa campagna."
            )
            return None

        log.info(
            "TRACE: parametri radio ottenuti dal daemon (sf=%s, "
            "bw=%skHz, cr=%s) — userò una stima dinamica del margine "
            "di timeout IPC per ciascun path.",
            radio.get("sf"),
            radio.get("bw"),
            radio.get("cr")
        )

        return radio

    async def run(self):
        """
        Esegue una singola acquisizione di tutti i path
        configurati (quelli abilitati) e termina.
        """

        enabled_paths = []

        for entry in self.paths:

            #
            # Una entry malformata in trace.paths (code review
            # 2026-08-20, §4) non deve far fallire l'intera campagna
            # — viene saltata e loggata, coerente con il trattamento
            # già riservato agli errori di scrittura più sotto.
            #
            try:
                path, enabled = parse_path_entry(entry)

            except ValueError:
                log.exception(
                    "TRACE: entry non valida in trace.paths, saltata: %r",
                    entry
                )
                continue

            if enabled:
                enabled_paths.append(path)

            else:
                log.info(
                    "TRACE: path %s disabilitato in config.yaml, "
                    "saltato.",
                    path
                )

        #
        # Una sola interrogazione per l'intera campagna (non per
        # singolo path) — v. _fetch_radio_params(). None se non
        # disponibili: ogni stima per-path degrada allora da sola alla
        # formula statica storica (v. core/trace_timeout_estimate.py).
        # Saltata del tutto se non c'è alcun path abilitato da
        # eseguire — nessun motivo di interrogare il daemon a vuoto.
        #
        radio = (
            await self._fetch_radio_params()
            if enabled_paths else
            None
        )

        for i, path in enumerate(enabled_paths):

            #
            # Il servizio 'trace' attende fino al timeout dinamico
            # ricevuto dal firmware per QUESTO path — che, dal
            # 2026-08-23, non è più limitato da 'self.timeout' (v.
            # TraceModule._resolve_timeout()) — prima di arrendersi. Il
            # timeout IPC lato client deve restare più ampio di quello,
            # altrimenti il client abbandonerebbe la connessione
            # (IPCError) mentre il daemon sta ancora aspettando
            # legittimamente, rispondendo poi "a vuoto" su un socket
            # già chiuso. Stimato per-path dai parametri radio reali
            # quando disponibili, altrimenti dalla stessa formula
            # statica di sempre ('self.timeout + 15') — mai un margine
            # inferiore a quello storico.
            #
            ipc_timeout = estimate_ipc_timeout(
                path,
                radio,
                self.timeout
            )

            #
            # Osservabilità (2026-08-23, richiesta utente — v.
            # docs/CHANGES_trace_timeout_dinamico_hop.md): riporta il
            # solo valore usato, senza alcun confronto con la formula
            # statica storica — stessa impostazione già applicata al
            # log del timeout radio in TraceModule._resolve_timeout().
            #
            log.info(
                "TRACE: [path:%s] margine di timeout IPC: %.1fs.",
                path,
                ipc_timeout
            )

            #
            # 'timeout' NON viene più passato esplicitamente qui
            # (2026-08-23, richiesta utente — v.
            # docs/CHANGES_trace_timeout_dinamico_hop.md, "Log
            # fuorviante"): prima veniva sempre inviato
            # 'timeout=self.timeout' (il fallback di config.yaml), e
            # compariva così com'è nel log generico del daemon "IPC
            # Request: {...}" (services/ipc_server.py) — dando
            # l'impressione, sbagliata, che QUELLO fosse il timeout
            # che sarebbe stato realmente atteso, quando invece il
            # valore vero si scopre solo dopo il giro radio, dentro
            # TraceModule._resolve_timeout(). Omettendo la chiave (già
            # la convenzione di tools/test_trace.py senza argomento
            # CLI), il campo semplicemente non compare più in quel log
            # — nessun numero fuorviante da mostrare. Comportamento
            # sul daemon INVARIATO nel caso comune: TraceService legge
            # 'timeout' assente come None, TraceModule.trace() lo
            # risolve a self.timeout (la propria copia, lato daemon) —
            # stesso identico valore che sarebbe stato inviato prima,
            # per costruzione (config.yaml è lo stesso file). Unica
            # differenza, migliorativa: nella rara finestra transitoria
            # in cui config.yaml è stato modificato senza riavviare il
            # daemon (v. "Caso limite: config del daemon stantia" più
            # sotto in questo file), la logica dinamica ora resta
            # SEMPRE attiva (il confronto usa solo il valore del
            # daemon, mai quello — potenzialmente diverso — di questo
            # processo cron) invece di essere disattivata per quella
            # singola invocazione.
            #
            response = await self.client.request(
                service="trace",
                command="run",
                path=path,
                ipc_timeout=ipc_timeout
            )

            #
            # Compatibilità con trace.sh storico.
            #
            # Accesso difensivo (code review 2026-08-20, §4) — prima
            # un accesso diretto con [] a "status"/"result"/"message"
            # avrebbe fatto fallire con un KeyError grezzo l'intera
            # campagna se il daemon avesse mai risposto con un
            # payload IPC malformato (bug lato daemon, versione IPC
            # disallineata, ecc.), invece di degradare al solo path
            # corrente come già avviene per gli errori di scrittura.
            #
            if response.get("status") == "ok":
                payload = response.get("result", {})

            else:

                payload = {
                    "error": response.get("message", "risposta IPC senza dettagli")
                }

            #
            # Un errore di I/O qui (disco pieno, permessi) prima di
            # questo fix (code review 2026-08-20, §3.2) interrompeva
            # l'intero batch invece del solo path corrente — gli
            # altri path già interrogati con successo restavano
            # comunque persi se non ancora scritti su disco.
            #
            try:
                self.writer.write(
                    trace_path=path,
                    payload=payload
                )

            except Exception:
                log.exception(
                    "TRACE: scrittura su trace.json fallita per il "
                    "path %s — proseguo con i path successivi.",
                    path
                )

            #
            # Attesa tra un trace e il successivo — non dopo l'ultimo
            #
            if i < len(enabled_paths) - 1:
                await asyncio.sleep(
                    self.interval
                )
