#!/bin/bash
#
# setup.sh — genera da zero tutti i file specifici della tua
# installazione (script di manutenzione, config.yaml,
# trace-web.service). Il contenuto di questi file vive interamente
# dentro questo script (heredoc) — nel repository NON esistono copie
# "template" separate: git clone non ti dà backup.sh, trace.sh,
# config.yaml, trace-web.service, li crea questo script.
#
# Va eseguito UNA VOLTA dopo il git clone, dalla root del progetto
# (~/trace-mon). trace-mon.service invece è già nel repository così
# com'è (systemd/trace-mon.service) — non richiede alcun adattamento,
# nessun coinvolgimento di questo script.
#

set -e

cd "$(dirname "$0")"

echo "=== MeshCore trace-mon — Setup ==="
echo

#
# Chiede conferma prima di sovrascrivere un file già esistente.
#
confirm_overwrite() {

    local target="$1"

    if [ ! -f "$target" ]; then
        return 0
    fi

    read -p "  $target esiste già. Sovrascrivere? [y/N] " answer

    case "$answer" in
        [Yy]*) return 0 ;;
        *) return 1 ;;
    esac
}

#
# ============================================================
# Parte 1: script di manutenzione (node_XX / IP_SERVER)
# ============================================================
#
echo "--- Parte 1: script di manutenzione ---"
echo

read -p "Node ID (es. node_01, node_02, node_03): " NODE_ID

if [ -z "$NODE_ID" ]; then
    echo "ERRORE: il Node ID non può essere vuoto."
    exit 1
fi

read -p "IP del server Collettore: " IP_SERVER

if [ -z "$IP_SERVER" ]; then
    echo "ERRORE: l'IP del server non può essere vuoto."
    exit 1
fi

echo

#
# Scrive il contenuto letterale (heredoc con delimitatore tra
# apici — 'MAINTSCRIPT_EOF', NON MAINTSCRIPT_EOF — così $YEAR,
# $MONTH, $FILEOUT ecc. restano testo letterale, non vengono
# espansi ORA da setup.sh: sono variabili dello script generato,
# che verranno valutate quando POI backup.sh/trace.sh ecc.
# verranno eseguiti da cron, non ora), poi sostituisce solo i due
# placeholder con sed.
#
write_maint_script() {

    local output="$1"

    if ! confirm_overwrite "$output"; then
        echo "  $output — saltato."
        return
    fi

    case "$output" in

        backup.sh)
            cat > "$output" << 'MAINTSCRIPT_EOF'
#!/bin/bash

cd /home/meshcore/trace-mon

NODE="node_XX"
IP_SERVER="Y.Y.Y.Y"

#
# Log su file degli errori di questo script, in aggiunta all'echo su
# stdout (che raggiunge comunque l'email di cron, se MAILTO è
# configurato) — così un fallimento resta visibile anche sui nodi dove
# cron non invia email per i job falliti. File dedicato agli script di
# manutenzione lanciati da cron (distinto da trace-mon.log, che è il
# log del daemon), ruotato da logrotate insieme a trace-mon.log (stessa
# stanza in config/logrotate.conf).
#
LOGFILE="/home/meshcore/trace-mon/logs/cron-errors.log"
mkdir -p "$(dirname "$LOGFILE")"

log_err() {
    echo "$1"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$1" >> "$LOGFILE"
}

