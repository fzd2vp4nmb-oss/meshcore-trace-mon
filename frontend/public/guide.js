/*
   guide.js - comportamento della guida a pannelli (guide_it.html; la futura guide_en.html lo riusa).

   Il file e' identico nei repository Nodo e Collettore (un test lo verifica). Fa quattro cose:
     1. tema: se la dashboard e' in modalita' scura (localStorage "theme" = "dark") mette la classe "dark"
        sull'elemento <html> (guide.css la usa). Gira subito, nell'<head>, per non far lampeggiare la pagina;
     2. rimandi e indirizzi con '#': apre il pannello del titolo indicato e tutti i pannelli che lo contengono
        (il browser da solo non apre un <details> chiuso in ogni caso) e porta il titolo sotto la barra;
     3. «Espandi tutto» / «Comprimi tutto» (i pulsanti sono nell'HTML, nascosti finche' lo script non gira);
     4. stampa: apre tutti i pannelli prima di stampare e ripristina lo stato dopo.
   Senza script la guida si legge lo stesso: i pannelli si aprono col clic sul titolo.

   La parte che decide quali pannelli aprire non tocca il DOM del browser: si carica anche da Node
   (module.exports) ed e' provata dai test del repository.
*/
(function () {
    "use strict";

    // ---------- parte pura ----------

    function isDetails(n) {
        return !!n && n.nodeType === 1 && String(n.tagName).toUpperCase() === "DETAILS";
    }

    // Pannelli chiusi da aprire perche' l'elemento sia visibile: il suo (se e' il titolo di un pannello)
    // e tutti quelli che lo contengono. Ordine: dal piu' interno al piu' esterno.
    function panelsToOpen(el) {
        var list = [];
        for (var n = el; n; n = n.parentNode) {
            if (isDetails(n) && !n.open) { list.push(n); }
        }
        return list;
    }

    // "#analysis-terms" -> "analysis-terms" (decodificato); null se vuoto o malformato
    function idFromHash(hash) {
        if (!hash || hash.charAt(0) !== "#" || hash.length < 2) { return null; }
        try { return decodeURIComponent(hash.slice(1)); } catch (e) { return null; }
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { panelsToOpen: panelsToOpen, idFromHash: idFromHash };
    }
    if (typeof document === "undefined") { return; }

    // ---------- tema ----------

    function applyTheme() {
        try {
            document.documentElement.classList.toggle("dark", localStorage.getItem("theme") === "dark");
        } catch (e) { /* storage non disponibile: tema chiaro */ }
    }
    applyTheme();
    window.addEventListener("storage", function (ev) {
        if (ev.key === "theme") { applyTheme(); }
    });

    // ---------- pannelli ----------

    var bulk = false;      // true mentre si apre/chiude tutto o si stampa: niente scorrimenti automatici

    function allPanels() {
        return Array.prototype.slice.call(document.querySelectorAll("details"));
    }

    function bulkEnd() {
        setTimeout(function () { bulk = false; }, 80);   // gli eventi "toggle" arrivano dopo il cambio di open
    }

    function barOffset() {
        var bar = document.querySelector(".guideBar");
        return (bar ? bar.offsetHeight : 0) + 8;
    }

    function reduceMotion() {
        return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }

    // Scorre alla posizione indicata; senza "smooth" il salto e' immediato anche se il CSS ha scroll-behavior: smooth.
    function jumpTo(top, smooth) {
        top = Math.max(0, top);
        try {
            window.scrollTo({ top: top, behavior: smooth && !reduceMotion() ? "smooth" : "instant" });
        } catch (e) {                                      // browser che non conosce "instant"
            window.scrollTo(0, top);
        }
    }

    // Porta il titolo sotto la barra. Per il titolo di una sezione si porta in vista il pannello intero;
    // per gli altri si tiene conto anche del titolo agganciato della sezione che li contiene.
    function scrollToTarget(el, smooth) {
        var panel = el.closest ? el.closest("details") : null;
        var node = el;
        var offset = barOffset();
        if (panel && el.tagName === "H3") {
            node = panel;
        } else {
            var sec = el.closest ? el.closest("details.guideSec") : null;
            if (sec && sec.firstElementChild && sec.firstElementChild.tagName === "SUMMARY") {
                offset += sec.firstElementChild.offsetHeight;
            }
        }
        var top = node.getBoundingClientRect().top + window.pageYOffset - offset;
        jumpTo(top, smooth);
    }

    function showTarget(id, smooth) {
        var el = id ? document.getElementById(id) : null;
        if (!el) { return false; }
        panelsToOpen(el).forEach(function (d) { d.open = true; });
        scrollToTarget(el, smooth);
        return true;
    }

    document.addEventListener("click", function (ev) {
        if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) { return; }
        var a = ev.target && ev.target.closest ? ev.target.closest('a[href^="#"]') : null;
        if (!a) { return; }
        var id = idFromHash(a.getAttribute("href"));
        if (!id || !document.getElementById(id)) { return; }
        ev.preventDefault();
        showTarget(id, true);
        try { history.pushState(null, "", "#" + encodeURIComponent(id)); } catch (e) { /* ignorato */ }
    });

    window.addEventListener("hashchange", function () {
        showTarget(idFromHash(window.location.hash), true);
    });

    // Chiudendo un pannello che e' finito sopra la barra (sezione lunga, titolo agganciato) si torna al suo inizio.
    document.addEventListener("toggle", function (ev) {
        var d = ev.target;
        if (bulk || !isDetails(d) || d.open) { return; }
        var limit = barOffset();
        var top = d.getBoundingClientRect().top;
        if (top < limit) { jumpTo(window.pageYOffset + top - limit, false); }
    }, true);

    // ---------- Espandi tutto / Comprimi tutto ----------

    function setAll(open) {
        bulk = true;
        allPanels().forEach(function (d) { d.open = open; });
        bulkEnd();
    }

    // ---------- stampa ----------

    var printState = null;

    function beforePrint() {
        if (printState) { return; }
        bulk = true;
        printState = allPanels().map(function (d) { var was = d.open; d.open = true; return [d, was]; });
    }

    function afterPrint() {
        if (!printState) { return; }
        printState.forEach(function (p) { p[0].open = p[1]; });
        printState = null;
        bulkEnd();
    }

    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    if (window.matchMedia) {
        var mql = window.matchMedia("print");
        var onPrintChange = function (m) { if (m.matches) { beforePrint(); } else { afterPrint(); } };
        if (mql.addEventListener) { mql.addEventListener("change", onPrintChange); }
        else if (mql.addListener) { mql.addListener(onPrintChange); }
    }

    // ---------- avvio ----------

    function init() {
        var tools = document.querySelector(".guideTools");
        if (tools) {
            tools.hidden = false;
            tools.addEventListener("click", function (ev) {
                var b = ev.target && ev.target.closest ? ev.target.closest("button[data-guide]") : null;
                if (!b) { return; }
                setAll(b.getAttribute("data-guide") === "expand");
            });
        }
        var id = idFromHash(window.location.hash);
        if (id) {
            showTarget(id, false);
            // dopo il caricamento delle immagini l'altezza della pagina cambia: si riporta il titolo in vista
            window.addEventListener("load", function () {
                if (idFromHash(window.location.hash) === id) { showTarget(id, false); }
            });
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
