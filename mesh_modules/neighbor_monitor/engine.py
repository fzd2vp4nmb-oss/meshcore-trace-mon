import asyncio

from core.config import config
from core.logger import log
from core.neighbor_monitor_timeout_estimate import estimate_ipc_timeout
from clients.ipc_client import IPCClient
from mesh_modules.neighbor_monitor.writer import NeighborMonitorWriter
from mesh_modules.neighbor_monitor.neighbor_monitor import CLI_QUERIES


class NeighborMonitorEngine:
    """
    Coordina una campagna di interrogazione repeater (status +
    neighbours).

    Le query vengono richieste al daemon tramite IPC (stesso
    disaccoppiamento già usato da TraceEngine), mentre la scrittura
    in contacts.db resta locale a questo processo — coerente con
    tools/rotate_path_observations.py, che tocca lo stesso file da
    un processo separato dal daemon.
    """

    def __init__(self):

        self.client = IPCClient()

        self.writer = NeighborMonitorWriter(
            config["contacts.db_file"]
        )

        self.repeaters = config.get(
            "neighbor_monitoring.repeaters",
            []
        )

        #
        # Attesa tra una query e la successiva quando sono
        # configurati più repeater — stesso ruolo di trace.interval,
        # per non mandare le richieste radio una via l'altra senza
        # respiro.
        #
        self.interval = config.get(
            "neighbor_monitoring.interval",
            5
        )

        #
        # Copie locali degli stessi parametri letti da
        # NeighborMonitorModule per il calcolo del margine IPC (v.
        # _fetch_radio_params()/run() sotto) — questo processo e il
        # daemon leggono lo stesso config.yaml, stesso principio già
        # applicato a TraceEngine.timeout/self.timeout.
        #
        self.max_retries = max(
            1,
            int(config.get("neighbor_monitoring.max_retries", 3))
        )

        self.assumed_hop_count = config.get(
            "neighbor_monitoring.assumed_max_hop_count",
            None
        )

        #
        # Margine storico fisso — v. run() sotto: resta SEMPRE il
        # pavimento della stima dinamica, mai un margine inferiore a
        # questo (2026-08-23, v.
        # claude/ricerca-neighbor-monitor-timeout-dinamico-2026-08-23.md).
        #
        self.static_ipc_timeout = config.get(
            "neighbor_monitoring.static_ipc_timeout",
            900
        )

        #
        # Lunghezza (byte, UTF-8) del testo di ciascun comando in
        # CLI_QUERIES — calcolata una sola volta qui, dalla singola
        # fonte di verità in neighbor_monitor.py, invece che duplicata
        # in core/neighbor_monitor_timeout_estimate.py (che resta puro,
        # senza dipendenze da mesh_modules/ — stessa convenzione di
        # core/trace_timeout_estimate.py).
        #
        self._cli_text_byte_lengths = [
            len(cmd_text.encode("utf-8"))
            for _, cmd_text, _ in CLI_QUERIES
        ]

    async def _fetch_radio_params(self):
        """
        Interroga il daemon per i parametri radio reali del device
        (mesh.self_info, esposti via IPC da
        mesh_modules/system/service.py, comando 'system.status') PRIMA
        di eseguire la campagna — usati per stimare un margine di
        timeout IPC aggregato più accurato (v.
        core/neighbor_monitor_timeout_estimate.py), invece del solo
        margine statico fisso storico.

        Stessa logica, stesso principio di tolleranza al fallimento di
        TraceEngine._fetch_radio_params() (v.
        mesh_modules/trace/engine.py) — duplicata qui invece di
        condivisa perché sono due processi cron indipendenti, stessa
        convenzione già in uso nel progetto (tools/test_trace.py
        duplica la stessa logica per lo stesso motivo). Un fallimento
        qui (daemon non raggiungibile, socket assente, device non
        ancora connesso, self_info non ancora popolato) NON deve MAI
        interrompere la campagna: ritorna semplicemente None, e ogni
        repeater di questa esecuzione userà il margine statico storico
        come pavimento — un dato accessorio la cui assenza non deve
        mai precludere l'esecuzione delle interrogazioni vere e
        proprie. Interrogato una sola volta per l'intera campagna (non
        per singolo repeater): i parametri radio del device non
        cambiano nel corso di una stessa esecuzione di
        NeighborMonitorEngine.
        """

        try:
            response = await self.client.request(
                service="system",
                command="status"
            )

        except Exception as e:
            log.warning(
                "NeighborMonitorEngine: impossibile ottenere i "
                "parametri radio dal daemon (%s) — userò il margine "
                "di timeout IPC statico per tutti i repeater di "
                "questa campagna.",
                e
            )
            return None

        if response.get("status") != "ok":
            log.info(
                "NeighborMonitorEngine: system.status non disponibile "
                "(%s) — userò il margine di timeout IPC statico per "
                "tutti i repeater di questa campagna.",
                response.get("message", "risposta IPC senza dettagli")
            )
            return None

        radio = response.get("result", {}).get("radio")

        if not radio:
            log.info(
                "NeighborMonitorEngine: parametri radio non ancora "
                "disponibili dal daemon (device non connesso, o "
                "self_info non ancora ricevuto) — userò il margine di "
                "timeout IPC statico per tutti i repeater di questa "
                "campagna."
            )
            return None

        log.info(
            "NeighborMonitorEngine: parametri radio ottenuti dal "
            "daemon (sf=%s, bw=%skHz, cr=%s) — userò una stima "
            "dinamica del margine di timeout IPC per ciascun "
            "repeater.",
            radio.get("sf"),
            radio.get("bw"),
            radio.get("cr")
        )

        return radio

    async def _fetch_repeater_contact(self, name):
        """
        Interroga il daemon per il contatto REALE e aggiornato di
        QUESTO specifico repeater — comando IPC 'system.contact', già
        esistente (v. mesh_modules/system/service.py::_contact_info()),
        usato oggi per la diagnostica interattiva del routing verso un
        contatto — PRIMA di stimare il margine di timeout IPC e di
        avviare la query vera e propria (2026-08-23, richiesta utente
        dopo un run reale con IK2XYP-RPT a 0 hop che mostrava comunque
        il margine calcolato sull'assunzione conservativa di 3 hop —
        v. claude/ricerca-neighbor-monitor-timeout-dinamico-2026-08-23.md
        per la discussione completa, incluso il follow-up sul riuso del
        risultato in run() sotto).

        NON legge contacts.db (nodes.out_path_len) — deliberatamente:
        quella tabella è per design pensata per catturare la
        DIVERSITÀ dei path osservati verso lo stesso nodo nel tempo
        (lo stesso advert può arrivare via più rotte), non un singolo
        valore "corrente" — riusarla qui per decidere l'hop count di
        QUESTA interrogazione confonderebbe due scopi distinti e
        introdurrebbe comunque la staleness del sync periodico.

        NON legge nemmeno self.engine.mesh.contacts "a freddo" — quella
        cache si aggiorna SOLO quando qualcuno esegue esplicitamente un
        get_contacts(), mai sui singoli advert in arrivo
        (PUSH_CODE_NEW_ADVERT viene dispatchato come evento ma non
        scritto in mesh.contacts, verificato in reader.py) — può quindi
        essere stantia esattamente come contacts.db. Il comando IPC
        'system.contact' evita il problema alla radice: fa SEMPRE un
        get_contacts() fresco (query LOCALE al Companion, non radio —
        _refresh_and_get_contacts() in system/service.py, stesso
        principio già stabilito lì per lo stesso motivo, code review
        2026-08-20) prima di rispondere. Il repeater configurato in
        neighbor_monitoring.repeaters è per costruzione un contatto
        salvato come preferito sul device (mai soggetto all'auto-
        rimozione al limite dei 350 contatti) — questa richiesta lo
        trova quindi sempre, salvo device non connesso in quel momento.

        Ritorna {"public_key", "adv_name", "out_path_len"} quando il
        contatto è risolto — ANCHE con path "flood" (out_path_len=-1):
        la risoluzione del contatto e l'affidabilità del suo hop count
        sono due cose distinte, v. run() sotto, che le tratta
        separatamente — altrimenti None (device non connesso, IPC
        irraggiungibile, contatto non ancora noto). MAI un'eccezione
        che blocchi la campagna.

        Questo risultato serve DUE scopi in run(): (1) l'hop count per
        la stima del margine di timeout IPC, quando out_path_len è un
        valore affidabile (>=0); (2) public_key/adv_name passati alla
        richiesta IPC 'neighbor_monitor.run', che
        NeighborMonitorModule.query() accetta come override opzionale
        per saltare un secondo get_contacts() locale ridondante sullo
        STESSO contatto a pochi istanti di distanza — osservazione
        dell'utente (2026-08-23): "perché non far consumare alla
        seconda necessità di query() lo stesso valore [...] così non
        si introduce questo costo extra?". Quando questo metodo
        ritorna None, run() non passa alcun override: sia l'hop count
        sia la risoluzione del contatto degradano al comportamento
        preesistente a questa aggiunta (assunzione configurata,
        get_contacts() dentro query() come sempre) — mai una campagna
        bloccata da questo dato accessorio.
        """

        try:
            response = await self.client.request(
                service="system",
                command="contact",
                name=name
            )

        except Exception as e:
            log.info(
                "NeighborMonitorEngine: [repeater:%s] impossibile "
                "risolvere il contatto in anticipo (%s) — l'hop count "
                "userà l'assunzione configurata, e la query risolverà "
                "il contatto per conto proprio.",
                name,
                e
            )
            return None

        if response.get("status") != "ok":
            log.info(
                "NeighborMonitorEngine: [repeater:%s] contatto non "
                "risolvibile in anticipo (%s) — l'hop count userà "
                "l'assunzione configurata, e la query risolverà il "
                "contatto per conto proprio.",
                name,
                response.get("message", "risposta IPC senza dettagli")
            )
            return None

        result = response.get("result", {})
        public_key = result.get("public_key")

        if not public_key:
            log.info(
                "NeighborMonitorEngine: [repeater:%s] risposta di "
                "system.contact senza public_key — l'hop count userà "
                "l'assunzione configurata, e la query risolverà il "
                "contatto per conto proprio.",
                name
            )
            return None

        out_path_len = result.get("out_path_len")

        if isinstance(out_path_len, int) and out_path_len >= 0:

            log.info(
                "NeighborMonitorEngine: [repeater:%s] out_path_len "
                "reale dal device: %d hop — uso questo valore al "
                "posto dell'assunzione conservativa per la stima del "
                "margine.",
                name,
                out_path_len
            )

        else:

            #
            # None (chiave assente) o -1 ("flood", nessun path diretto
            # stabilito) — non un hop count utilizzabile, non un
            # errore: condizione normale per un repeater appena
            # aggiunto o che non ha ancora un path diretto risolto. La
            # risoluzione del contatto (public_key/adv_name) resta
            # comunque valida e riusabile — solo l'hop count degrada
            # all'assunzione configurata, v. run() sotto.
            #
            log.info(
                "NeighborMonitorEngine: [repeater:%s] out_path_len "
                "non affidabile (%s) — l'hop count userà l'assunzione "
                "configurata.",
                name,
                out_path_len
            )

        return {
            "public_key": public_key,
            "adv_name": result.get("adv_name", name),
            "out_path_len": out_path_len
        }

    async def run(self):
        """
        Esegue una singola campagna su tutti i repeater configurati
        e termina.
        """

        if not self.repeaters:

            log.info(
                "NeighborMonitorEngine: nessun repeater configurato "
                "(neighbor_monitoring.repeaters vuoto), nulla da fare."
            )

            return

        #
        # Una sola interrogazione per l'intera campagna — v.
        # _fetch_radio_params(). None se non disponibili: la stima per
        # repeater degrada allora da sola al margine statico storico
        # (v. core/neighbor_monitor_timeout_estimate.py).
        #
        radio = await self._fetch_radio_params()

        for i, repeater in enumerate(self.repeaters):

            name = repeater.get("name")

            if not name:

                log.warning(
                    "NeighborMonitorEngine: voce repeater senza "
                    "'name' in configurazione, saltata: %r",
                    repeater
                )

                continue

            #
            # Margine di timeout IPC per QUESTO repeater — il massimo
            # fra la stima dinamica aggregata (18 richieste-tentativo,
            # dai parametri radio reali quando disponibili) e
            # self.static_ipc_timeout (900s di default), usato SEMPRE
            # come pavimento (2026-08-23, v.
            # core/neighbor_monitor_timeout_estimate.py e
            # claude/ricerca-neighbor-monitor-timeout-dinamico-2026-08-23.md
            # per la cronologia completa — fino a questa data era un
            # valore fisso, dimensionato a mano più volte, senza mai
            # esplorare la possibilità di una stima dinamica).
            #
            # Hop count: preferito l'out_path_len REALE di QUESTO
            # repeater (v. _fetch_repeater_contact() sopra — comando
            # IPC system.contact, get_contacts() sempre fresco, mai una
            # cache di freschezza incerta), quando disponibile e
            # affidabile (>=0, non "flood"). Altrimenti (device non
            # connesso, contatto non ancora noto, o path non ancora
            # risolto) resta l'assunzione conservativa configurabile
            # neighbor_monitoring.assumed_max_hop_count (default: la
            # stessa già pubblicata nelle tabelle di confronto di
            # docs/NEIGHBOR_MONITORING.md §22.1) — esattamente il
            # comportamento di prima di questa aggiunta. Con un
            # repeater realmente a 0 hop (il caso comune raccomandato
            # operativamente) il pavimento statico continuerà comunque
            # a vincere quasi sempre — resta la stessa rete di
            # sicurezza di prima, solo l'assunzione di partenza è ora
            # quella vera quando nota, non più sempre il caso peggiore.
            #
            # public_key/adv_name (2026-08-23, follow-up): la stessa
            # risoluzione del contatto appena ottenuta da
            # system.contact viene passata a 'neighbor_monitor.run' —
            # NeighborMonitorModule.query() la riusa invece di rifare
            # un secondo get_contacts() locale sullo STESSO contatto a
            # pochi istanti di distanza (osservazione dell'utente:
            # "perché non far consumare alla seconda necessità di
            # query() lo stesso valore [...] così non si introduce
            # questo costo extra?" — v.
            # claude/ricerca-neighbor-monitor-timeout-dinamico-2026-08-23.md).
            # Solo quando la risoluzione anticipata è riuscita: se
            # contact_hint è None, nessun override viene passato e
            # query() risolve il contatto per conto proprio esattamente
            # come faceva prima di questa intera aggiunta — mai una
            # regressione sul caso "system.contact non disponibile".
            #
            # hop_count_is_real (2026-08-23, follow-up successivo,
            # stesso documento): quando out_path_len è un dato REALE
            # (non l'assunzione conservativa), il pavimento statico
            # 900s smette di essere applicato in
            # estimate_ipc_timeout() — un caso reale (0 hop,
            # IK2XYP-RPT) ha mostrato 29s di tempo RF effettivo contro
            # una stima dinamica worst-case di ~389.7s, già 2.3x sotto
            # il pavimento: con un hop count reale la stima dinamica
            # (col proprio margine ×1.5 + 30s) è già una rete di
            # sicurezza sufficiente, il pavimento aggiungeva solo
            # attesa sprecata senza aumentare l'affidabilità. Impostato
            # SOLO in questo ramo (out_path_len reale e affidabile) —
            # mai quando l'hop count degrada all'assunzione configurata
            # o al default, dove il pavimento resta indispensabile
            # esattamente come prima. Rischio di staleness (il path
            # potrebbe cambiare nella finestra fra questa verifica e la
            # query vera) accettato esplicitamente dall'utente.
            #
            contact_hint = await self._fetch_repeater_contact(name)

            ipc_timeout_kwargs = {}
            run_kwargs = {}

            if contact_hint is not None:

                out_path_len = contact_hint["out_path_len"]

                if isinstance(out_path_len, int) and out_path_len >= 0:
                    ipc_timeout_kwargs["hop_count"] = out_path_len
                    ipc_timeout_kwargs["hop_count_is_real"] = True

                elif self.assumed_hop_count is not None:
                    ipc_timeout_kwargs["hop_count"] = self.assumed_hop_count

                run_kwargs["public_key"] = contact_hint["public_key"]
                run_kwargs["adv_name"] = contact_hint["adv_name"]

            elif self.assumed_hop_count is not None:
                ipc_timeout_kwargs["hop_count"] = self.assumed_hop_count

            ipc_timeout = estimate_ipc_timeout(
                radio,
                self.max_retries,
                self._cli_text_byte_lengths,
                self.static_ipc_timeout,
                **ipc_timeout_kwargs
            )

            log.info(
                "NeighborMonitorEngine: [repeater:%s] margine di "
                "timeout IPC: %.1fs.",
                name,
                ipc_timeout
            )

            response = await self.client.request(
                service="neighbor_monitor",
                command="run",
                repeater_name=name,
                ipc_timeout=ipc_timeout,
                **run_kwargs
            )

            #
            # Accesso difensivo a "status"/"result" (code review
            # 2026-08-20, §4) — v. TraceEngine.run() per la
            # motivazione: un payload IPC malformato non deve far
            # fallire con un KeyError grezzo l'intera campagna,
            # ripete qui lo stesso trattamento già applicato lì.
            #
            if response.get("status") == "ok":

                #
                # Un errore di I/O/DB qui prima di questo fix (code
                # review 2026-08-20, §3.2) interrompeva l'intero
                # batch invece del solo repeater corrente.
                #
                try:
                    self.writer.write(
                        response.get("result", {})
                    )

                    log.info(
                        "NeighborMonitorEngine: %s salvato in "
                        "contacts.db.",
                        name
                    )

                except Exception:
                    log.exception(
                        "NeighborMonitorEngine: scrittura in "
                        "contacts.db fallita per %s — proseguo con "
                        "i repeater successivi.",
                        name
                    )

            else:

                #
                # Stesso principio già adottato altrove nel progetto
                # (!meteo, !status): una query fallita non produce
                # nessuna riga — non c'è un "errore" significativo da
                # salvare, il frontend mostrerà semplicemente l'ultima
                # query riuscita disponibile.
                #
                log.warning(
                    "NeighborMonitorEngine: %s fallita (%s), nessuna "
                    "riga scritta.",
                    name,
                    response.get("message")
                )

            #
            # Attesa tra una query e la successiva — non dopo
            # l'ultima.
            #
            if i < len(self.repeaters) - 1:

                await asyncio.sleep(
                    self.interval
                )

        self.writer.close()
