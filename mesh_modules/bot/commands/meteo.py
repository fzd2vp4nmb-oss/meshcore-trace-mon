import asyncio

import aiohttp

from core.logger import log
from mesh_modules.bot.commands.base import BotCommand


GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

#
# Limite di concorrenza globale su !meteo (code review 2026-08-20,
# §3.3) — prima ogni invocazione apriva una nuova sessione aiohttp
# senza alcun limite di concorrenza globale o per mittente: un
# flusso rapido di comandi !meteo da uno o più mittenti poteva
# aprire decine di socket TCP concorrenti su un Raspberry Pi con
# risorse limitate (DoS locale a basso sforzo). Un semaforo a
# livello di modulo (condiviso da tutte le istanze di
# MeteoCommand/BotModule nel processo, che sono comunque uniche per
# design) limita le richieste in volo indipendentemente da quante ne
# arrivino: le richieste in eccesso attendono semplicemente il
# proprio turno invece di aprire una nuova connessione, il comando
# resta comunque funzionante, solo più lento sotto carico.
#
MAX_CONCURRENT_REQUESTS = 3
_concurrency_limiter = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)

#
# Primo comando del progetto che fa una chiamata di rete esterna
# (finora trace-mon parlava solo col device via meshcore_py). Timeout
# esplicito indispensabile: senza, una rete lenta/irraggiungibile
# potrebbe tenere occupato a lungo il comando corrente — non blocca
# l'intero daemon (aiohttp è async), ma terrebbe comunque impegnato
# inutilmente il singolo comando in corso.
#
REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=8)

#
# Risposta unica per qualsiasi errore (città non trovata, rete non
# raggiungibile, timeout, risposta inattesa) — nessun dettaglio
# tecnico esposto sul canale/DM, scelta esplicita.
#
FALLBACK_MESSAGE = "Informazioni non trovate"


def _truncate(text, budget):
    """
    Troncamento entro il budget di caratteri disponibile.

    A differenza di format_path() in path.py, qui non c'è una
    struttura a "hop" da preservare — la risposta è un'unica riga di
    dati compatti, un taglio diretto con ellissi è sufficiente. In
    pratica la stringa formattata rientra sempre nel budget, questo è
    solo un margine di sicurezza.
    """

    if len(text) <= budget:
        return text

    if budget <= 1:
        return "…"[:budget]

    return text[:budget - 1] + "…"


class MeteoCommand(BotCommand):
    """
    !meteo <città> — risponde con temperatura, umidità e vento
    attuali per la città indicata, usando Open-Meteo (geocoding per
    risolvere il nome città in coordinate, poi forecast per il meteo
    attuale) — nessuna API key richiesta, nessun limite di richieste
    rilevante per questo caso d'uso.
    """

    name = "meteo"

    async def handle(self, ctx):

        if not ctx.arg:
            return "Uso: !meteo <città>"

        city = ctx.arg

        try:
            async with _concurrency_limiter:

                async with aiohttp.ClientSession(timeout=REQUEST_TIMEOUT) as session:

                    lat, lon, resolved_name = await self._geocode(session, city)

                    current = await self._fetch_current(session, lat, lon)

        except Exception:
            log.warning(
                "MeteoCommand: lookup fallito per '%s'.",
                city,
                exc_info=True
            )
            return FALLBACK_MESSAGE

        temp = current.get("temperature_2m")
        humidity = current.get("relative_humidity_2m")
        wind = current.get("wind_speed_10m")

        text = (
            f"Meteo {resolved_name}:{temp}°C {humidity}% umidità "
            f"vento {wind}km/h"
        )

        return _truncate(text, ctx.reply_budget)

    async def _geocode(self, session, city):

        async with session.get(
            GEOCODING_URL,
            params={"name": city, "count": "1"}
        ) as resp:

            resp.raise_for_status()

            data = await resp.json()

        results = data.get("results") or []

        if not results:
            raise LookupError(f"città non trovata: {city}")

        result = results[0]

        return (
            str(result["latitude"]),
            str(result["longitude"]),
            result["name"]
        )

    async def _fetch_current(self, session, lat, lon):

        async with session.get(
            FORECAST_URL,
            params={
                "latitude": lat,
                "longitude": lon,
                "current": "temperature_2m,relative_humidity_2m,wind_speed_10m"
            }
        ) as resp:

            resp.raise_for_status()

            data = await resp.json()

        current = data.get("current")

        if not current:
            raise LookupError("dati meteo mancanti nella risposta")

        return current
