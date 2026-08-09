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

        with self.filename.open(
            "a",
            encoding="utf-8"
        ) as f:

            #
            # Header
            #
            f.write(
                f"{timestamp} {trace_path}\n"
            )

            #
            # JSON
            #
            json.dump(
                payload,
                f,
                indent=2,
                ensure_ascii=False
            )

            #
            # Riga vuota finale
            #
            f.write("\n\n")
