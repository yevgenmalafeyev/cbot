#!/bin/sh
# Confine the cbot containers to internet egress only.
#
# Run on the docker host. Idempotent. Install as /usr/local/sbin/ and let
# cbot-firewall.service invoke it on boot and whenever docker restarts.
#
# The box runs agents with root inside it that read arbitrary web pages and
# mail. Without these rules a hijacked agent could reach the host's sshd and
# every machine on the host's private network.
#
# ALLOWED   outbound to the public internet (v4 and v6); core <-> box on their
#           own bridge; inbound to core's published port from the reverse
#           proxy; optionally one port on one host for the exit proxy.
# BLOCKED   private, CGNAT and link-local ranges (your private network and the
#           other docker bridges); the host itself on every address.
#
# The rules live in their OWN chains rather than DOCKER-USER, so another
# script that flushes DOCKER-USER cannot silently reopen everything.
#
# Two hooks are needed: FORWARD covers container -> elsewhere, but traffic to
# an address local to the host (its sshd, the bridge gateway) is delivered
# through INPUT and never touches FORWARD.

set -e

BRIDGE=br-cbot
PUBLISHED_PORT=8790
# The only machine allowed to reach core's published port, when the reverse
# proxy runs on another host. Leave empty if the proxy is on this host and the
# port is bound to 127.0.0.1.
PROXY_HOST=${PROXY_HOST:-}
# Optional exit proxy (deploy/office-exit): the one private address and port
# the box may reach. Leave empty if unused.
EXIT_PROXY_HOST=${EXIT_PROXY_HOST:-}
EXIT_PROXY_PORT=${EXIT_PROXY_PORT:-3129}
V4_BLOCKED="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10"
# Add the host's own public IPv6 /64 here if the containers have native IPv6.
V6_BLOCKED="fc00::/7 fe80::/10 ${HOST_V6_PREFIX:-}"

for ipt in iptables ip6tables; do
    for pair in "FORWARD CBOT-FWD" "INPUT CBOT-IN"; do
        set -- $pair
        $ipt -N "$2" 2>/dev/null || $ipt -F "$2"
        while $ipt -D "$1" -j "$2" 2>/dev/null; do :; done
        # Position 1: docker's own FORWARD rules accept bridge egress, so ours
        # must be evaluated before them.
        $ipt -I "$1" 1 -j "$2"
    done
done

# --- FORWARD ------------------------------------------------------------------
for ipt in iptables ip6tables; do
    # replies to proxied requests travel container -> proxy and would match
    # the private-range drop below
    $ipt -A CBOT-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
    # core <-> box (seen here when bridge netfilter is on)
    $ipt -A CBOT-FWD -i "$BRIDGE" -o "$BRIDGE" -j RETURN
done
if [ -n "$PROXY_HOST" ]; then
    iptables -A CBOT-FWD -o "$BRIDGE" -p tcp --dport "$PUBLISHED_PORT" ! -s "$PROXY_HOST" -j DROP
fi
# The one way into the private network, if configured: the exit proxy, which
# only forwards to public web ports. See deploy/office-exit.
if [ -n "$EXIT_PROXY_HOST" ]; then
    iptables -A CBOT-FWD -i "$BRIDGE" -d "$EXIT_PROXY_HOST" -p tcp --dport "$EXIT_PROXY_PORT" -j RETURN
fi
# Nothing from outside starts a connection into the containers: the screens
# (VNC without a password), boxd and core's internal API all listen there, and
# with public IPv6 addresses docker's own rules are not something to rely on.
# The published port is IPv4 only.
iptables  -A CBOT-FWD -o "$BRIDGE" ! -i "$BRIDGE" -p tcp --dport "$PUBLISHED_PORT" -j RETURN
iptables  -A CBOT-FWD -o "$BRIDGE" ! -i "$BRIDGE" -m conntrack --ctstate NEW -j DROP
ip6tables -A CBOT-FWD -o "$BRIDGE" ! -i "$BRIDGE" -m conntrack --ctstate NEW -j DROP
for net in $V4_BLOCKED; do iptables  -A CBOT-FWD -i "$BRIDGE" -d "$net" -j DROP; done
# With native IPv6 the containers' own range lies inside the host's /64, which
# is blocked as a whole to cover the host and the other bridges; intra-bridge
# traffic already returned above.
for net in $V6_BLOCKED; do ip6tables -A CBOT-FWD -i "$BRIDGE" -d "$net" -j DROP; done

# --- INPUT: container -> the host itself --------------------------------------
iptables  -A CBOT-IN -i "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables  -A CBOT-IN -i "$BRIDGE" -j DROP
ip6tables -A CBOT-IN -i "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# Neighbour Discovery is ICMPv6 received on INPUT; dropping it kills IPv6 for
# the containers the next time they are recreated.
ip6tables -A CBOT-IN -i "$BRIDGE" -p ipv6-icmp -j RETURN
ip6tables -A CBOT-IN -i "$BRIDGE" -j DROP

echo "cbot container egress rules applied to $BRIDGE"
