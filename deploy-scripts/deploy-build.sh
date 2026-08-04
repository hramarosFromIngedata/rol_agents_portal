#!/bin/bash

set -e

PROJECT_DIR="$(pwd)"
BUILD_DIR="$PROJECT_DIR/build"

echo "Cleaning..."

rm -rf .next
rm -rf "$BUILD_DIR"

echo "Installing dependencies..."

npm ci

echo "Building..."

npm run build

echo "Preparing standalone..."

mkdir -p "$BUILD_DIR"

rsync -avz .next/standalone/ "$BUILD_DIR/"

mkdir -p "$BUILD_DIR/.next/static/"

rsync -avz .next/static/ "$BUILD_DIR/.next/static/"

if [ -d public ]; then
    cp -r public/ "$BUILD_DIR/public/"
fi

echo "Copying environment variables..."

cp .env.local "$BUILD_DIR/.env.local" 2>/dev/null || true

echo "Build ready"

rsync -avz --delete build/ nantenaina@192.168.1.222:~/deploy/rol-automation.ingedata/