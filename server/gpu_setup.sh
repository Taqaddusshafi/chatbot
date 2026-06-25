#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# GPU Server Setup — vLLM with LLaMA 3.1 8B-Instruct
# ──────────────────────────────────────────────────────────────────────────────
#
# Run this on your GPU server (L40 with 48GB VRAM).
#
# Prerequisites:
#   - Python 3.10+
#   - NVIDIA drivers with CUDA 12.1+
#   - Hugging Face account with LLaMA 3.1 access approved
#   - HF_TOKEN environment variable set
#
# Usage:
#   chmod +x gpu_setup.sh
#   export HF_TOKEN=your_hugging_face_token_here
#   ./gpu_setup.sh
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

echo "╔══════════════════════════════════════════════════╗"
echo "║   vLLM + LLaMA 3.1 Setup for L40 GPU            ║"
echo "╚══════════════════════════════════════════════════╝"

# Check HF_TOKEN
if [ -z "${HF_TOKEN:-}" ]; then
    echo "❌ ERROR: Set HF_TOKEN before running this script."
    echo "   export HF_TOKEN=your_hugging_face_token"
    exit 1
fi

# Check NVIDIA GPU
if ! command -v nvidia-smi &> /dev/null; then
    echo "❌ ERROR: nvidia-smi not found. Install NVIDIA drivers first."
    exit 1
fi

echo ""
echo "🖥️  GPU Info:"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
echo ""

# Create virtual environment
VENV_DIR="$HOME/vllm-env"
if [ ! -d "$VENV_DIR" ]; then
    echo "📦 Creating Python virtual environment at $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

# Install vLLM
echo "📥 Installing vLLM..."
pip install --upgrade pip
pip install vllm

echo ""
echo "✅ vLLM installed successfully!"
echo ""
echo "🚀 To start the server, run:"
echo ""
echo "   source $VENV_DIR/bin/activate"
echo "   export HF_TOKEN=$HF_TOKEN"
echo "   vllm serve meta-llama/Llama-3.1-8B-Instruct \\"
echo "     --host 0.0.0.0 \\"
echo "     --port 8007 \\"
echo "     --gpu-memory-utilization 0.9 \\"
echo "     --max-model-len 8192 \\"
echo "     --dtype auto"
echo ""
echo "   Or simply run: ./start_server.sh"
echo ""

# Create start script
cat > "$(dirname "$0")/start_server.sh" << 'STARTEOF'
#!/usr/bin/env bash
# Quick-start vLLM server for LLaMA 3.1 8B-Instruct

set -euo pipefail

VENV_DIR="$HOME/vllm-env"
source "$VENV_DIR/bin/activate"

echo "🦙 Starting vLLM with LLaMA 3.1 8B-Instruct..."
echo "   Port: 8007"
echo "   GPU Memory: 90%"
echo "   Max Context: 8192 tokens"
echo ""

exec vllm serve meta-llama/Llama-3.1-8B-Instruct \
    --host 0.0.0.0 \
    --port 8007 \
    --gpu-memory-utilization 0.9 \
    --max-model-len 8192 \
    --dtype auto \
    --trust-remote-code
STARTEOF

chmod +x "$(dirname "$0")/start_server.sh"
echo "📝 Created start_server.sh"
