#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"
source .venv/bin/activate

echo "==============================================="
echo "  Comic Slice Test Receiver (Port: 8765)      "
echo "  Saving to: tests/data/                      "
echo "==============================================="

python tests/capture_receiver.py
