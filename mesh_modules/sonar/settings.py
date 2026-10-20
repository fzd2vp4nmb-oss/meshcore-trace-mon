"""
mesh_modules/sonar/settings.py

Lettura e validazione della configurazione del sonar (sezione 'sonar'
di config/config.yaml, v. docs/ARCHITECTURE.md §87).

Perché un modulo a parte invece di leggere config.get() dove serve:

  - il servizio sonar NON deve mai impedire l'avvio del daemon (v.
    services/loader.py: l'eccezione di un costruttore di servizio
    ferma l'intero daemon, bot e trace compresi). Una configurazione
    mancante o sbagliata deve quindi diventare un elenco di errori
    leggibili, non un'eccezione: from_config() NON solleva mai;
  - la validazione è una funzione pura sui valori letti, testabile
    senza device né database;
  - il segreto del canale non deve mai finire in un log né in una
    risposta IPC: l'unico punto del codice che lo maneggia in chiaro
    è questo (più il modulo che lo scrive sul device).

Chiavi lette (tutte sotto 'sonar.'; v. config/config.yaml.template):

    channel_name     nome del canale pubblico dedicato (default
                     'TM-Sonar'). NON può iniziare con '#': la libreria
                     deriverebbe la chiave dal nome (canale "pubblico"
                     a chiunque lo conosca) ignorando il segreto
                     configurato.
    channel_secret   segreto condiviso del canale: 32 caratteri
                     esadecimali (16 byte). Vuoto o placeholder di
                     setup.sh non sostituito = "non configurato" (non è
                     un errore: il canale può già esistere sul device,
                     che ne conosce il segreto).
    tx.enabled       abilita la trasmissione (default False). La
                     ricezione dipende solo da services.sonar.enabled.
    tx.scope         scope predefinito delle trasmissioni: '*' (o 'U')
                     unscoped, '' (o 'D') default del device, oppure un
                     nome di regione. Sovrascrivibile per singola
                     richiesta (sonar.sh / tools/send_sonar.py).
    tx.min_interval  secondi minimi tra due trasmissioni (default 600,
                     0 = nessuna guardia).

Più due chiavi di altre sezioni, lette qui solo per coerenza:
    contacts.db_file    stesso database di contact_sync
    bot.channel_name    il canale sonar non può coincidere col canale
                        del bot (separazione richiesta dalla
                        specifica: il bot non deve mai vedere il sonar)
"""

import re


DEFAULT_CHANNEL_NAME = "TM-Sonar"

DEFAULT_TX_SCOPE = "*"

DEFAULT_MIN_INTERVAL = 600

#
# Tetto di sicurezza su min_interval: un valore assurdo (errore di
# battitura) bloccherebbe di fatto la trasmissione per giorni senza
# che nessuno se ne accorga. Un giorno è già ben oltre ogni uso reale.
#
MAX_MIN_INTERVAL = 86400

#
# Il nome del canale occupa al massimo 32 byte sul device
# (set_channel() lo tronca in silenzio a 32: una troncatura
# silenziosa produrrebbe un nome diverso da quello cercato dalla
# scansione, quindi lo si rifiuta in configurazione).
#
MAX_CHANNEL_NAME_BYTES = 32

CHANNEL_SECRET_BYTES = 16

_SECRET_HEX_RE = re.compile(r"^[0-9a-fA-F]{%d}$" % (CHANNEL_SECRET_BYTES * 2))

#
# Segnaposto lasciato da setup.sh/template quando l'utente non ha
# fornito un segreto ("__NOME__"): equivale a "non configurato".
#
_PLACEHOLDER_RE = re.compile(r"^__[A-Z0-9_]+__$")


def _to_bool(value, name, errors):
    """
    bool stretto: ammessi solo True/False. Una stringa come "false"
    sarebbe truthy se passata a bool(): meglio un errore chiaro che
    una trasmissione abilitata per sbaglio.
    """

    if isinstance(value, bool):
        return value

    errors.append(
        f"{name} deve essere true o false (ricevuto "
        f"{type(value).__name__})"
    )

    return False


