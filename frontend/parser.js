const fs = require("fs");

const TIMEOUT_SNR = -50;

function formatTimestamp(ts) {

    const y = ts.substring(0, 4);
    const m = ts.substring(4, 6);
    const d = ts.substring(6, 8);

    const hh = ts.substring(9, 11);
    const mm = ts.substring(11, 13);

    return `${d}/${m}/${y} ${hh}:${mm}`;
}

function buildSignature(pathString) {

    return `SRC→${pathString.replace(/,/g, "→")}→SRC`;
}

function extractRecords(content) {

    const records = [];

    //
    // Robustezza CRLF (code review 2026-08-20, §4) — in modalità
    // multilinea (flag "m"), JavaScript riconosce SOLO "\n" come
    // terminatore di riga per ^/$: se trace.json (o un archivio) è
    // mai stato scritto/toccato con terminatori CRLF (es. editor
    // Windows, un trasferimento che ha convertito i fine riga), ogni
    // header restava seguito da un "\r" residuo subito prima del
    // "\n" — un carattere non incluso in [a-fA-F0-9,:]+, quindi $
    // non trovava mai match giusto lì e l'intero record veniva
    // silenziosamente scartato (nessun errore, solo dati mancanti).
    // Normalizzare CRLF/CR isolati a LF prima del parsing rende il
    // risultato indipendente dai terminatori di riga del file.
    //
    const normalizedContent =
        content.replace(
            /\r\n?/g,
            "\n"
        );

    const headerRegex =
        /^(\d{8}_\d{6})\s+([a-fA-F0-9,:]+)$/gm;

    const matches =
        [...normalizedContent.matchAll(headerRegex)];

    for (
        let i = 0;
        i < matches.length;
        i++
    ) {

        const current =
            matches[i];

        const start =
            current.index +
            current[0].length;

        const end =
            i <
            matches.length - 1
                ? matches[i + 1].index
                : normalizedContent.length;

        const rawPath =
            current[2];

        //
        // Normalizzazione case (code review 2026-08-20, §4) — i
        // prefissi hex nell'header (current[2]) e quelli in
        // json.path[].hash nel payload possono differire per
        // maiuscole/minuscole a seconda della fonte (radio vs
        // trace.sh storico): senza normalizzare, lo stesso path
        // logico genererebbe due signature diverse in
        // buildSignature() (una per "AAAA,BBBB", una per
        // "aaaa,bbbb"), frammentando silenziosamente lo storico
        // dello stesso path in due voci separate nella UI.
        //
        const normalizedPath =
            (
                (
                    !rawPath.includes(",") &&
                    rawPath.includes(":")
                )
                    ? rawPath.split(":")[0]
                    : rawPath
            ).toLowerCase();

        records.push({
            timestampRaw:
                current[1],

            pathString:
                normalizedPath,

            payload:
                normalizedContent
                    .substring(
                        start,
                        end
                    )
                    .trim()
        });
    }

    return records;
}

function ensurePath(
    result,
    signature
) {

    if (
        !result.paths[
            signature
        ]
    ) {

        result.paths[
            signature
        ] = {

            observations:
                0,

            timeouts:
                0,

            linkSeries:
                {},

            linkStats:
                {},

            pathObservations:
                []
        };
    }

    return result.paths[
        signature
    ];
}

/* ==========================================
   NEW GENERIC PARSER

   This function parses a trace
   already loaded in memory.

   Future archive support will
   use this entry point.
========================================== */

