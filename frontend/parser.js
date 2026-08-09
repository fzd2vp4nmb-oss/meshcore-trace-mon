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

    const headerRegex =
        /^(\d{8}_\d{6})\s+([a-fA-F0-9,:]+)$/gm;

    const matches =
        [...content.matchAll(headerRegex)];

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
                : content.length;

        const rawPath =
            current[2];

        const normalizedPath =
            (
                !rawPath.includes(",") &&
                rawPath.includes(":")
            )
                ? rawPath.split(":")[0]
                : rawPath;

        records.push({
            timestampRaw:
                current[1],

            pathString:
                normalizedPath,

            payload:
                content
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
            json.path.length >
                0
        ) {

            links.push(
                {

                    label:
                        `SRC→${json.path[0].hash}`,

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
                            `${prev.hash}→${curr.hash}`,

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
                            `${lastHop.hash}→SRC`,

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
