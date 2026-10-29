#!/usr/bin/env bash
# One-time (idempotent) server setup for an Oracle Cloud Ubuntu VM.
# Run by the deploy workflow over SSH; safe to run again.
set -euo pipefail

APP_DIR=/opt/restroflow
REPO=https://github.com/ambduu/restroflow-events.git

log() { echo "==> $*"; }

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
sudo systemctl enable --now docker >/dev/null

# 2. Host firewall: Oracle's Ubuntu images reject everything except SSH by default.
#    (Ports 80/443 must ALSO be opened in the VCN security list in the Oracle console.)
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    log "opening tcp/$port"
    sudo iptables -I INPUT 6 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
if ! sudo iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null; then
  sudo iptables -I INPUT 6 -p udp --dport 443 -j ACCEPT
fi
if command -v netfilter-persistent >/dev/null 2>&1; then
  sudo netfilter-persistent save >/dev/null
fi

# 3. Swap (helps the first Docker build on small shapes)
if ! sudo swapon --show | grep -q /swapfile; then
  log "adding 2 GB swap"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 4. Code
sudo mkdir -p "$APP_DIR"
sudo chown "$USER":"$USER" "$APP_DIR"
if [ ! -d "$APP_DIR/repo/.git" ]; then
  log "cloning $REPO"
  git clone --depth 1 "$REPO" "$APP_DIR/repo"
fi

# 5. Automatic security updates
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null
fi

log "bootstrap done"
