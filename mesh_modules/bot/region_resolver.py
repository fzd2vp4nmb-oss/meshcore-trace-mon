"""
Risoluzione del flood-scope (region) di un pacchetto MeshCore.

Il transport_code a bordo pacchetto è un MAC con chiave, calcolato dal
firmware come:

    key  = SHA256("#" + nome_regione)[:16]
    code = HMAC-SHA256(key, payload_type || payload)[:2]  (uint16 little-endian)

Dipende anche dal payload, non solo dal nome della regione — quindi non
esiste una decodifica diretta. Per risalire al nome si ricalcola il
codice per ogni nome candidato configurato e si cerca una corrispondenza.

Logica portata da Remote-Terminal-for-MeshCore
(jkingsman/Remote-Terminal-for-MeshCore, app/region_resolver.py), che
la usa in produzione con lo stesso approccio.
"""

import hashlib
import hmac

_key_cache = {}


def normalize_region_scope(scope):

    stripped = (scope or "").strip()

    if stripped in ("", "0", "*"):
        return ""

    if stripped.startswith("#"):
        return stripped

    return f"#{stripped}"


def _region_key(region_name):

    normalized = normalize_region_scope(region_name)

    if not normalized:
        return None

    key = _key_cache.get(normalized)

    if key is None:
        key = hashlib.sha256(normalized.encode("utf-8")).digest()[:16]
        _key_cache[normalized] = key

    return key


def compute_transport_code(region_name, payload_type, payload):

    key = _region_key(region_name)

    if key is None:
        return None

    digest = hmac.new(
        key,
        bytes([payload_type & 0xFF]) + payload,
        hashlib.sha256
    ).digest()

    code = int.from_bytes(digest[:2], "little")

    #
    # Il firmware evita i valori riservati 0x0000/0xFFFF
    #
    if code == 0:
        code = 1
    elif code == 0xFFFF:
        code = 0xFFFE

    return code


def resolve_region(payload_type, payload, transport_code, region_names):

    for name in region_names:

        if not name:
            continue

        if compute_transport_code(name, payload_type, payload) == transport_code:
            return name

    return None
