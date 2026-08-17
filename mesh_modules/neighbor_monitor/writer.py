import time

from mesh_modules.contact_sync.db import ContactDB


class NeighborMonitorWriter:
    """
    Persiste il risultato di una query NeighborMonitor in
    contacts.db — stesso file di nodes/path_observations, necessario
    per il JOIN che risolve i neighbour in nomi noti (vedi
    docs/NEIGHBOR_MONITORING.md §5). Riusa ContactDB, la stessa
    classe con cui il daemon gestisce nodes/path_observations: stesso
    schema, stessa gestione WAL/busy_timeout per la concorrenza tra
    questo script (processo separato) e il daemon.
    """

    def __init__(self, db_path):
        self.db = ContactDB(db_path)

    def write(self, result):
        """
        result è il dict {public_key, adv_name, status, neighbours,
        telemetry, region, clock, config} restituito da
        NeighborMonitorService via IPC. Ciascun campo può essere
        None indipendentemente dagli altri (richieste radio
        distinte, ciascuna con il proprio gate ACL) — in quel caso
        si scrive solo la parte disponibile.
        """

        queried_at = int(
            time.time()
        )

        public_key = result["public_key"]

        #
        # Garantisce che la FK su nodes sia sempre soddisfatta, anche
        # se questo repeater non ha ancora un advert osservato
        # localmente — usa gli stessi dati già risolti da
        # get_contacts() lato daemon. Non sovrascrive dati più
        # completi già presenti (stesso COALESCE di upsert_node()
        # usato dal sync periodico).
        #
        self.db.upsert_node(
            public_key=public_key,
            adv_name=result.get("adv_name"),
            seen_at=queried_at
        )

        status = result.get("status")

        if status:

            #
            # pubkey_pre non è una colonna di repeater_status —
            # l'identità del repeater è già la FK public_key, non va
            # duplicata.
            #
            status_fields = {
                k: v
                for k, v in status.items()
                if k != "pubkey_pre"
            }

            self.db.insert_repeater_status(
                public_key=public_key,
                queried_at=queried_at,
                **status_fields
            )

        neighbours = result.get("neighbours")

        if neighbours:

            self.db.insert_repeater_neighbours(
                public_key=public_key,
                queried_at=queried_at,
                neighbours=neighbours.get(
                    "neighbours",
                    []
                )
            )

        #
        # A differenza di neighbours (dict con chiave "neighbours"),
        # req_telemetry_sync() restituisce già direttamente la lista
        # dei canali — nessun livello di incapsulamento da spacchettare.
        #
        telemetry = result.get("telemetry")

        if telemetry:

            self.db.insert_repeater_telemetry(
                public_key=public_key,
                queried_at=queried_at,
                telemetry=telemetry
            )

        #
        # A differenza di telemetry/neighbours, region non richiede
        # ACL (AnonReqType) — può riuscire anche quando status
        # fallisce. Scritta in una tabella indipendente proprio per
        # questo: nessun accoppiamento a status.queried_at.
        #
        region = result.get("region")

        if region:

            self.db.insert_repeater_region(
                public_key=public_key,
                queried_at=queried_at,
                region_dump=region
            )

        #
        # Stesso principio di region: requisito di permesso diverso
        # (login+admin, non solo ACL) — tabella indipendente, nessun
        # accoppiamento a status.queried_at. config è sempre un dict
        # con tutte le chiavi presenti se il login è riuscito (anche
        # con singoli valori a None) — None solo se il login stesso
        # è fallito, nel qual caso non c'è nulla da scrivere.
        #
        config = result.get("config")

        if config:

            self.db.insert_repeater_config(
                public_key=public_key,
                queried_at=queried_at,
                **config
            )

        #
        # Stesso gate ACL di region (AnonReqType, nessun permesso
        # richiesto) — tabella indipendente per lo stesso motivo.
        # skew_seconds calcolato qui con lo STESSO queried_at con cui
        # la riga viene salvata, non con l'istante originale della
        # richiesta radio (che può differire di una manciata di
        # secondi per via del giro IPC) — coerenza con le altre
        # tabelle, tutte ancorate a questo singolo queried_at.
        #
        clock = result.get("clock")

        if clock:

            remote_clock = clock.get("remote_clock")

            self.db.insert_repeater_clock(
                public_key=public_key,
                queried_at=queried_at,
                remote_clock=remote_clock,
                skew_seconds=remote_clock - queried_at
            )

    def close(self):
        self.db.close()
