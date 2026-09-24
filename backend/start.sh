#!/bin/bash
# Stelcera — Backend Startup
# Usage: cd backend && bash start.sh

set -e

echo "============================================"
echo "  STELCERA — BACKEND"
echo "============================================"
echo ""

# Install dependencies
echo "[1/3] Installing dependencies..."
pip install -r requirements.txt -q

echo "[2/3] Starting server..."
echo ""
echo "  Frontend:  http://localhost:8000"
echo "  API docs:  http://localhost:8000/docs"
echo "  WS:        ws://localhost:8000/ws"
echo "  Health:    http://localhost:8000/health"
echo ""
echo "[3/3] Server running. Press Ctrl+C to stop."
echo ""

uvicorn main:app --host 0.0.0.0 --port 8000 --reload
