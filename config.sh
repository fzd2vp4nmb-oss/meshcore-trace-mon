#!/bin/bash
#
# config.sh — menu interattivo per modificare config/config.yaml senza
# un editor di testo. Ogni modifica passa da tools/edit_config.py, che
# fa backup automatico prima di scrivere e valida il risultato dopo
# (ripristino automatico dal backup se qualcosa va storto — vedi
# tools/edit_config.py per i dettagli).
#

cd "$(dirname "$0")"

PY="./.venv/bin/python3"
ENGINE="tools/edit_config.py"

if [ ! -f "config/config.yaml" ]; then
    echo "ERRORE: config/config.yaml non trovato — esegui prima setup.sh."
    exit 1
fi

CHANGES_MADE=0

engine() {
    "$PY" "$ENGINE" "$@"
}

pause() {
    read -p "Premi invio per continuare... "
}

# ============================================================
# Sottomenu: connessione
# ============================================================
menu_connection() {

    current_type=$(engine get connection.type)

    echo
    echo "--- Connessione (tipo attuale: $current_type) ---"
    echo "  1) TCP"
    echo "  2) Seriale"
    echo "  3) BLE"
    echo "  0) Torna indietro (nessuna modifica)"
    read -p "Scelta: " choice

    case "$choice" in

        1)
            current_host=$(engine get connection.tcp.host)
            current_port=$(engine get connection.tcp.port)

            read -p "Host TCP [$current_host]: " host
            host="${host:-$current_host}"

            read -p "Porta TCP [$current_port]: " port
            port="${port:-$current_port}"

            engine set connection.type tcp
            engine set connection.tcp.host "$host"
            engine set connection.tcp.port "$port"
            CHANGES_MADE=1
            ;;

        2)
            current_device=$(engine get connection.serial.device)
            current_baudrate=$(engine get connection.serial.baudrate)

            read -p "Device seriale [$current_device]: " device
            device="${device:-$current_device}"

            read -p "Baudrate [$current_baudrate]: " baudrate
            baudrate="${baudrate:-$current_baudrate}"

            engine set connection.type serial
            engine set connection.serial.device "$device"
            engine set connection.serial.baudrate "$baudrate"
            CHANGES_MADE=1
            ;;

        3)
            current_address=$(engine get connection.ble.address)

            read -p "Indirizzo BLE [$current_address]: " address
            address="${address:-$current_address}"

            engine set connection.type ble
            engine set connection.ble.address "$address"
            CHANGES_MADE=1
            ;;

        0)
            return
            ;;

        *)
            echo "Scelta non valida."
            ;;
    esac
}

# ============================================================
# Sottomenu: trace
# ============================================================
menu_trace() {

    while true; do

        current_interval=$(engine get trace.interval)
        current_timeout=$(engine get trace.timeout)

        echo
        echo "--- Trace ---"
        echo "(per attivare/disattivare l'intero modulo: menu 6 'Servizi')"
        echo "  1) Elenca path configurati"
        echo "  2) Aggiungi un path"
        echo "  3) Rimuovi un path"
        echo "  4) Attiva/disattiva un path esistente"
        echo "  5) Imposta intervallo tra un path e il successivo (attuale: ${current_interval}s)"
        echo "  6) Imposta timeout risposta TRACE_DATA (attuale: ${current_timeout}s)"
        echo "  0) Torna indietro"
        read -p "Scelta: " choice || { echo; return; }

        case "$choice" in

            1)
                engine trace-path-list
                pause
                ;;

            2)
                echo "Formato path: aaaa,bbbb,aaaa (prefissi esadecimali separati da virgola)"
                read -p "Nuovo path: " path
                read -p "Abilitarlo subito? [Y/n]: " yn
                if [[ "$yn" =~ ^[Nn]$ ]]; then
                    enabled="false"
                else
                    enabled="true"
                fi
                engine trace-path-add "$path" "$enabled"
                CHANGES_MADE=1
                ;;

            3)
                engine trace-path-list
                read -p "Path da rimuovere (solo il path, senza indicare lo stato): " path
                engine trace-path-remove "$path"
                CHANGES_MADE=1
                ;;

            4)
                engine trace-path-list
                read -p "Path da attivare/disattivare (solo il path, senza indicare lo stato): " path
                read -p "Abilitarlo? [y/N]: " yn
                if [[ "$yn" =~ ^[Yy]$ ]]; then
                    engine trace-path-set-enabled "$path" true
                else
                    engine trace-path-set-enabled "$path" false
                fi
                CHANGES_MADE=1
                ;;

            5)
                echo "Secondi di attesa tra un path e il successivo nello stesso giro (minimo 10)."
                read -p "Intervallo [$current_interval]: " interval
                interval="${interval:-$current_interval}"
                engine set trace.interval "$interval"
                CHANGES_MADE=1
                ;;

            6)
                echo "Secondi di attesa di una risposta TRACE_DATA prima di considerare il path fallito (minimo 10)."
                read -p "Timeout [$current_timeout]: " timeout
                timeout="${timeout:-$current_timeout}"
                engine set trace.timeout "$timeout"
                CHANGES_MADE=1
                ;;

            0)
                return
                ;;

            *)
                echo "Scelta non valida."
                ;;
        esac
    done
}