YEAR=$(date +"%Y")
MONTH=$(date +"%m")
MONTH=$((10#$MONTH - 1))

if [ $MONTH -eq 0 ]; then
    MONTH=12
    YEAR=$((YEAR - 1))
fi

MONTH=$(printf "%02d" "$MONTH")
FILEOUT="trace-$YEAR-$MONTH.json"
FILEOUTZIP="trace-$YEAR-$MONTH.json.gz"

#
# Ogni passaggio va confermato riuscito PRIMA di quello successivo —
# in particolare data/trace.json non va mai rimosso finché non esiste
# già una copia .gz valida in backup/. Senza questi controlli, un cp
# o un gzip falliti (disco pieno, permessi, file assente) porterebbero
# comunque alla rimozione del file live più sotto: dati persi in modo
# irreversibile, senza che il backup sia stato fatto davvero.
#

if [ ! -f data/trace.json ]; then
    log_err "Errore: data/trace.json non trovato, backup annullato."
    exit 1
fi

cp data/trace.json "backup/$FILEOUT"

if [ $? -ne 0 ]; then
    log_err "Errore durante la copia di data/trace.json in backup/$FILEOUT"
    exit 1
fi

sleep 10

gzip "backup/$FILEOUT"

if [ $? -ne 0 ] || [ ! -f "backup/$FILEOUTZIP" ]; then
    log_err "Errore durante la compressione di backup/$FILEOUT"
    exit 1
fi

sleep 10

#
# Solo ora, con backup/$FILEOUTZIP confermato presente, è sicuro
# azzerare il file live.
#
rm -f data/trace.json
sleep 10
touch data/trace.json
sleep 10
cd /home/meshcore/trace-mon/backup

scp -P 15450 "$FILEOUTZIP" trace-mon@$IP_SERVER:/home/trace-mon/backup/$NODE

if [ $? -ne 0 ]; then
    log_err "Errore durante l'invio di $FILEOUTZIP al Collettore (il backup locale resta comunque disponibile in backup/)."
    exit 1
fi

exit 0
MAINTSCRIPT_EOF
            ;;

        contact_sync.sh)
            cat > "$output" << 'MAINTSCRIPT_EOF'
#!/bin/bash

cd /home/meshcore/trace-mon

NODE="node_XX"
IP_SERVER="Y.Y.Y.Y"
SNAPSHOT="data/contacts_export.db"

#
# Log su file degli errori di questo script, in aggiunta all'echo su
# stdout (che raggiunge comunque l'email di cron, se MAILTO è
# configurato) — così un fallimento resta visibile anche sui nodi dove
# cron non invia email per i job falliti. File dedicato agli script di
# manutenzione lanciati da cron (distinto da trace-mon.log, che è il
# log del daemon), ruotato da logrotate insieme a trace-mon.log (stessa
# stanza in config/logrotate.conf).
#
LOGFILE="/home/meshcore/trace-mon/logs/cron-errors.log"
mkdir -p "$(dirname "$LOGFILE")"

log_err() {
    echo "$1"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$1" >> "$LOGFILE"
}

#
# Se il daemon non ha ancora creato il DB (es. subito dopo
# l'installazione), non c'è nulla da sincronizzare — esce senza
# errore, stesso principio difensivo già usato lato server web.
#
if [ ! -f data/contacts.db ]; then
    exit 0
fi

#
# VACUUM INTO produce uno snapshot consistente e a sé stante, sicuro
# da copiare anche mentre il daemon scrive attivamente sul DB
# originale — MAI copiare data/contacts.db direttamente (vedi
# docs/CONTACT_MANAGEMENT.md).
#
# Il file di destinazione non deve esistere già: lo rimuoviamo prima,
# altrimenti VACUUM INTO fallisce.
#
rm -f "$SNAPSHOT"

sqlite3 data/contacts.db "VACUUM INTO '$SNAPSHOT'"

if [ $? -ne 0 ]; then
    log_err "Errore durante la creazione dello snapshot di contacts.db"
    exit 1
fi

scp -P 15450 "$SNAPSHOT" trace-mon@$IP_SERVER:/home/trace-mon/data/$NODE/contacts.db

if [ $? -ne 0 ]; then
    log_err "Errore durante l'invio di $SNAPSHOT al Collettore"
    exit 1
fi

exit 0
MAINTSCRIPT_EOF
            ;;

        rotate_contacts.sh)
            cat > "$output" << 'MAINTSCRIPT_EOF'
#!/bin/bash

cd /home/meshcore/trace-mon

NODE="node_XX"
IP_SERVER="Y.Y.Y.Y"

#
# Log su file degli errori di questo script, in aggiunta all'echo su
# stdout (che raggiunge comunque l'email di cron, se MAILTO è
# configurato) — così un fallimento resta visibile anche sui nodi dove
# cron non invia email per i job falliti. File dedicato agli script di
# manutenzione lanciati da cron (distinto da trace-mon.log, che è il
# log del daemon), ruotato da logrotate insieme a trace-mon.log (stessa
# stanza in config/logrotate.conf).
#
LOGFILE="/home/meshcore/trace-mon/logs/cron-errors.log"
mkdir -p "$(dirname "$LOGFILE")"

