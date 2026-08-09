#!/bin/bash

cd /home/meshcore/trace-mon

NODE="node_XX"
./main_trace.py

sleep 10
cd /home/meshcore/trace-mon/data
scp -P 15450 trace.json trace-mon@IP_SERVER:/home/trace-mon/data/$NODE

exit 0