class SonarSettings:
    """
    Configurazione validata del sonar. Costruire con from_config().

    Attributi:
        channel_name      str
        channel_secret    bytes (16) oppure None se non configurato
        tx_enabled        bool
        tx_scope          str   valore scritto in configurazione
        tx_scope_cmd      str   argomento per set_flood_scope()
        tx_scope_tag      str   tag scritto nel messaggio
        min_interval      int   secondi
        db_path           str
        channel_errors    list[str]  errori che impediscono OGNI uso del
                                     canale (ricezione e trasmissione)
        tx_errors         list[str]  errori che impediscono solo la
                                     trasmissione
    """

    def __init__(self):

        self.channel_name = DEFAULT_CHANNEL_NAME
        self.channel_secret = None
        self.tx_enabled = False
        self.tx_scope = DEFAULT_TX_SCOPE
        self.tx_scope_cmd = "*"
        self.tx_scope_tag = "U"
        self.min_interval = DEFAULT_MIN_INTERVAL
        self.db_path = "data/contacts.db"
        self.channel_errors = []
        self.tx_errors = []

    @property
    def errors(self):
        return list(self.channel_errors) + list(self.tx_errors)

    @property
    def rx_ok(self):
        """Il canale è utilizzabile (ricezione possibile)."""
        return not self.channel_errors

    @property
    def tx_ok(self):
        """La trasmissione è configurata in modo valido."""
        return not self.channel_errors and not self.tx_errors

    def public_dict(self):
        """
        Vista per diagnostica (comando 'status', log): MAI il segreto,
        solo se è configurato o no.
        """

        return {
            "channel_name": self.channel_name,
            "channel_secret_configured": self.channel_secret is not None,
            "tx_enabled": self.tx_enabled,
            "tx_scope": self.tx_scope,
            "min_interval": self.min_interval,
            "errors": self.errors,
        }

    @classmethod
    def from_config(cls, config):
        """
        Legge e valida la configurazione da un oggetto con interfaccia
        get(chiave_puntata, default) (core.config.config o un finto nei
        test). Non solleva mai: ogni problema finisce in
        channel_errors/tx_errors, e i valori non validi restano ai
        default sicuri (trasmissione disabilitata).
        """

        self = cls()

        try:
            self._load(config)

        except Exception as exc:  # difesa estrema: mai propagare
            self.channel_errors.append(
                f"lettura configurazione sonar fallita: "
                f"{type(exc).__name__}"
            )
            self.tx_enabled = False

        return self

    # ------------------------------------------------------------

    def _load(self, config):

        self._load_channel(config)
        self._load_tx(config)

        db_path = config.get("contacts.db_file", "data/contacts.db")

        if isinstance(db_path, str) and db_path.strip():
            self.db_path = db_path

        else:
            self.channel_errors.append(
                "contacts.db_file deve essere un percorso non vuoto"
            )

        #
        # Qualunque errore del canale azzera la trasmissione: non si
        # trasmette su un canale di cui non si è certi.
        #
        if self.channel_errors:
            self.tx_enabled = False

    def _load_channel(self, config):

        errors = self.channel_errors

        name = config.get("sonar.channel_name", DEFAULT_CHANNEL_NAME)

        if not isinstance(name, str) or not name.strip():
            errors.append("sonar.channel_name deve essere una stringa non vuota")

        else:
            name = name.strip()

            if name.startswith("#"):
                errors.append(
                    "sonar.channel_name non può iniziare con '#': la "
                    "libreria deriverebbe la chiave dal nome ignorando "
                    "sonar.channel_secret"
                )

            elif len(name.encode("utf-8")) > MAX_CHANNEL_NAME_BYTES:
                errors.append(
                    f"sonar.channel_name supera {MAX_CHANNEL_NAME_BYTES} "
                    f"byte"
                )

            elif "\x00" in name:
                errors.append("sonar.channel_name contiene caratteri nulli")

            else:
                self.channel_name = name

                bot_channel = config.get("bot.channel_name", "#bot")

                if isinstance(bot_channel, str) and (
                    bot_channel.strip() == name
                ):
                    errors.append(
                        "sonar.channel_name coincide con bot.channel_name: "
                        "il sonar deve usare un canale proprio, separato "
                        "da quello del bot"
                    )

        self._load_secret(config)

    def _load_secret(self, config):

        errors = self.channel_errors

        raw = config.get("sonar.channel_secret", None)

        if raw is None:
            return

        #
        # YAML interpreta come NUMERO un valore non quotato fatto solo
        # di cifre (es. 12345678901234567890123456789012) perdendo gli
        # zeri iniziali: il segreto originale non è recuperabile,
        # quindi niente tentativi di "indovinarlo" — errore esplicito.
        # (bool è sottoclasse di int: escluso a parte per chiarezza.)
        #
        if isinstance(raw, bool) or isinstance(raw, (int, float)):
            errors.append(
                "sonar.channel_secret è stato letto come numero dallo "
                "YAML: va scritto tra virgolette"
            )
            return

        if not isinstance(raw, str):
            errors.append(
                "sonar.channel_secret deve essere una stringa esadecimale"
            )
            return

        raw = raw.strip()

        if raw == "" or _PLACEHOLDER_RE.match(raw):
            return

        if not _SECRET_HEX_RE.match(raw):
            #
            # Né il valore né porzioni di esso nel messaggio: solo la
            # lunghezza, che basta a capire l'errore più comune
            # (segreto troncato o con spazi/separatori).
            #
            if len(raw) == CHANNEL_SECRET_BYTES * 2:
                detail = "contiene caratteri non esadecimali"

            else:
                detail = (
                    f"servono {CHANNEL_SECRET_BYTES * 2} caratteri "
                    f"esadecimali (letti {len(raw)})"
                )

            errors.append(f"sonar.channel_secret non valido: {detail}")
            return

        self.channel_secret = bytes.fromhex(raw)

    def _load_tx(self, config):

        # Import locale: protocol.py non dipende da nulla, ma tenere
        # l'import qui rende il modulo importabile anche se in futuro
        # protocol.py crescesse di dipendenze.
        from mesh_modules.sonar.protocol import normalize_scope

        errors = self.tx_errors

        enabled = config.get("sonar.tx.enabled", False)
        self.tx_enabled = _to_bool(enabled, "sonar.tx.enabled", errors)

        scope = config.get("sonar.tx.scope", DEFAULT_TX_SCOPE)

        if scope is None:
            #
            # "scope:" vuoto nello YAML = null: lo si legge come
            # "default del device", la stessa cosa della stringa vuota.
            #
            scope = ""

        try:
            cmd, tag = normalize_scope(scope)

        except ValueError as exc:
            errors.append(f"sonar.tx.scope: {exc}")
            self.tx_enabled = False

        else:
            self.tx_scope = scope.strip() if isinstance(scope, str) else scope
            self.tx_scope_cmd = cmd
            self.tx_scope_tag = tag

        interval = config.get("sonar.tx.min_interval", DEFAULT_MIN_INTERVAL)

        if (
            isinstance(interval, bool)
            or not isinstance(interval, int)
            or not 0 <= interval <= MAX_MIN_INTERVAL
        ):
            errors.append(
                f"sonar.tx.min_interval deve essere un intero tra 0 e "
                f"{MAX_MIN_INTERVAL} secondi"
            )
            self.tx_enabled = False

        else:
            self.min_interval = interval

        if errors:
            self.tx_enabled = False
