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

            read -p "Device seriale [$current_device]: " device
            device="${device:-$current_device}"

            engine set connection.type serial
            engine set connection.serial.device "$device"
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

        current_enabled=$(engine get trace.enabled)

        echo
        echo "--- Trace (abilitato: $current_enabled) ---"
        echo "  1) Attiva/disattiva"
        echo "  2) Elenca path configurati"
        echo "  3) Aggiungi un path"
        echo "  4) Rimuovi un path"
        echo "  0) Torna indietro"
        read -p "Scelta: " choice

        case "$choice" in

            1)
                read -p "Abilitare trace? [y/N]: " yn
                if [[ "$yn" =~ ^[Yy]$ ]]; then
                    engine set trace.enabled true
                else
                    engine set trace.enabled false
                fi
                CHANGES_MADE=1
                ;;

            2)
                engine list-show trace.paths
                pause
                ;;

            3)
                echo "Formato path: aaaa,bbbb,aaaa (prefissi esadecimali separati da virgola)"
                read -p "Nuovo path: " path
                engine list-add trace.paths "$path"
                CHANGES_MADE=1
                ;;

            4)
                engine list-show trace.paths
                read -p "Path da rimuovere (testo esatto come mostrato sopra): " path
                engine list-remove trace.paths "$path"
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

        current_enabled=$(engine get bot.enabled)

        echo
        echo "--- Bot (abilitato: $current_enabled) ---"
        echo "  1) Attiva/disattiva"
        echo "  2) Elenca regioni note"
        echo "  3) Aggiungi una regione"
        echo "  4) Rimuovi una regione"
        echo "  0) Torna indietro"
        read -p "Scelta: " choice

        case "$choice" in

            1)
                read -p "Abilitare il bot? [y/N]: " yn
                if [[ "$yn" =~ ^[Yy]$ ]]; then
                    engine set bot.enabled true
                else
                    engine set bot.enabled false
                fi
                CHANGES_MADE=1
                ;;

            2)
                engine list-show bot.known_regions
                pause
                ;;

            3)
                read -p "Nuova regione (es. europe, it, fr): " region
                engine list-add bot.known_regions "$region"
                CHANGES_MADE=1
                ;;

            4)
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

    current_enabled=$(engine get contacts.enabled)

    echo
    echo "--- Contacts (abilitato: $current_enabled) ---"
    read -p "Abilitare contacts? [y/N]: " yn

    if [[ "$yn" =~ ^[Yy]$ ]]; then
        engine set contacts.enabled true
    else
        engine set contacts.enabled false
    fi

    CHANGES_MADE=1
}

# ============================================================
# Sottomenu: repeater (neighbor_monitoring.repeaters)
# ============================================================
menu_repeaters() {

    while true; do

        echo
        echo "--- Repeater interrogati (tab Repeaters) ---"
        engine repeater-list
        echo
        echo "  1) Aggiungi un repeater"
        echo "  2) Rimuovi un repeater"
        echo "  3) Rinomina un repeater"
        echo "  0) Torna indietro"
        read -p "Scelta: " choice

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
        read -p "Scelta: " choice

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
    echo "  0) Esci"
    read -p "Scelta: " main_choice

    case "$main_choice" in
        1) menu_connection ;;
        2) menu_trace ;;
        3) menu_bot ;;
        4) menu_contacts ;;
        5) menu_repeaters ;;
        6) menu_services ;;
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
