#!/usr/bin/env bash
# Secure page (https://vinyl.local) for Vinyl Pi. Runs before nginx starts.
# - Makes a private certificate authority once. Phones trust it once (Settings -> Secure page).
# - Makes the Pi's own certificate from it, and remakes it when the Pi's name or address changes.
# - Writes the nginx site: https on 443 in front of the web app (port 80) and the stream (Icecast).
set -euo pipefail

TLS=/etc/vinyl-pi/tls
ENV_FILE=/etc/vinyl-pi/vinyl.env
SITE=/etc/nginx/sites-available/vinyl-pi
MOUNT=vinyl
# shellcheck source=/dev/null
[[ -r "$ENV_FILE" ]] && source "$ENV_FILE"
MOUNT="${MOUNT:-vinyl}"

install -d -m 755 "$TLS"

# 1. Certificate authority, made once so phones only ever trust it once.
if [[ ! -s "$TLS/ca.key" || ! -s "$TLS/ca.crt" ]]; then
  openssl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 3650 \
    -subj "/CN=Vinyl Pi $(hostname) local CA/O=Vinyl Pi" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$TLS/ca.key" -out "$TLS/ca.crt" 2>/dev/null
  rm -f "$TLS/server.crt"
fi
chmod 600 "$TLS/ca.key"
chmod 644 "$TLS/ca.crt"

# 2. The Pi's certificate: its .local names plus its current addresses.
names="DNS:$(hostname).local,DNS:vinyl.local,DNS:localhost,IP:127.0.0.1,IP:10.42.0.1"
for ip in $(hostname -I 2>/dev/null); do
  [[ "$ip" =~ ^[0-9.]+$ ]] && [[ ",$names," != *",IP:$ip,"* ]] && names="$names,IP:$ip"
done

remake=0
[[ -s "$TLS/server.crt" && -s "$TLS/server.key" ]] || remake=1
[[ "$(cat "$TLS/server.names" 2>/dev/null)" == "$names" ]] || remake=1
openssl x509 -checkend $((30 * 86400)) -noout -in "$TLS/server.crt" >/dev/null 2>&1 || remake=1

if (( remake )); then
  ext=$(mktemp)
  printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$names" >"$ext"
  openssl req -new -nodes -newkey rsa:2048 -subj "/CN=$(hostname).local" \
    -keyout "$TLS/server.key" -out "$TLS/server.csr" 2>/dev/null
  # Apple won't trust certificates that last longer than 825 days.
  openssl x509 -req -in "$TLS/server.csr" -CA "$TLS/ca.crt" -CAkey "$TLS/ca.key" -CAcreateserial \
    -days 800 -sha256 -extfile "$ext" -out "$TLS/server.crt" 2>/dev/null
  rm -f "$ext" "$TLS/server.csr"
  chmod 600 "$TLS/server.key"
  printf '%s' "$names" >"$TLS/server.names"
fi

# 3. nginx site.
cat >"$SITE" <<EOF
# Written by /opt/vinyl-pi/scripts/https.sh. Changes here are overwritten.
server {
    listen 443 ssl;
    server_name _;
    ssl_certificate     $TLS/server.crt;
    ssl_certificate_key $TLS/server.key;
    client_max_body_size 8m;

    # The live stream, same address as the page so the browser allows it.
    location = /$MOUNT {
        proxy_pass http://127.0.0.1:8000/$MOUNT;
        proxy_buffering off;
        proxy_read_timeout 1d;
    }
    # Live updates
    location = /api/events {
        proxy_pass http://127.0.0.1:80;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
    location / {
        proxy_pass http://127.0.0.1:80;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;
    }
}
EOF
ln -sfn "$SITE" /etc/nginx/sites-enabled/vinyl-pi
# The stock site wants port 80, which the web app already has.
rm -f /etc/nginx/sites-enabled/default
exit 0
