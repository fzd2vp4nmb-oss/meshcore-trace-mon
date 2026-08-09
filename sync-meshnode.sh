#!/bin/bash

cd /home/meshcore/trace-mon/frontend

NODE="node_XX"

scp -P 15450 mesh-nodes.json trace-mon@IP_SERVER:/home/trace-mon/data/$NODE

exit 0
