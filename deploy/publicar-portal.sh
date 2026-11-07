#!/usr/bin/env bash
# Publica el portal argoss.cl (login con selección de planta) en /var/www/argoss.
# Usa el mismo login.html del SCADA y la lista plantas.json del repositorio.
# Ejecutar desde la carpeta del proyecto después de cada "git pull" que cambie el login o las plantas:
#   bash deploy/publicar-portal.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-/var/www/argoss}"

sudo mkdir -p "$DEST"
sudo cp "$DIR/public/login.html" "$DEST/index.html"
sudo cp "$DIR/plantas.json"      "$DEST/plantas.json"
sudo chmod 644 "$DEST/index.html" "$DEST/plantas.json"

echo "Portal publicado en $DEST:"
ls -l "$DEST"
