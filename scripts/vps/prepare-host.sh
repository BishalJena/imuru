#!/usr/bin/env bash
# Run on a fresh Oracle Cloud Ubuntu VM (as root). Oracle's Ubuntu images ship
# iptables rules that reject everything except SSH, including forwarded
# traffic, which breaks both the Ingress ports and k3s pod networking.
set -euo pipefail

iptables -C INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT 2>/dev/null \
  || iptables -I INPUT 5 -p tcp -m multiport --dports 80,443 -m state --state NEW -j ACCEPT
iptables -D INPUT -j REJECT --reject-with icmp-host-prohibited 2>/dev/null || true
iptables -D FORWARD -j REJECT --reject-with icmp-host-prohibited 2>/dev/null || true
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; fi
echo "firewall: 80/443 open, host-prohibited REJECT rules removed"
