#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

JAVA_SRC="java/src/com/sap/hanasupportinfo"
WEB_SRC="src"
OUT="out"
PORTABLE="portable"
JAR_NAME="HANA-Lens.jar"

echo ""
echo "===================================================="
echo " HANA-Lens Build  (Mac/Linux)"
echo "===================================================="
echo ""

echo "[1/4] Compiling Java sources..."
rm -rf "$OUT" && mkdir -p "$OUT"
javac -source 8 -target 8 \
  -XDignore.symbol.file \
  -d "$OUT" \
  "$JAVA_SRC/Json.java" \
  "$JAVA_SRC/TraceIndex.java" \
  "$JAVA_SRC/Commands.java" \
  "$JAVA_SRC/HanaLensServer.java" \
  "$JAVA_SRC/Main.java"
echo "  OK."

echo ""
echo "[2/4] Bundling web resources..."
cp -r "$WEB_SRC" "$OUT/web"
echo "  OK."

echo ""
echo "[3/4] Creating $JAR_NAME..."
rm -f "$JAR_NAME"
jar cfm "$JAR_NAME" java/manifest.txt -C "$OUT" .
echo "  OK."

echo ""
echo "[4/4] Updating portable/ folder..."
mkdir -p "$PORTABLE"
cp "$JAR_NAME" "$PORTABLE/$JAR_NAME"
chmod +x "$PORTABLE/start.sh" 2>/dev/null || true
echo "  OK."

echo ""
echo "===================================================="
echo " Build successful: $JAR_NAME"
echo ""
echo " Run with:  java -jar $JAR_NAME"
echo " Portable:  portable/$JAR_NAME"
echo "===================================================="
echo ""