# ============================================================
# Sottomenu: bot
# ============================================================
menu_bot() {

    while true; do

        echo
        echo "--- Bot ---"
        echo "(per attivare/disattivare l'intero modulo: menu 6 'Servizi')"
        echo "  1) Elenca regioni note"
        echo "  2) Aggiungi una regione"
        echo "  3) Rimuovi una regione"
        echo "  0) Torna indietro"
        read -p "Scelta: " choice || { echo; return; }

        case "$choice" in

            1)
                engine list-show bot.known_regions
                pause
                ;;

            2)
                read -p "Nuova regione (es. europe, it, fr): " region
                engine list-add bot.known_regions "$region"
                CHANGES_MADE=1
                ;;

            3)
                engine list-show bot.known_regions
                read -p "Regione da rimuovere (testo esatto come mostrato sopra): " region
                engine list-remove bot.known_regions "$region"
                CHANGES_MADE=1
                ;;

            0)
                return
                ;;

            *)
                echo "Scelta non valida."
                ;;
        esac
    done
}

# ============================================================
# Sottomenu: contacts
# ============================================================
menu_contacts() {

    while true; do

        current_sync_interval=$(engine get contacts.sync_interval)

        echo
        echo "--- Contacts ---"
        echo "(per attivare/disattivare l'intero modulo: menu 6 'Servizi')"
        echo "  1) Imposta intervallo di sync col device (attuale: ${current_sync_interval}s)"
        echo "  0) Torna indietro"
        read -p "Scelta: " choice || { echo; return; }

        case "$choice" in

            1)
                echo "Secondi tra un sync completo col device (get_contacts()) e il"
                echo "successivo (minimo 60). Comunicazione locale, nessun impatto radio —"
                echo "solo più scritture su contacts.db se abbassato molto."
                read -p "Intervallo [$current_sync_interval]: " interval
                interval="${interval:-$current_sync_interval}"
                engine set contacts.sync_interval "$interval"
                CHANGES_MADE=1
                ;;

            0)
                return
                ;;

            *)
                echo "Scelta non valida."
                ;;
        esac
    done
}

# ============================================================
# Sottomenu: repeater (neighbor_monitoring.repeaters)
# ============================================================
menu_repeaters() {

    while true; do

        current_retries=$(engine get neighbor_monitoring.max_retries)
        current_interval=$(engine get neighbor_monitoring.interval)

        echo
        echo "--- Repeater interrogati (tab Repeaters) — tentativi per interrogazione fallita: $current_retries, intervallo tra repeater: ${current_interval}s ---"
        engine repeater-list
        echo
        echo "  1) Aggiungi un repeater"
        echo "  2) Rimuovi un repeater"
        echo "  3) Rinomina un repeater"
        echo "  4) Imposta tentativi per interrogazione fallita"
        echo "  5) Imposta intervallo tra un repeater e il successivo"
        echo "  0) Torna indietro"
        read -p "Scelta: " choice || { echo; return; }

        case "$choice" in

            1)
                read -p "Nome del nuovo repeater: " name
                engine repeater-add "$name"
                CHANGES_MADE=1
                ;;

            2)
                read -p "Nome del repeater da rimuovere (esatto come mostrato sopra): " name
                engine repeater-remove "$name"
                CHANGES_MADE=1
                ;;

            3)
                read -p "Nome attuale: " old_name
                read -p "Nuovo nome: " new_name
                engine repeater-rename "$old_name" "$new_name"
                CHANGES_MADE=1
                ;;

            4)
                echo "Numero di volte che una singola interrogazione radio"
                echo "(status/neighbours/telemetry/region/login/comandi CLI)"
                echo "viene ritentata subito prima di passare oltre. 1 = nessun retry."
                read -p "Tentativi [$current_retries]: " retries
                retries="${retries:-$current_retries}"
                engine set neighbor_monitoring.max_retries "$retries"
                CHANGES_MADE=1
                ;;

            5)
                echo "Secondi di attesa tra un repeater e il successivo, se più di uno"
                echo "configurato — irrilevante con un solo repeater."
                read -p "Intervallo [$current_interval]: " interval
                interval="${interval:-$current_interval}"
                engine set neighbor_monitoring.interval "$interval"
                CHANGES_MADE=1
                ;;

            0)
                return
                ;;

            *)
                echo "Scelta non valida."
                ;;
        esac
    done
}

