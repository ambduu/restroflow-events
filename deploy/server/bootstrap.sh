#!/usr/bin/env bash
# One-time (idempotent) setup for an Ubuntu server (Hetzner Cloud, Oracle Cloud, any VPS).
# Run by the deploy workflow over SSH; safe to run again.
set -euo pipefail

APP_DIR=/opt/restroflow
REPO=https://github.com/ambduu/restroflow-events.git

log() { echo "==> $*"; }

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker"
  curl -fsSL https://get.docker.com | sudo sh
  if [ "$(id -u)" -ne 0 ]; then sudo usermod -aG docker "$(id -un)"; fi
fi
sudo systemctl enable --now docker >/dev/null

# 2. Host firewall. Hetzner/most VPS images have no host rules (use the provider's
#    cloud firewall instead); Oracle's Ubuntu images REJECT everything except SSH,
#    so only in that case open 80/443 before the REJECT rule.
if sudo iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
  for port in 80 443; do
    if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
      log "opening tcp/$port before the REJECT rule"
      sudo iptables -I INPUT 1 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    fi
  done
  sudo iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p udp --dport 443 -j ACCEPT
  if command -v netfilter-persistent >/dev/null 2>&1; then sudo netfilter-persistent save >/dev/null; fi
fi

# 3. Swap (helps the first Docker build on small shapes)
if ! sudo swapon --show | grep -q /swapfile; then
  log "adding 2 GB swap"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 4. Code
sudo mkdir -p "$APP_DIR"
sudo chown "$(id -un)":"$(id -gn)" "$APP_DIR"
if [ ! -d "$APP_DIR/repo/.git" ]; then
  log "cloning $REPO"
  git clone --depth 1 "$REPO" "$APP_DIR/repo"
fi

# 5. Automatic security updates
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null
fi

log "bootstrap done"
