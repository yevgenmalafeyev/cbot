#!/bin/sh
# Run on the docker host. Proves from inside the box that the private network
# and the host are unreachable while the internet is. Exit 0 = good.
#
#   PRIVATE_TARGETS="10.0.0.5 10.0.0.6" ./verify-isolation.sh
#
# PRIVATE_TARGETS: addresses that must NOT be reachable from the box: this
# host's own private address and a few neighbours on its network. The docker
# bridge gateways are always checked.
fail=0
probe() { docker exec cbot-box timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }
for ip in ${PRIVATE_TARGETS:-} 172.28.0.1 172.17.0.1; do
    if probe "$ip" 22; then echo "FAIL  $ip:22 is reachable"; fail=1; else echo "ok    $ip:22 blocked"; fi
done
for t in "1.1.1.1 443" "api.anthropic.com 443" "api.telegram.org 443"; do
    set -- $t
    if probe "$1" "$2"; then echo "ok    $1:$2 reachable"; else echo "FAIL  $1:$2 not reachable"; fail=1; fi
done
# the single exception, if an exit proxy is configured (a TCP accept only
# proves the firewall lets it through, not that the far end is up)
if [ -n "${EXIT_PROXY_HOST:-}" ]; then
    port=${EXIT_PROXY_PORT:-3129}
    if probe "$EXIT_PROXY_HOST" "$port"; then echo "ok    $EXIT_PROXY_HOST:$port (exit proxy) reachable"; else echo "FAIL  $EXIT_PROXY_HOST:$port (exit proxy) not reachable"; fail=1; fi
fi
exit $fail