# ============================================================
# Sottomenu: servizi
# ============================================================
menu_services() {

    while true; do

        echo
        echo "--- Servizi del daemon ---"
        engine service-list
        echo
        echo "Nomi validi: system, trace, advert, bot, contact_sync, neighbor_monitor"
        echo "  1) Attiva un servizio"
        echo "  2) Disattiva un servizio"
        echo "  0) Torna indietro"
        read -p "Scelta: " choice || { echo; return; }

        case "$choice" in

            1)
                read -p "Nome del servizio da attivare: " name
                engine service-set-enabled "$name" true
                CHANGES_MADE=1
                ;;

            2)
                read -p "Nome del servizio da disattivare: " name
                engine service-set-enabled "$name" false
                CHANGES_MADE=1
                ;;

            0)
                return
                ;;

            *)
                echo "Scelta non valida."
                ;;
        esac
    done
}

# ============================================================
# Sottomenu: logging
# ============================================================
menu_logging() {

    current_level=$(engine get logging.level)

    echo
    echo "--- Logging (livello attuale: $current_level) ---"
    echo "  1) DEBUG"
    echo "  2) INFO"
    echo "  3) WARNING"
    echo "  4) ERROR"
    echo "  0) Torna indietro (nessuna modifica)"
    read -p "Scelta: " choice || { echo; return; }

    case "$choice" in
        1) engine set logging.level DEBUG; CHANGES_MADE=1 ;;
        2) engine set logging.level INFO; CHANGES_MADE=1 ;;
        3) engine set logging.level WARNING; CHANGES_MADE=1 ;;
        4) engine set logging.level ERROR; CHANGES_MADE=1 ;;
        0) return ;;
        *) echo "Scelta non valida." ;;
    esac
}

# ============================================================
# Allinea al template (docs/ARCHITECTURE.md §45) — aggiunge a
# config.yaml solo le chiavi che config/config.yaml.template definisce
# ma che qui non ci sono ancora (es. un parametro introdotto da una
# versione più recente del codice, non ancora presente su
# un'installazione già in uso). Non tocca MAI una chiave già presente
# né una lista (path tracciati, repeater, regioni bot, servizi) — per
# quelle restano i menu dedicati sopra.
# ============================================================
menu_align() {

    echo
    echo "--- Allinea al template ---"
    echo "Confronta config.yaml con config/config.yaml.template e"
    echo "aggiunge solo le chiavi mancanti, senza toccare nulla di già"
    echo "presente (personalizzazioni incluse)."
    echo

    output=$(engine align)
    echo "$output"

    if [[ "$output" != *"già allineato"* ]]; then
        CHANGES_MADE=1
    fi

    pause
}

# ============================================================
# Menu principale
# ============================================================
while true; do

    echo
    echo "=== MeshCore trace-mon — Modifica configurazione ==="
    echo "  1) Connessione"
    echo "  2) Trace"
    echo "  3) Bot"
    echo "  4) Contacts"
    echo "  5) Repeater interrogati"
    echo "  6) Servizi"
    echo "  7) Logging"
    echo "  8) Allinea al template (aggiungi parametri mancanti)"
    echo "  0) Esci"
    read -p "Scelta: " main_choice || { echo; break; }

    case "$main_choice" in
        1) menu_connection ;;
        2) menu_trace ;;
        3) menu_bot ;;
        4) menu_contacts ;;
        5) menu_repeaters ;;
        6) menu_services ;;
        7) menu_logging ;;
        8) menu_align ;;
        0) break ;;
        *) echo "Scelta non valida." ;;
    esac
done

if [ "$CHANGES_MADE" -eq 1 ]; then

    echo
    read -p "Modifiche salvate. Riavviare trace-mon.service ora? [y/N]: " yn

    if [[ "$yn" =~ ^[Yy]$ ]]; then
        sudo systemctl restart trace-mon
        echo "trace-mon.service riavviato."
    else
        echo "Ricorda di riavviarlo manualmente quando vuoi:"
        echo "  sudo systemctl restart trace-mon"
    fi

else
    echo
    echo "Nessuna modifica effettuata."
fi
