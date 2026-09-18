#!/bin/bash
# A real payment from a real card, over the production MCP endpoint. Shown on camera.
U=$(cat "$(dirname "$0")/../tmp/mcp_url")
AMOUNT=${1:-0.03}; MEMO=${2:-"API credits"}
call() { curl -s -m 170 -X POST "$U" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
  | sed -n 's/^data: //p' | python3 -c 'import sys,json
for l in sys.stdin:
    l=l.strip()
    if not l: continue
    d=json.loads(l); r=d.get("result",d)
    for c in r.get("content",[]): print(c.get("text",""))'; }
G=$'\e[32m'; Y=$'\e[33m'; D=$'\e[2m'; B=$'\e[1m'; N=$'\e[0m'
echo "${D}# agent connected to KeeperCard over MCP${N}"
sleep 0.8
echo "${B}› keeperhub_dry_run${N}  to=0x66b6…EC5a  amount=$AMOUNT USDC  memo=\"$MEMO\""
R=$(call keeperhub_dry_run "{\"to\":\"0x66b6082Eb6c7a9457F25479fa35b6061F2c4EC5a\",\"amount\":\"$AMOUNT\",\"memo\":\"$MEMO\"}")
echo "$R" | python3 -c 'import sys,json; d=json.load(sys.stdin)
G="\033[32m";Y="\033[33m";D="\033[2m";N="\033[0m"
print(f"  status      {G}{d[\"status\"]}{N}")
print(f"  plan_id     {d[\"plan_id\"]}")
print(f"  digest      {d[\"digest\"][:22]}…")
print(f"  executor    {d[\"executor\"]}  ·  workflow {d[\"workflow\"]}")
s=d["simulation"]; print(f"  simulation  {G}would_revert={str(s[\"would_revert\"]).lower()}{N}  gas={s[\"gas_estimate\"]}  engine={s[\"engine\"]}")
print(f"  fee         {d[\"fee\"]} USDC  →  total {d[\"total\"]} USDC")
r=d["risk"]; print(f"  risk        {Y}{r[\"level\"]}/{r[\"score\"]}{N}  {D}(assessor unavailable — advisory){N}")
print(f"{D}  nothing has touched the chain{N}")
open("/dev/shm/kc_plan","w").write(d["plan_id"])'
sleep 1.2
P=$(cat /dev/shm/kc_plan)
echo
echo "${B}› pay${N}  plan_id=$P"
echo "${D}  executing through KeeperHub …${N}"
R=$(call pay "{\"plan_id\":\"$P\"}")
echo "$R" | python3 -c 'import sys,json; d=json.load(sys.stdin)
G="\033[32m";D="\033[2m";N="\033[0m"
print(f"  status      {G}{d[\"status\"]}{N}")
print(f"  tx          {d[\"tx\"]}")
print(f"  amount      {d[\"amount\"]} USDC  +  fee {d[\"fee\"]} USDC")
print(f"  {D}https://sepolia.basescan.org/tx/{d[\"tx\"]}{N}")'
