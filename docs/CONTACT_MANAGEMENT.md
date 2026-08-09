# Gestione contatti e storico

## Schema

`data/contacts.db` (SQLite) contiene:

- **`nodes`** — stato corrente di ogni nodo conosciuto (nome,
  chiave pubblica, tipo, ultima posizione nota, ultimo path visto).
- **`path_observations`** — storico di ogni osservazione di path per
  ciascun nodo (illimitato, soggetto a rotazione mensile — vedi
  sotto).

## Acquisizione

Ibrida: eventi in tempo reale dal companion (quando arriva un
advertisement o una risposta di trace) aggiornano `nodes`
immediatamente; una sincronizzazione periodica (`contact_sync`,
intervallo configurabile) riallinea l'intera lista contatti,
compensando eventuali eventi persi.

Il Raspberry mantiene un'istantanea consistente del database (via
`VACUUM INTO`, sicura anche mentre il daemon scrive attivamente)
esportata periodicamente — utile se in futuro si vuole distribuire
questa istantanea altrove.

## Rotazione mensile

`path_observations` cresce senza limite se non gestita. Il giorno 1
di ogni mese, `rotate_contacts.sh` esporta il mese appena concluso
in `backup/path_observations-YYYY-MM.json.gz`, rimuove quelle righe
dalla tabella live e compatta il database. Idempotente — può essere
rilanciato senza effetti collaterali se non c'è nulla da archiviare.

## Frontend

La tab Nodes offre un selettore **Live / Storico**: il primo mostra
lo stato corrente da `nodes`, il secondo permette di sfogliare gli
archivi mensili prodotti dalla rotazione, per ciascun nodo.
