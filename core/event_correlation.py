import asyncio


async def wait_for_matching_event(
    get_next,
    is_match,
    timeout,
    on_discard=None
):
    """
    Helper di correlazione condiviso (code review 2026-08-20, §3.2)
    — prima duplicato quasi identico tra
    mesh_modules/trace/trace.py (_wait_for_own_trace, correlazione
    per 'tag' numerico su una asyncio.Queue) e
    mesh_modules/neighbor_monitor/neighbor_monitor.py
    (_wait_for_own_response, correlazione per pubkey_prefix su
    eventi MESSAGES_WAITING/get_msg() della libreria): stessa logica
    di fondo — "continua a scartare tutto ciò che non corrisponde
    alla nostra richiesta, entro una finestra di timeout complessiva,
    perché la coda/il canale non è isolato per richiesta" — con solo
    la sorgente dell'evento e il criterio di match diversi tra i due
    casi. Un fix futuro a questa logica di correlazione va ora
    applicato in un solo posto.

    get_next: coroutine function, senza argomenti, che ritorna il
      prossimo evento/messaggio "grezzo" da esaminare (es.
      self._queue.get, o una funzione che fa
      wait_for_event(MESSAGES_WAITING) + get_msg()).
    is_match: callable(evento) -> bool, vero se l'evento è la
      risposta attesa per QUESTA richiesta.
    timeout: finestra COMPLESSIVA (non per singola get_next()) entro
      cui deve arrivare un evento che soddisfi is_match.
    on_discard: callable(evento) opzionale, invocato per ogni evento
      scartato (tipicamente per loggare cosa è stato ignorato e
      perché) — non deve sollevare eccezioni.

    Solleva asyncio.TimeoutError se la finestra scade senza un match.
    """

    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout

    while True:

        remaining = deadline - loop.time()

        if remaining <= 0:
            raise asyncio.TimeoutError()

        event = await asyncio.wait_for(
            get_next(),
            remaining
        )

        if is_match(event):
            return event

        if on_discard is not None:
            on_discard(event)
