#
# Lookup nome -> contatto condiviso (code review 2026-08-20, §3.2;
# corretto nella verifica logica post-deploy dello stesso giorno).
#
# Prima di questo fix, NeighborMonitorModule._resolve_contact()
# (match case-sensitive esatto, NESSUN fallback per sottostringa) e
# SystemService._contact_info() (match case-insensitive, CON
# fallback per sottostringa) risolvevano lo stesso tipo di ricerca
# con logiche duplicate e non condivise — comportamento inconsistente
# a seconda di quale via si interroga lo stesso contatto (es.
# maiuscole/minuscole diverse tra neighbor_monitoring.repeaters in
# config.yaml e l'adv_name reale annunciato dal device).
#
# Le differenze di comportamento tra i due chiamanti restano
# ENTRAMBE intenzionali — qui unifichiamo solo l'implementazione, non
# il comportamento:
# - case_sensitive: neighbor_monitor deve restare case-sensitive
#   esatto. Un fallback case-insensitive nella campagna automatica
#   rischierebbe di far interrogare silenziosamente un repeater
#   diverso da quello configurato in caso di nomi simili solo nel
#   maiuscolo/minuscolo — un primo tentativo di unificazione aveva
#   reso case-insensitive anche questo chiamante per errore (rilevato
#   nella verifica logica post-deploy), qui corretto.
# - allow_substring: solo il comando system/contact interattivo lo
#   usa, per comodità dell'operatore che digita il comando; per la
#   stessa ragione di cui sopra NON va mai abilitato per
#   neighbor_monitor.
#

def find_contact_by_name(
    contacts,
    name,
    allow_substring=False,
    case_sensitive=False
):
    """
    Cerca un contatto per adv_name tra i contatti (dict
    pubkey -> contatto, come restituito da mesh.contacts).

    Match esatto per primo (case-sensitive se case_sensitive=True,
    case-insensitive altrimenti); se allow_substring=True e nessun
    match esatto è stato trovato, prova un match per sottostringa
    (sempre case-insensitive, indipendentemente da case_sensitive —
    ha senso solo come comodità per un operatore che digita un
    comando, mai per una risoluzione automatica) — primo trovato,
    iterazione non ordinata come il dict di origine.

    Ritorna il contatto trovato, o None.
    """

    if not name or not contacts:
        return None

    if case_sensitive:
        for c in contacts.values():
            if (c.get("adv_name") or "") == name:
                return c
    else:
        name_lower = name.lower()

        for c in contacts.values():
            if (c.get("adv_name") or "").lower() == name_lower:
                return c

    if allow_substring:
        name_lower = name.lower()

        for c in contacts.values():
            if name_lower in (c.get("adv_name") or "").lower():
                return c

    return None