log_err() {
    echo "$1"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$1" >> "$LOGFILE"
}

#
# Rotazione: esporta il mese appena concluso da path_observations
# (dentro data/contacts.db) in backup/path_observations-YYYY-MM.json.gz,
# rimuove quelle righe dalla tabella live, compatta il DB. Va eseguito
# PRIMA del prossimo giro di contact_sync.sh (stesso ordine già in uso
# tra backup.sh e trace.sh), così il Collettore riceve un contacts.db
# già compattato.
#
./tools/rotate_path_observations.py

if [ $? -ne 0 ]; then
    log_err "Errore durante la rotazione di path_observations"
    exit 1
fi

#
# Stessa logica per repeater_neighbours (docs/NEIGHBOR_MONITORING.md
# §13) — unica tra le tabelle di neighbor_monitor a rappresentare
# stato accumulato in RAM dal repeater, azzerato ad ogni suo reboot e
# non recuperabile da nessun'altra fonte una volta perso.
#
./tools/rotate_repeater_neighbours.py

if [ $? -ne 0 ]; then
    log_err "Errore durante la rotazione di repeater_neighbours"
    exit 1
fi

#
# Se non è stato prodotto alcun archivio (es. nessuna osservazione
# nel mese appena concluso), non c'è nulla da inviare — esce senza
# errore.
#
YEAR=$(date +"%Y")
MONTH=$(date +"%m")
MONTH=$((10#$MONTH - 1))

if [ $MONTH -eq 0 ]; then
    MONTH=12
    YEAR=$((YEAR - 1))
fi

MONTH=$(printf "%02d" "$MONTH")
FILEOUTZIP="path_observations-$YEAR-$MONTH.json.gz"
FILEOUTZIP2="repeater_neighbours-$YEAR-$MONTH.json.gz"

cd /home/meshcore/trace-mon/backup

#
# I due file sono indipendenti (path_observations e
# repeater_neighbours provengono da tabelle diverse, ruotate sopra da
# due script python separati): un fallimento sul primo scp NON deve
# impedire il tentativo del secondo. SCP_FAILED tiene traccia di un
# eventuale fallimento e lo script esce con errore solo alla fine,
# dopo aver comunque tentato entrambi gli invii.
#
SCP_FAILED=0

if [ -f "$FILEOUTZIP" ]; then
    scp -P 15450 $FILEOUTZIP trace-mon@$IP_SERVER:/home/trace-mon/backup/$NODE

    if [ $? -ne 0 ]; then
        log_err "Errore durante l'invio di $FILEOUTZIP al Collettore"
        SCP_FAILED=1
    fi
fi

if [ -f "$FILEOUTZIP2" ]; then
    scp -P 15450 $FILEOUTZIP2 trace-mon@$IP_SERVER:/home/trace-mon/backup/$NODE

    if [ $? -ne 0 ]; then
        log_err "Errore durante l'invio di $FILEOUTZIP2 al Collettore"
        SCP_FAILED=1
    fi
fi

if [ $SCP_FAILED -ne 0 ]; then
    exit 1
fi

exit 0
MAINTSCRIPT_EOF
            ;;

        trace.sh)
            cat > "$output" << 'MAINTSCRIPT_EOF'
#!/bin/bash

cd /home/meshcore/trace-mon

NODE="node_XX"
IP_SERVER="Y.Y.Y.Y"

#
# Log su file degli errori di questo script, in aggiunta all'echo su
# stdout (che raggiunge comunque l'email di cron, se MAILTO è
# configurato) — così un fallimento resta visibile anche sui nodi dove
# cron non invia email per i job falliti. File dedicato agli script di
# manutenzione lanciati da cron (distinto da trace-mon.log, che è il
# log del daemon), ruotato da logrotate insieme a trace-mon.log (stessa
# stanza in config/logrotate.conf).
#
LOGFILE="/home/meshcore/trace-mon/logs/cron-errors.log"
mkdir -p "$(dirname "$LOGFILE")"

log_err() {
    echo "$1"
    printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(basename "$0")" "$1" >> "$LOGFILE"
}

./main_trace.py

if [ $? -ne 0 ]; then
    log_err "Errore durante l'esecuzione di main_trace.py"
    exit 1
fi

sleep 10
cd /home/meshcore/trace-mon/data
scp -P 15450 trace.json trace-mon@$IP_SERVER:/home/trace-mon/data/$NODE

if [ $? -ne 0 ]; then
    log_err "Errore durante l'invio di trace.json al Collettore"
    exit 1
fi

exit 0
MAINTSCRIPT_EOF
            ;;
    esac

    sed -i "s/NODE=\"node_XX\"/NODE=\"$NODE_ID\"/" "$output"
    sed -i "s/IP_SERVER=\"Y.Y.Y.Y\"/IP_SERVER=\"$IP_SERVER\"/" "$output"

    chmod +x "$output"

    echo "  generato: $output"
}

