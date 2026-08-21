import json
from datetime import datetime
from pathlib import Path

class TraceWriter:
    """
    Scrive trace.json nel formato storico utilizzato da trace-mon.
    """

    def __init__(self, filename):
        self.filename = Path(filename)

        self.filename.parent.mkdir(
            parents=True,
            exist_ok=True
        )

    def clear(self):
        self.filename.write_text(
            "",
            encoding="utf-8"
        )

    def write(
        self,
        trace_path,
        payload,
        timestamp=None
    ):

        if timestamp is None:
            timestamp = datetime.now()

        if isinstance(timestamp, datetime):
            timestamp = timestamp.strftime(
                "%Y%m%d_%H%M%S"
            )

        #
        # L'intero record (header + JSON + righe vuote finali) viene
        # costruito in memoria e scritto con UNA sola f.write() (code
        # review 2026-08-20, §3.5) — prima erano tre write() separate
        # (header, poi json.dump() che a sua volta esegue diverse
        # write() interne, poi il trailing "\n\n"): un lettore
        # sincrono concorrente (server.js, che legge trace.json senza
        # lock) poteva vedere un record valido appena scritto
        # "spezzato" a metà, insieme all'header parziale della riga
        # successiva — un "flickering" occasionale del dato più
        # recente in UI, che si auto-correggeva alla richiesta
        # successiva (da cui "self-healing" nel finding originario),
        # ma restava comunque un glitch visibile evitabile.
        #
        # Una singola write() in modalità append ("a", quindi
        # O_APPEND) è atomica rispetto ad altri lettori/scrittori sul
        # filesystem POSIX locale finché la dimensione scritta resta
        # entro PIPE_BUF (tipicamente 4096 byte su Linux) — vero per
        # un singolo record di trace nella quasi totalità dei casi
        # reali. Per un payload eccezionalmente grande (path con
        # moltissimi hop) la garanzia di atomicità non è assoluta,
        # ma il rischio pratico di race resta comunque drasticamente
        # ridotto rispetto a tre write() separate.
        #
        json_text = json.dumps(
            payload,
            indent=2,
            ensure_ascii=False
        )

        record_text = (
            f"{timestamp} {trace_path}\n"
            f"{json_text}"
            "\n\n"
        )

        with self.filename.open(
            "a",
            encoding="utf-8"
        ) as f:

            f.write(record_text)