function parseTraceContent(
    content
) {

    const records =
        extractRecords(
            content
        );

    const result = {

        totalTimeouts:
            0,

        paths:
            {}
    };

    for (
        const rec
        of records
    ) {

        const signature =
            buildSignature(
                rec.pathString
            );

        const pathData =
            ensurePath(
                result,
                signature
            );

        const timestamp =
            formatTimestamp(
                rec.timestampRaw
            );

        let json;

        try {

            json =
                JSON.parse(
                    rec.payload
                );

        }

        catch {

            continue;
        }

        const nodes =
            rec.pathString.split(
                ","
            );

        /* =========================
           TIMEOUT
        ========================= */

        if (
            json.error
        ) {

            result
                .totalTimeouts++;

            pathData
                .timeouts++;

            const row = {

                timestamp,

                status:
                    "TIMEOUT"
            };

            const links =
                [];

            links.push(
                `SRC→${nodes[0]}`
            );

            for (
                let i = 1;
                i <
                nodes.length;
                i++
            ) {

                links.push(
                    `${nodes[i - 1]}→${nodes[i]}`
                );
            }

            links.push(
                `${nodes[nodes.length - 1]}→SRC`
            );

            for (
                const link
                of links
            ) {

                row[
                    link
                ] =
                    "TIMEOUT";

                if (
                    !pathData
                        .linkSeries[
                            link
                        ]
                ) {

                    pathData
                        .linkSeries[
                            link
                        ] = [];
                }

                pathData
                    .linkSeries[
                        link
                    ]
                    .push(
                        {

                            x:
                                timestamp,

                            y:
                                TIMEOUT_SNR,

                            timeout:
                                true
                        }
                    );
            }

            pathData
                .pathObservations
                .push(
                    row
                );

            continue;
        }

        /* =========================
           VALID TRACE
        ========================= */

        pathData
            .observations++;

        const row = {

            timestamp,

            status:
                "OK"
        };

        const links =
            [];

        if (
            json.path &&
            json.path.length ===
                1
        ) {

            /*
             * path_len === 0 (contatto diretto): l'UNICO elemento
             * di json.path è il "rientro senza hash" descritto in
             * ARCHITECTURE.md §3 (l'ultimo elemento di path non ha
             * mai 'hash'), non un hop con hash come per path più
             * lunghi. Prima di questo fix (code review 2026-08-20,
             * §3.5), json.path[0].hash era undefined qui e produceva
             * un link "SRC→undefined". nodes[0] (il nodo configurato
             * per questo trace, stessa fonte già usata dal ramo
             * TIMEOUT sopra) è la destinazione nota e affidabile per
             * il link diretto.
             */

            links.push(
                {

                    label:
                        `SRC→${nodes[0]}`,

                    snr:
                        json.path[0].snr
                }
            );

        } else if (
            json.path &&
            json.path.length >
                0
        ) {

            //
            // .toLowerCase() sugli hash del payload (code review
            // 2026-08-20, §4) — coerenza con la normalizzazione case
            // già applicata a `nodes`/pathString in extractRecords():
            // senza questo, le label dei link costruite qui
            // (`json.path[].hash`) e quelle costruite nel ramo
            // path.length===1 sopra (`nodes[0]`, già minuscolo)
            // userebbero case diversi per lo stesso nodo logico,
            // frammentando linkSeries/linkStats in serie separate.
            //
            links.push(
                {

                    label:
                        `SRC→${json.path[0].hash.toLowerCase()}`,

                    snr:
                        json.path[0].snr
                }
            );

            for (
                let i = 1;
                i <
                json.path.length -
                    1;
                i++
            ) {

                const prev =
                    json.path[
                        i - 1
                    ];

                const curr =
                    json.path[
                        i
                    ];

                if (
                    !prev?.hash ||
                    !curr?.hash
                ) {

                    continue;
                }

                links.push(
                    {

                        label:
                            `${prev.hash.toLowerCase()}→${curr.hash.toLowerCase()}`,

                        snr:
                            curr.snr
                    }
                );
            }

            const lastHop =
                json.path[
                    json.path
                        .length -
                        2
                ];

            const returnHop =
                json.path[
                    json.path
                        .length -
                        1
                ];

            if (
                lastHop?.hash &&
                returnHop
            ) {

                links.push(
                    {

                        label:
                            `${lastHop.hash.toLowerCase()}→SRC`,

                        snr:
                            returnHop.snr
                    }
                );
            }
        }

        links.forEach(
            link => {

                row[
                    link.label
                ] =
                    link.snr;

                if (
                    !pathData
                        .linkSeries[
                            link
                                .label
                        ]
                ) {

                    pathData
                        .linkSeries[
                            link
                                .label
                        ] = [];
                }

                pathData
                    .linkSeries[
                        link
                            .label
                    ]
                    .push(
                        {

                            x:
                                timestamp,

                            y:
                                link.snr,

                            timeout:
                                false
                        }
                    );

                if (
                    !pathData
                        .linkStats[
                            link
                                .label
                        ]
                ) {

                    pathData
                        .linkStats[
                            link
                                .label
                        ] = {

                        count:
                            0,

                        sum:
                            0,

                        min:
                            Infinity,

                        max:
                            -Infinity
                    };
                }

                const stat =
                    pathData
                        .linkStats[
                            link
                                .label
                        ];

                stat.count++;

                stat.sum +=
                    link.snr;

                stat.min =
                    Math.min(
                        stat.min,
                        link.snr
                    );

                stat.max =
                    Math.max(
                        stat.max,
                        link.snr
                    );
            }
        );

        pathData
            .pathObservations
            .push(
                row
            );
    }

    return result;
}

/* ==========================================
   FILE PARSER

   Current live mode wrapper.

   Future archive mode will call
   parseTraceContent() directly.
========================================== */

function parseTraceFile(
    file
) {

    const content =
        fs.readFileSync(
            file,
            "utf8"
        );

    return parseTraceContent(
        content
    );
}

module.exports = {
    parseTraceFile,
    parseTraceContent
};