for script in backup.sh contact_sync.sh rotate_contacts.sh trace.sh; do
    write_maint_script "$script"
done

echo

#
# ============================================================
# Parte 2: config.yaml
# ============================================================
#
echo "--- Parte 2: config.yaml ---"
echo

if confirm_overwrite "config/config.yaml"; then

    echo "Tipo di connessione al companion MeshCore:"
    echo "  1) TCP"
    echo "  2) Seriale (USB)"
    echo "  3) BLE"
    read -p "Scelta [1-3]: " CONN_CHOICE

    case "$CONN_CHOICE" in
        1) CONN_TYPE="tcp" ;;
        2) CONN_TYPE="serial" ;;
        3) CONN_TYPE="ble" ;;
        *)
            echo "ERRORE: scelta non valida."
            exit 1
            ;;
    esac

    if [ "$CONN_TYPE" = "tcp" ]; then

        read -p "Host TCP: " TCP_HOST

        if [ -z "$TCP_HOST" ]; then
            echo "ERRORE: l'host TCP non può essere vuoto."
            exit 1
        fi

        read -p "Porta TCP [5000]: " TCP_PORT
        TCP_PORT="${TCP_PORT:-5000}"

    elif [ "$CONN_TYPE" = "serial" ]; then

        read -p "Device seriale [/dev/ttyUSB0]: " SERIAL_DEVICE
        SERIAL_DEVICE="${SERIAL_DEVICE:-/dev/ttyUSB0}"

        read -p "Baudrate [115200]: " SERIAL_BAUDRATE
        SERIAL_BAUDRATE="${SERIAL_BAUDRATE:-115200}"

    elif [ "$CONN_TYPE" = "ble" ]; then

        read -p "Indirizzo BLE (es. AA:BB:CC:DD:EE:FF): " BLE_ADDRESS

        if [ -z "$BLE_ADDRESS" ]; then
            echo "ERRORE: l'indirizzo BLE non può essere vuoto."
            exit 1
        fi
    fi

    echo
    echo "Path da tracciare — elenco di prefissi separati da virgola,"
    echo "formato: aaaa,bbbb,aaaa (es. 0001,0002,0001)."
    read -p "Path: " TRACE_PATH

    if [ -z "$TRACE_PATH" ]; then
        echo "ERRORE: il path non può essere vuoto."
        exit 1
    fi

    read -p "Nome del repeater da interrogare (neighbor_monitoring): " REPEATER_NAME

    if [ -z "$REPEATER_NAME" ]; then
        echo "ERRORE: il nome del repeater non può essere vuoto."
        exit 1
    fi

    mkdir -p config

    #
    # Heredoc con delimitatore NON quotato (CONFIG_EOF, non
    # 'CONFIG_EOF') — qui VOGLIAMO che setup.sh interpoli subito le
    # variabili $TCP_HOST ecc., a differenza degli script sopra:
    # config.yaml non ha variabili proprie da preservare letterali,
    # è dati statici.
    #
    cat > config/config.yaml << CONFIG_EOF
connection:
  type: $CONN_TYPE
  max_reconnect_attempts: 5
  recovery_retry_interval: 30
  heartbeat_interval: 15   # secondi tra un health-check attivo e l'altro
  heartbeat_timeout: 5     # timeout del singolo get_bat() di verifica

  tcp:
    host: ${TCP_HOST:-<connection-tcp-host>}
    port: ${TCP_PORT:-5000}

  serial:
    device: ${SERIAL_DEVICE:-/dev/ttyUSB0}
    baudrate: ${SERIAL_BAUDRATE:-115200}

  ble:
    address: ${BLE_ADDRESS:-AA:BB:CC:DD:EE:FF}

