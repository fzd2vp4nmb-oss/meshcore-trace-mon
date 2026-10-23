"use strict";

/* ==========================================
   device_connection.js

   Stato della connessione tra il daemon del Nodo e il companion
   (docs/ARCHITECTURE.md §94), come lo vede /api/device_status.

   Il daemon scrive in contacts.db, tabella device_connection (riga
   singola): `connected` (0/1), `changed_at` (ultimo cambio di stato),
   `checked_at` (ultima scrittura, anche di sola riconferma, ogni 5
   minuti). Qui si traduce quella riga in uno di TRE stati:

     connected     checked_at recente e connected = 1
     disconnected  checked_at recente e connected = 0
     unknown       checked_at più vecchio di STALE_AFTER_SECS (o riga
                   illeggibile): il valore salvato non è più
                   affidabile, perché il daemon è fermo oppure, sul
                   Collettore, la copia del database non è fresca.
                   Mostrare «connesso» su un dato vecchio sarebbe
                   peggio di dire «non lo so».

   Il confronto avviene con l'ora del SERVER (non quella del browser),
   come per la scheda Analysis (server_time, §88).

   Il modulo è IDENTICO nel Nodo e nel Collettore e sta in un file a
   parte, e non dentro server.js, perché il server.js del Nodo si mette
   in ascolto appena caricato e non si può provare via HTTP (stesso
   motivo di analysis_api.js, §88, D52).

   Solo lettura: nessuna scrittura sul database (aperto readOnly dal
   chiamante) né sul filesystem.
========================================== */

// Oltre questa età di checked_at lo stato è «unknown». Sei volte la
// cadenza di riconferma del daemon (300 s) e più del ritardo massimo della
// copia sul Collettore (contact_sync.sh ogni 5 minuti + ricarica dei dati):
// assorbe un giro di sync saltato senza falsi «sconosciuto», ma un daemon
// fermo emerge in mezz'ora.
const STALE_AFTER_SECS = 30 * 60;

const STATES = Object.freeze(["connected", "disconnected", "unknown"]);

// Numero finito oppure null. node:sqlite restituisce number, bigint, stringa
// o null: una stringa vuota o fatta di soli spazi NON e' 0 (Number("") === 0),
// e qualunque altro tipo (booleano, oggetto, array) e' un valore illeggibile.
function finiteOrNull(value) {

    if (typeof value === "string" && value.trim() === "") {
        return null;
    }

    if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") {
        return null;
    }

    const n = Number(value);

    return Number.isFinite(n) ? n : null;
}

// row: riga di device_connection (o null/undefined); nowSecs: epoch in
// secondi dell'orologio del server. Restituisce null se non c'è nessuna riga
// (nodo non ancora aggiornato, o daemon mai arrivato a scriverla), altrimenti
// { state, changed_at, checked_at }.
function deviceConnectionView(row, nowSecs) {

    if (!row || typeof row !== "object") {
        return null;
    }

    const checked = finiteOrNull(row.checked_at);
    const changed = finiteOrNull(row.changed_at);
    const now = finiteOrNull(nowSecs);

    let state = "unknown";

    if (checked !== null && now !== null && (now - checked) <= STALE_AFTER_SECS) {

        const value = finiteOrNull(row.connected);

        if (value === 1) {
            state = "connected";
        } else if (value === 0) {
            state = "disconnected";
        }
    }

    return { state: state, changed_at: changed, checked_at: checked };
}

// db: DatabaseSync già aperto dal chiamante (readOnly). Un database di un
// nodo non ancora aggiornato non ha la tabella: non è un errore, il campo
// resta null e il frontend non mostra nessun indicatore. Ogni altro errore
// SQLite risale al chiamante (500 generico, come per il resto dell'endpoint).
function readDeviceConnection(db, nowSecs) {

    let row;

    try {

        row = db.prepare(
            "SELECT connected, changed_at, checked_at FROM device_connection WHERE id = 1"
        ).get();

    } catch (err) {

        if (err && /no such table/i.test(String(err.message))) {
            return null;
        }

        throw err;
    }

    return deviceConnectionView(row, nowSecs);
}

module.exports = {
    STALE_AFTER_SECS: STALE_AFTER_SECS,
    STATES: STATES,
    deviceConnectionView: deviceConnectionView,
    readDeviceConnection: readDeviceConnection
};
