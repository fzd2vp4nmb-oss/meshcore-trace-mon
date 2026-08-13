import asyncio
import time

from meshcore.events import EventType

from core.config import config
from core.logger import log
from mesh_modules.contact_sync.db import ContactDB


class ContactSyncModule:
    """
    Sincronizza in modo persistente i nodi e i path osservati verso
    lo store SQLite (docs/CONTACT_MANAGEMENT.md).

    Due canali di acquisizione, non intercambiabili:
    - RX_LOG_DATA (filtrato ADVERT), in tempo reale: sorgente dei
      dati di path (una riga per ogni ricezione fisica — percorsi
      multipli sono dati voluti, non deduplicati, vedi
      CONTACT_MANAGEMENT.md §6). Porta già anche i campi di identità
      del nodo (nome, tipo, posizione), quindi aggiorna 'nodes' da
      solo — non serve sottoscrivere separatamente ADVERTISEMENT/
      NEW_CONTACT per questo (semplificazione rispetto al piano
      iniziale in CONTACT_MANAGEMENT.md, RX_LOG_DATA è già un
      superset di quei due eventi per i nostri scopi).
    - Sync periodico (get_contacts()): rete di sicurezza per eventi
      persi durante downtime del daemon, e unica sorgente per
      out_path/out_path_len (non presenti in RX_LOG_DATA).

    Legge l'istanza MeshCore corrente dinamicamente da Engine ad ogni
    chiamata — non ne tiene mai una copia locale.
    """

    def __init__(self, engine):

        self.engine = engine

        self.db_path = config.get(
            "contacts.db_file",
            "data/contacts.db"
        )

        self.sync_interval = config.get(
            "contacts.sync_interval",
            3600
        )

        self.db = ContactDB(self.db_path)

        self._sync_task = None

        self.engine.register_rebind(self._on_rebind)

    async def start(self):

        self._subscribe()

        #
        # Sync iniziale, non aspetta il primo giro di
        # sync_interval per popolare lo stato corrente.
        #
        await self._full_sync()

        self._sync_task = asyncio.create_task(
            self._periodic_sync_loop()
        )

        log.info(
            "ContactSyncModule: avviato (db=%s, sync ogni %ss).",
            self.db_path,
            self.sync_interval
        )

    def _subscribe(self):

        self.engine.mesh.subscribe(
            EventType.RX_LOG_DATA,
            self._on_log_data
        )

    def _on_rebind(self, mesh):

        asyncio.create_task(
            self._rebind_async()
        )

    async def _rebind_async(self):

        log.info(
            "ContactSyncModule: rebinding dopo reconnect."
        )

        try:
            self._subscribe()

        except Exception:
            log.exception(
                "ContactSyncModule: rebind fallito."
            )

    async def _on_log_data(self, event):

        payload = event.payload

        if payload.get("payload_typename") != "ADVERT":
            return

        public_key = payload.get("adv_key")

        if not public_key:
            return

        try:
            self.db.upsert_node(
                public_key=public_key,
                adv_name=payload.get("adv_name"),
                node_type=payload.get("adv_type"),
                adv_lat=payload.get("adv_lat"),
                adv_lon=payload.get("adv_lon"),
                seen_at=payload.get("recv_time")
            )

            self.db.insert_path_observation(
                public_key=public_key,
                observed_at=payload.get("recv_time"),
                adv_timestamp=payload.get("adv_timestamp"),
                pkt_hash=payload.get("pkt_hash"),
                path_hex=payload.get("path") or "",
                hop_count=payload.get("path_len", 0),
                route_type=payload.get("route_typename"),
                transport_code=payload.get("transport_code"),
                rssi=payload.get("rssi"),
                snr=payload.get("snr")
            )

        except Exception:
            log.exception(
                "ContactSyncModule: scrittura path_observation fallita "
                "(public_key=%s).",
                public_key
            )

    async def _periodic_sync_loop(self):

        while True:

            await asyncio.sleep(self.sync_interval)

            await self._full_sync()

    async def _full_sync(self):

        try:
            #
            # get_contacts() tocca la connessione condivisa — va
            # serializzato con command_lock come ogni altro comando,
            # questo sync gira su un proprio loop indipendente
            # (sync_interval) e può altrimenti sovrapporsi a un
            # comando IPC/bot in corso sulla stessa connessione.
            #
            async with self.engine.command_lock:
                await self.engine.mesh.commands.get_contacts()

        except Exception:
            log.exception(
                "ContactSyncModule: get_contacts() fallito durante "
                "il sync periodico."
            )
            return

        try:
            contacts = self.engine.mesh.contacts

        except AttributeError:
            log.warning(
                "ContactSyncModule: impossibile accedere a "
                "mesh.contacts."
            )
            return

        now = int(time.time())
        count = 0

        for c in contacts.values():

            try:
                self.db.upsert_node(
                    public_key=c.get("public_key"),
                    adv_name=c.get("adv_name"),
                    node_type=c.get("type"),
                    adv_lat=c.get("adv_lat"),
                    adv_lon=c.get("adv_lon"),
                    out_path=c.get("out_path"),
                    out_path_len=c.get("out_path_len"),
                    flags=c.get("flags"),
                    out_path_hash_mode=c.get("out_path_hash_mode"),
                    last_advert=c.get("last_advert"),
                    lastmod=c.get("lastmod"),
                    seen_at=now
                )

                count += 1

            except Exception:
                log.exception(
                    "ContactSyncModule: upsert nodo '%s' fallito.",
                    c.get("adv_name")
                )

        log.info(
            "ContactSyncModule: sync periodico completato (%d nodi).",
            count
        )

        await self._sync_device_status(now)

    async def _sync_device_status(self, now):
        """
        Stato corrente del companion connesso a trace-mon stesso —
        quattro query locali al device (get_stats_core/radio/packets
        + send_device_query per modello/firmware, nessun traffico
        radio, stesso principio di get_bat() già usato nell'heartbeat di Engine), eseguite in questo stesso
        giro invece che con un cron dedicato. Ogni gruppo è
        indipendente: se una fallisce le altre tre vengono comunque
        salvate (vedi COALESCE in upsert_device_status). Se falliscono
        TUTTE E QUATTRO, l'aggiornamento viene saltato del tutto —
        updated_at resta quello dell'ultimo giro riuscito, un segnale
        onesto di quanto il dato sia vecchio invece di un errore.
        """

        core = await self._get_stats_safe(
            "stats_core",
            self.engine.mesh.commands.get_stats_core
        )

        radio = await self._get_stats_safe(
            "stats_radio",
            self.engine.mesh.commands.get_stats_radio
        )

        packets = await self._get_stats_safe(
            "stats_packets",
            self.engine.mesh.commands.get_stats_packets
        )

        device_info = await self._get_stats_safe(
            "device_query",
            self.engine.mesh.commands.send_device_query
        )

        if (
            core is None and
            radio is None and
            packets is None and
            device_info is None
        ):

            log.warning(
                "ContactSyncModule: device_status non aggiornato "
                "(nessuna delle quattro query locali è riuscita)."
            )

            return

        core = core or {}
        radio = radio or {}
        packets = packets or {}
        device_info = device_info or {}

        self.db.upsert_device_status(
            updated_at=now,
            battery_mv=core.get("battery_mv"),
            uptime_secs=core.get("uptime_secs"),
            errors=core.get("errors"),
            queue_len=core.get("queue_len"),
            noise_floor=radio.get("noise_floor"),
            last_rssi=radio.get("last_rssi"),
            last_snr=radio.get("last_snr"),
            tx_air_secs=radio.get("tx_air_secs"),
            rx_air_secs=radio.get("rx_air_secs"),
            recv=packets.get("recv"),
            sent=packets.get("sent"),
            flood_tx=packets.get("flood_tx"),
            direct_tx=packets.get("direct_tx"),
            flood_rx=packets.get("flood_rx"),
            direct_rx=packets.get("direct_rx"),
            recv_errors=packets.get("recv_errors"),
            model=device_info.get("model"),
            fw_build=device_info.get("fw_build"),
            fw_version=device_info.get("ver")
        )

    async def _get_stats_safe(self, label, factory):
        """
        Esegue una delle quattro query di stato locale sotto command_lock
        (condivisa con IPC/bot come ogni altro comando sulla stessa
        connessione — locale sì, ma pur sempre unica connessione).
        Ritorna il payload (dict) o None se fallita — un fallimento
        qui non deve mai impedire alle altre tre di essere salvate.
        send() della libreria non solleva mai per timeout, ritorna un
        Event(ERROR) sintetico — controlliamo .type, non un except
        dedicato al timeout.
        """

        try:
            async with self.engine.command_lock:
                result = await factory()

            if result.type == EventType.ERROR:

                log.warning(
                    "ContactSyncModule: %s fallita (%s).",
                    label,
                    result.payload
                )

                return None

            return result.payload

        except Exception:

            log.exception(
                "ContactSyncModule: %s fallita.",
                label
            )

            return None