trace:
  enabled: true
  output_file: data/trace.json
  interval: 10
  timeout: 15
  backup: true

  # Ogni entry può portare un suffisso ,true/,false per abilitare o
  # disabilitare il path senza rimuoverlo (utile se una tratta radio
  # diventa temporaneamente non disponibile) — nessun suffisso
  # equivale a ,true. Aggiungi/rimuovi/attiva altri path con
  # config.sh dopo l'installazione, invece di editare qui a mano.
  paths:
    - "$TRACE_PATH,true"

bot:
  enabled: true
  channel_name: "#bot"
  max_reply_length: 152
  known_regions:
    - "europe"
    - "it"

logging:
  level: INFO
  file: logs/trace-mon.log
  console: false

contacts:
  enabled: true
  db_file: data/contacts.db
  sync_interval: 3600

neighbor_monitoring:
  # Nessun parametro di cadenza qui: la cadenza è quella dell'unica
  # entry di crontab che lancia main_neighbor_monitor.py — coerente
  # col pattern già usato per trace/advert (vedi
  # docs/NEIGHBOR_MONITORING.md §4/§6).
  interval: 5   # secondi di attesa tra un repeater e il successivo, se più di uno
  max_retries: 3   # tentativi per singola interrogazione radio fallita, prima di passare oltre

  repeaters:
    - name: "$REPEATER_NAME"

services:
  - name: system
    enabled: true
    module: system.service
    class: SystemService

  - name: trace
    enabled: true
    module: trace.service
    class: TraceService

  - name: advert
    enabled: true
    module: advert.service
    class: AdvertService

  - name: bot
    enabled: true
    module: bot.service
    class: BotService

  - name: contact_sync
    enabled: true
    module: contact_sync.service
    class: ContactSyncService

  - name: neighbor_monitor
    enabled: true
    module: neighbor_monitor.service
    class: NeighborMonitorService
CONFIG_EOF

    #
    # Validazione: config.yaml appena scritto deve essere YAML
    # sintatticamente valido (PyYAML è comunque una dipendenza
    # obbligatoria del progetto, vedi requirements.txt).
    #
    if [ -x ".venv/bin/python3" ]; then

        .venv/bin/python3 -c "import yaml; yaml.safe_load(open('config/config.yaml'))" \
            && echo "  generato: config/config.yaml (YAML valido)" \
            || echo "  ATTENZIONE: config/config.yaml scritto ma non è YAML valido — controllalo a mano."
    else
        echo "  generato: config/config.yaml (non validato — .venv non ancora creato)"
    fi

else
    echo "  config/config.yaml — saltato."
fi

echo

#
# ============================================================
# Parte 3: servizio systemd (trace-web.service)
#
# trace-mon.service invece è già nel repository (systemd/trace-mon.service),
# invariato — non richiede adattamenti, non generato da questo script.
# ============================================================
#
echo "--- Parte 3: servizio systemd (trace-web.service) ---"
echo

NODE_BIN="$(which node || true)"

if [ -z "$NODE_BIN" ]; then
    echo "ERRORE: 'node' non trovato nel PATH. Installa Node.js"
    echo "(vedi INSTALL.md) prima di rilanciare questa parte."
    exit 1
fi

echo "Rilevato Node.js in: $NODE_BIN"

if confirm_overwrite "systemd/trace-web.service"; then

    mkdir -p systemd

    cat > systemd/trace-web.service << 'SERVICE_EOF'
[Unit]
Description=MeshCore Trace-Path Web Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=meshcore
Group=meshcore
WorkingDirectory=/home/meshcore/trace-mon
ExecStart=__NODE_BIN__ /home/meshcore/trace-mon/frontend/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE_EOF

    #
    # NODE_BIN può contenere '/' (fa parte del path) — uso '#' come
    # separatore sed invece del solito '/' per non doverlo escapare.
    #
    sed -i "s#__NODE_BIN__#$NODE_BIN#" systemd/trace-web.service

    echo "  generato: systemd/trace-web.service"

else
    echo "  systemd/trace-web.service — saltato."
fi

echo
echo "=== Setup completato ==="
echo
echo "Per attivare i servizi:"
echo "  sudo cp systemd/trace-mon.service systemd/trace-web.service /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now trace-mon trace-web"
