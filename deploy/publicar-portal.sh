#!/usr/bin/env bash
# Publica el portal argoss.cl (login con selección de planta) en /var/www/argoss.
# Usa el mismo login.html del SCADA, la lista plantas.json y la fuente del logotipo (public/fonts/).
# Ejecutar desde la carpeta del proyecto después de cada "git pull" que cambie el login o las plantas:
#   bash deploy/publicar-portal.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-/var/www/argoss}"

sudo mkdir -p "$DEST"
sudo cp "$DIR/public/login.html" "$DEST/index.html"
sudo cp "$DIR/plantas.json"      "$DEST/plantas.json"
sudo mkdir -p "$DEST/fonts"
sudo cp "$DIR/public/fonts/"*   "$DEST/fonts/"
sudo chmod 644 "$DEST/index.html" "$DEST/plantas.json" "$DEST/fonts/"*

echo "Portal publicado en $DEST:"
ls -l "$DEST"
