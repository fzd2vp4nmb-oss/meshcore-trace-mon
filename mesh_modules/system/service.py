from meshcore.events import EventType

from core.logger import log
from core.contact_lookup import find_contact_by_name

OUT_PATH_UNKNOWN = 255

class SystemService:
    """
    Servizio di sistema.
    Implementa i comandi di base della piattaforma.
    Comandi disponibili:

        ping      - verifica la vivacità dell'IPC (non del device)
        status    - stato reale della connessione al device MeshCore
        contact   - stato di routing di un contatto (diagnostica)
        contacts  - elenco di tutti i contatti noti al device
    """

    def __init__(self, context):
        self.context = context

    async def execute(
        self,
        request
    ):

        command = request.get(
            "command"
        )

        if command == "ping":
            log.info(
                "SystemService: ping"
            )

            return {
                "version": 1,
                "status": "ok",
                "result": {
                    "message": "pong"
                }
            }

        if command == "status":
            log.info(
                "SystemService: status"
            )

            return {
                "version": 1,
                "status": "ok",
                "result": {
                    "connected": self.context.engine.connected
                }
            }

        if command == "contact":
            log.info(
                "SystemService: contact"
            )

            return await self._contact_info(request)

        if command == "contacts":
            log.info(
                "SystemService: contacts"
            )

            return await self._contacts_list(request)

        return {
            "version": 1,
            "status": "error",
            "message": f"unknown command '{command}'"
        }

    async def _refresh_and_get_contacts(self):

        engine = self.context.engine

        if not engine.connected:
            return None, "connessione al device non attiva"

        try:
            #
            # get_contacts() non è pre-unwrappata dalla libreria: su
            # timeout/fallimento non solleva mai un'eccezione, ritorna
            # un Event(ERROR, ...) grezzo (verificato leggendo
            # meshcore_py/commands/contact.py — code review 2026-08-20,
            # audit successivo al Finding 2 di una review indipendente).
            # Il solo except Exception sotto non lo intercettava mai:
            # un fallimento veniva riportato come "riuscito", con
            # engine.mesh.contacts potenzialmente stantia mostrata
            # come appena aggiornata a chi usa questo strumento
            # diagnostico.
            #
            result = await engine.mesh.commands.get_contacts()

            if result.type == EventType.ERROR:
                return None, f"refresh contatti fallito: {result.payload}"

        except Exception as e:
            return None, f"refresh contatti fallito: {e}"

        try:
            contacts = engine.mesh.contacts

        except AttributeError as e:
            return None, f"impossibile accedere alla lista contatti ({e})"

        return contacts, None

    async def _contact_info(self, request):

        name = request.get("name")
        prefix = request.get("prefix")

        if not name and not prefix:
            return {
                "version": 1,
                "status": "error",
                "message": "specifica 'name' o 'prefix'"
            }

        contacts, error = await self._refresh_and_get_contacts()

        if error:
            return {
                "version": 1,
                "status": "error",
                "message": error
            }

        engine = self.context.engine
        contact = None

        if prefix:

            contact = engine.mesh.get_contact_by_key_prefix(prefix)

        else:

            #
            # Match esatto case-insensitive, con fallback per
            # sottostringa — logica ora condivisa con
            # NeighborMonitorModule._resolve_contact() tramite
            # core/contact_lookup.py (code review 2026-08-20, §3.2).
            # Il fallback per sottostringa resta qui (comando
            # interattivo) e non in neighbor_monitor (campagna
            # automatica) — v. commento in core/contact_lookup.py.
            #
            contact = find_contact_by_name(
                contacts,
                name,
                allow_substring=True
            )

        if contact is None:
            return {
                "version": 1,
                "status": "error",
                "message": "contatto non trovato"
            }

        return {
            "version": 1,
            "status": "ok",
            "result": {
                "adv_name": contact.get("adv_name"),
                "public_key": contact.get("public_key"),
                "type": contact.get("type"),
                "out_path_len": contact.get("out_path_len"),
                "out_path": contact.get("out_path"),
                "last_advert": contact.get("last_advert")
            }
        }

    async def _contacts_list(self, request):

        contacts, error = await self._refresh_and_get_contacts()

        if error:
            return {
                "version": 1,
                "status": "error",
                "message": error
            }

        items = [
            {
                "adv_name": c.get("adv_name"),
                "public_key": c.get("public_key"),
                "type": c.get("type"),
                "out_path_len": c.get("out_path_len"),
                "out_path": c.get("out_path"),
                "last_advert": c.get("last_advert")
            }
            for c in contacts.values()
        ]

        #
        # Più recenti in cima — i nuovi arrivati saltano subito
        # all'occhio.
        #
        items.sort(
            key=lambda c: c.get("last_advert") or 0,
            reverse=True
        )

        return {
            "version": 1,
            "status": "ok",
            "result": {
                "count": len(items),
                "contacts": items
            }
        }
