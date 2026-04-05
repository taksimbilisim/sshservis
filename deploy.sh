#!/bin/bash
set -e

# SSH Service deploy script
# Web-based SSH terminal service
# SSL ve nginx reverse proxy'yi BT Panel'den ayarla

read -p "Alan adı (örn: sshservis.example.com): " DOMAIN
[[ -n "${DOMAIN}" ]] || { echo "!! Alan adı boş olamaz."; exit 1; }

APP_DIR="/www/wwwroot/${DOMAIN}"

echo "==> Node.js kontrol..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "    Node: $(node -v)"

echo "==> Repo klonlanıyor..."
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull
else
  rm -rf "$APP_DIR"
  git clone https://github.com/taksimbilisim/sshservis.git "$APP_DIR"
fi

cd "$APP_DIR"
npm install --production

echo "==> .env oluşturuluyor..."
TOKEN_SECRET=$(openssl rand -hex 32)

# Base domain'i çıkar (sshservis.example.com → example.com)
BASE_DOMAIN=$(echo "$DOMAIN" | sed 's/^[^.]*\.//')

cat > "$APP_DIR/.env" << EOF
PORT=3100
TOKEN_SECRET=$TOKEN_SECRET
ALLOWED_ORIGINS=*.${BASE_DOMAIN}
EOF
chmod 600 "$APP_DIR/.env"

echo "==> Systemd servisi oluşturuluyor..."
cat > /etc/systemd/system/sshservis.service << SVCEOF
[Unit]
Description=SSH Web Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable sshservis
systemctl restart sshservis

echo ""
echo "========================================"
echo "  SSH Service kuruldu!"
echo "========================================"
echo "  Klasor: $APP_DIR"
echo "  Port:   3100"
echo "  Domain: https://$DOMAIN"
echo ""
echo "  TOKEN_SECRET: $TOKEN_SECRET"
echo ""
echo "  BT Panel'den yapılacaklar:"
echo "  1. $DOMAIN icin site olustur"
echo "  2. SSL sertifikasi al"
echo "  3. Reverse Proxy ekle: http://127.0.0.1:3100"
echo "     - WebSocket destegi aktif et"
echo ""
echo "  Bu secret'i mobilencoderadmin'e ekle:"
echo "  Anahtarlar > ssh_service_token_secret"
echo "========================================"
