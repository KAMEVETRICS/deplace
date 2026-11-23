#!/usr/bin/env bash
# Installs or updates the Deplace board on an Ubuntu 24.04 server (AWS Lightsail or EC2):
# Node 24, the board as a systemd service, and Caddy for HTTPS with a Let's Encrypt certificate.
#
#   sudo bash setup.sh board.example.com
#
# The hostname must resolve straight to this server (on Cloudflare: "DNS only", not proxied),
# and ports 80 and 443 must be open, so that Caddy can get the certificate.
# The first run leaves the board stopped. Put these in place, then run `sudo systemctl start deplace`:
#   /etc/deplace/secrets/sponsor.export, operator.export, attestor.key (owner root, group deplace, mode 640)
#   /opt/deplace/dist/deplace.schema.b64, the module schema from scripts/build-contract.ps1
#   /var/lib/deplace/board.db when moving an existing board. Only one board may hold the operator key:
#     a second escrow worker with its own database could pay the same reward twice.
# Later runs pull main, rebuild the web app and restart the board.
set -euo pipefail

HOST="${1:?usage: sudo bash setup.sh <public hostname>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_VERSION=24.19.0
REPO=https://github.com/KAMEVETRICS/deplace.git
APP=/opt/deplace
APT=(apt-get -q -y -o DPkg::Lock::Timeout=600)

export DEBIAN_FRONTEND=noninteractive
"${APT[@]}" update
"${APT[@]}" install git curl xz-utils caddy

# Swap, because the web build needs more memory than a 1 GB instance has free.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Node: the version the board is developed on, checked against nodejs.org's checksums.
if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  case "$(dpkg --print-architecture)" in
    amd64) arch=x64 ;;
    arm64) arch=arm64 ;;
    *) echo "unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;;
  esac
  pkg="node-v$NODE_VERSION-linux-$arch.tar.xz"
  tmp=$(mktemp -d)
  curl -fsSLo "$tmp/$pkg" "https://nodejs.org/dist/v$NODE_VERSION/$pkg"
  curl -fsSLo "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $pkg\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$pkg" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$tmp"
fi

id deplace >/dev/null 2>&1 || useradd --system --home-dir /var/lib/deplace --shell /usr/sbin/nologin deplace
install -d -o deplace -g deplace -m 700 /var/lib/deplace
install -d -o root -g deplace -m 750 /etc/deplace /etc/deplace/secrets

# npm ci replaces node_modules, so the board must not run during the update.
was_running=no
if systemctl is-active --quiet deplace; then
  was_running=yes
  systemctl stop deplace
fi

if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone "$REPO" "$APP"; fi
cd "$APP"
npm ci --no-audit --no-fund
npm run build -w web

if [ ! -f /etc/deplace/board.env ]; then
  cat > /etc/deplace/board.env <<EOF
PORT=8787
PUBLIC_BASE_URL=https://$HOST
DB_PATH=/var/lib/deplace/board.db
GRPC_HOST=grpc.testnet.concordium.com
GRPC_PORT=20000
CONTRACT_INDEX=13123
CONTRACT_SUBINDEX=0
REWARD_TOKEN_ID=EUDemo
FAUCET_URL=https://allowlist.testnet.concordium.com
SPONSOR_KEY_FILE=/etc/deplace/secrets/sponsor.export
OPERATOR_KEY_FILE=/etc/deplace/secrets/operator.export
ATTESTOR_KEY_FILE=/etc/deplace/secrets/attestor.key
SPONSOR_MIN_CCD=100
SPONSOR_STOP_CCD=20
EOF
  chgrp deplace /etc/deplace/board.env
  chmod 640 /etc/deplace/board.env
fi

install -m 644 "$HERE/deplace.service" /etc/systemd/system/deplace.service
systemctl daemon-reload
systemctl enable deplace

cat > /etc/caddy/Caddyfile <<EOF
$HOST {
	reverse_proxy 127.0.0.1:8787
}
EOF
systemctl reload-or-restart caddy

if [ "$was_running" = yes ]; then
  systemctl start deplace
  echo "board updated and restarted"
else
  echo "board installed, not started. Add the key files, the schema and, when moving a board, its database; then: sudo systemctl start deplace"
fi
