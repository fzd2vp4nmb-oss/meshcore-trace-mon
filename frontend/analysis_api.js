"use strict";

/* ==========================================
   analysis_api.js

   Endpoint di SOLA LETTURA della scheda «Analysis» (docs/ARCHITECTURE.md
   §88). Sono due, e servono i JSON già calcolati da analysis_job.js:

     GET /api/analysis/:analysis/windows
         elenco delle finestre (index.json: finestre, orario di calcolo,
         esito dell'ultimo giro) + server_time (orario del server, perché il
         browser non debba fidarsi del proprio orologio per dire «dati
         vecchi»);
     GET /api/analysis/:analysis/data?window=ID
         il JSON di una finestra (all, live o AAAA-MM).

   NESSUN calcolo per richiesta (§41, §61): il Collettore è esposto su
   internet e serve tutti i nodi, un endpoint che rifacesse l'analisi a ogni
   richiesta sarebbe un amplificatore di carico. Qui si legge un file di
   poche decine di KB e lo si tiene in memoria finché mtime e dimensione non
   cambiano (il job lo riscrive in modo atomico, .tmp + rename).

   Il modulo è IDENTICO nel Nodo e nel Collettore: l'unica differenza è la
   directory passata a register() (Nodo data/analysis, Collettore
   state/analysis), decisa dal server.js di ciascuno. Sta in un file a parte,
   e non dentro server.js, perché il server.js del Nodo si mette in ascolto
   appena caricato e non si può provare via HTTP (v. §88, D52).

   Sicurezza: il nome dell'analisi è una allowlist (ANALYSES), la finestra
   deve rispettare esattamente WINDOW_ID_RE E comparire in index.json; il path
   del file è costruito solo da valori già validati, mai da dati dell'utente
   o del file. Errori 500: messaggio generico (§3.5), il dettaglio solo nel
   log del server. Nessuna scrittura sul filesystem (trace-web.service ha
   ProtectSystem=strict).
========================================== */

const fs = require("fs");
const path = require("path");

// Analisi servite. La scheda è un contenitore: una nuova analisi si aggiunge
// qui (e nel job, che la scrive in <baseDir>/<analisi>/).
const ANALYSES = Object.freeze(["propagation"]);

const WINDOW_ID_RE = /^(all|live|\d{4}-\d{2})$/;

const MAX_CACHE_ENTRIES = 64;

function register(app, options) {

    const opts = options || {};

    if (!opts.baseDir || typeof opts.baseDir !== "string") {
        throw new Error("analysis_api: baseDir mancante");
    }

    const baseDir = opts.baseDir;
    const genericError = typeof opts.genericError === "string" && opts.genericError
        ? opts.genericError
        : "Errore interno del server";
    const log = typeof opts.log === "function" ? opts.log : console.error;
    const nowSecs = typeof opts.now === "function"
        ? opts.now
        : () => Math.floor(Date.now() / 1000);

    const cache = new Map();

    // Legge e valida un file JSON; lo tiene in memoria finché mtime e
    // dimensione non cambiano. ENOENT arriva al chiamante (= «non c'è»).
    async function readCached(file) {

        const st = await fs.promises.stat(file);
        const hit = cache.get(file);

        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
            return hit;
        }

        const text = await fs.promises.readFile(file, "utf8");
        const value = JSON.parse(text);

        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("contenuto non valido");
        }

        if (cache.size >= MAX_CACHE_ENTRIES) {
            cache.clear();
        }

        const entry = { mtimeMs: st.mtimeMs, size: st.size, text: text, value: value };

        cache.set(file, entry);

        return entry;
    }

    function analysisDir(name) {

        if (typeof name !== "string" || !ANALYSES.includes(name)) {
            return null;
        }

        return path.join(baseDir, name);
    }

    // index.json valido, oppure null se non esiste ancora
    async function readIndex(dir) {

        let entry = null;

        try {
            entry = await readCached(path.join(dir, "index.json"));
        } catch (err) {
            if (err && err.code === "ENOENT") {
                return null;
            }
            throw err;
        }

        if (!Array.isArray(entry.value.windows)) {
            throw new Error("index.json non valido");
        }

        return entry;
    }

    app.get(
        "/api/analysis/:analysis/windows",
        async (req, res) => {

            try {

                const dir = analysisDir(req.params.analysis);

                if (!dir) {
                    return res.status(404).json({ error: "Analysis not found" });
                }

                const index = await readIndex(dir);

                if (!index) {
                    return res.status(404).json({ error: "No analysis data available yet" });
                }

                res.set("Cache-Control", "no-cache");

                return res.json(Object.assign({}, index.value, { server_time: nowSecs() }));

            } catch (err) {

                log("API ERROR (/api/analysis/:analysis/windows):", err);

                return res.status(500).json({ error: genericError });
            }
        }
    );

    app.get(
        "/api/analysis/:analysis/data",
        async (req, res) => {

            try {

                const dir = analysisDir(req.params.analysis);

                if (!dir) {
                    return res.status(404).json({ error: "Analysis not found" });
                }

                const id = req.query.window;

                if (typeof id !== "string" || !WINDOW_ID_RE.test(id)) {
                    return res.status(400).json({ error: "Missing or invalid window parameter" });
                }

                const index = await readIndex(dir);

                if (!index) {
                    return res.status(404).json({ error: "No analysis data available yet" });
                }

                if (!index.value.windows.some(w => w && w.id === id)) {
                    return res.status(404).json({ error: "Window not found" });
                }

                let entry = null;

                try {
                    entry = await readCached(path.join(dir, `${id}.json`));
                } catch (err) {
                    if (err && err.code === "ENOENT") {
                        return res.status(404).json({ error: "Window not found" });
                    }
                    throw err;
                }

                res.set("Cache-Control", "no-cache");
                res.type("application/json");

                return res.send(entry.text);

            } catch (err) {

                log("API ERROR (/api/analysis/:analysis/data):", err);

                return res.status(500).json({ error: genericError });
            }
        }
    );
}

module.exports = {
    ANALYSES,
    WINDOW_ID_RE,
    register
};
