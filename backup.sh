#!/bin/bash

cd /home/meshcore/trace-mon

NODE="node_XX"
YEAR=$(date +"%Y")
MONTH=$(date +"%m")
MONTH=$((10#$MONTH - 1))

if [ $MONTH -eq 0 ]; then
    MONTH=12
    YEAR=$((YEAR - 1))
fi

MONTH=$(printf "%02d" "$MONTH")
FILEOUT="trace-$YEAR-$MONTH.json"
FILEOUTZIP="trace-$YEAR-$MONTH.json.gz"

cp data/trace.json backup/$FILEOUT
sleep 10
gzip backup/$FILEOUT
sleep 10
rm -f data/trace.json
sleep 10
touch data/trace.json
sleep 10
cd /home/meshcore/trace-mon/backup
scp -P 15450 $FILEOUTZIP trace-mon@IP_SERVER:/home/trace-mon/backup/$NODE

exit 0
