#!/data/data/com.termux/files/usr/bin/bash
set -e

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║        🔥  HUNTPRICE PERÚ  v1.0.0               ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  Monitor de Ofertas Flash - Tiendas Peruanas    ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Change to project directory
cd "$(dirname "$0")"

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js no encontrado."
  echo "   Instala con: pkg install nodejs"
  exit 1
fi

NODE_VER=$(node --version 2>/dev/null | sed 's/v//')
NODE_MAJOR=$(echo $NODE_VER | cut -d. -f1)
echo "✅ Node.js $NODE_VER"

if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "❌ Se requiere Node.js 22.5+ (node:sqlite). Tienes $NODE_VER"
  echo "   Actualiza con: pkg install nodejs"
  exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo ""
  echo "📦 Instalando dependencias..."
  npm install
  echo "✅ Dependencias instaladas"
else
  echo "✅ Dependencias ya instaladas"
fi

# Copy .env if not exists
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "📋 Archivo .env creado desde .env.example"
    echo "   Puedes editarlo con: nano .env"
  fi
fi

# Create necessary directories
mkdir -p public/icons

echo ""
echo "🚀 Iniciando servidor..."
echo ""

# Start server
node server.js
