#!/bin/bash

set -e

SOURCE="/home/nantenaina/deploy/rol-automation.ingedata"
TARGET="/var/www/rol-automation.ingedata"

SERVICE="rol-portal"

echo "Stopping service..."

systemctl stop $SERVICE

echo "Creating target..."

rm -rf "$TARGET"

mkdir -p "$TARGET"

echo "Copying..."

rsync -avz --delete \
--exclude=".env" \
"$SOURCE"/ \
"$TARGET"/

echo "Permissions..."

chown -R www-data:www-data "$TARGET"

find "$TARGET" -type d -exec chmod 755 {} \;

find "$TARGET" -type f -exec chmod 644 {} \;

echo "Executable..."

chmod +x "$TARGET/server.js"

echo "Starting..."

systemctl start $SERVICE

echo "Status..."

systemctl --no-pager status $SERVICE

echo "Listening..."

ss -tulpn | grep 3000 || true

echo "Done."