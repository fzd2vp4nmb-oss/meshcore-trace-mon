from meshcore.events import EventType
from core.logger import log


class AdvertModule:
    """
    Wrapper delle funzionalità Advert offerte da meshcore_py.

    Legge l'istanza MeshCore corrente dinamicamente da Engine ad
    ogni chiamata — non ne tiene mai una copia locale.
    """

    def __init__(self, engine):
        self.engine = engine

    async def advert(self):
        return await self._send(flood=False)

    async def floodadv(self):
        return await self._send(flood=True)

    async def _send(self, flood):

        label = "flood advert" if flood else "zero-hop advert"

        if not self.engine.connected:

            log.warning(
                "ADVERT: connessione non attiva, invio annullato (%s).",
                label
            )

            return None

        log.info(
            "ADVERT: sending %s...",
            label
        )

        try:

            event = await self.engine.mesh.commands.send_advert(
                flood=flood
            )

        except Exception:

            log.exception(
                "ADVERT: send_advert() failed"
            )

            self.engine.report_possible_failure()

            raise

        if event.type == EventType.ERROR:

            log.warning(
                "ADVERT: %s failed: %r",
                label,
                event.payload
            )

            #
            # Errore sul comando stesso (link locale al companion),
            # non su un evento radio successivo — segnala subito.
            #
            self.engine.report_possible_failure()

            return event

        log.info(
            "ADVERT: %s completed.",
            label
        )

        return event
