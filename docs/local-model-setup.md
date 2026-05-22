# Local Model Setup

How to set up the local LLM workers for the deep-memory indexing pipeline. Models are served as an OpenAI-compatible API on port 8020.

Two runtimes are supported:

| Runtime | Best for | Notes |
|---------|----------|-------|
| **llama.cpp** (recommended) | Windows native, single GPU | No virtualisation, direct CUDA, fastest startup |
| **vLLM** (Docker) | Linux, multi-GPU | Continuous batching, tensor/pipeline parallelism |

---

## llama.cpp (Recommended for Windows)

llama.cpp runs natively on Windows with direct GPU access — no Docker, WSL2, or virtualisation layer. It exposes the same OpenAI-compatible `/v1/chat/completions` endpoint, so the indexer config is unchanged.

### Prerequisites

- NVIDIA GPU with CUDA support (tested on RTX 5090, 32 GB VRAM)
- Windows 11 with up-to-date NVIDIA drivers
- Python 3.11+ (for model downloads via `huggingface-hub`)

### Installation

**IMPORTANT: Use the CUDA build, not the default Vulkan build.** The `winget` package installs a Vulkan build that causes `ggml_vulkan: Device memory allocation of size 2147483648 failed` errors on large models, even with sufficient VRAM. The CUDA build uses NVIDIA's native memory allocator which handles large allocations correctly.

```powershell
# Download the CUDA build from llama.cpp releases
# https://github.com/ggml-org/llama.cpp/releases/latest
# Get both: llama-*-bin-win-cuda-12.4-x64.zip and cudart-llama-bin-win-cuda-12.4-x64.zip
# Extract both to the same directory (e.g. .\llama-cpp\cuda-build\)

# Install huggingface-hub for model downloads
pip install huggingface-hub
```

Verify the CUDA build is active — startup output should show `ggml_cuda_init: found 1 CUDA devices` and `loaded CUDA backend`, NOT `loaded Vulkan backend`.

### Available Models (GGUF)

Models are stored in `.\llama-cpp\models\`. Download from HuggingFace using `huggingface-cli download`.

| Model | GGUF Quant | File Size | VRAM (weights) | Max Context (q8_0 KV) | Use Case |
|-------|-----------|-----------|----------------|----------------------|----------|
| Qwen3.5-35B-A3B | Q4_K_M | ~21.4 GB | ~21.4 GB | 64K+ | Largest model, cost-efficient VRAM |
| **Qwen3.5-35B-A3B** | **Q5_K_M** | **~25 GB** | **~25 GB** | **64K** | **Best quality/VRAM balance** |
| Qwen3.5-35B-A3B | Q6_K | ~30 GB | ~30 GB | 16K | Near-lossless, limited context |

**Q5_K_M is recommended** — it's a quality upgrade over GPTQ-Int4 and fits 64K context with q8_0 KV cache on a 32 GB card.

### Downloading a Model

```powershell
# Qwen3.5-35B-A3B Q5_K_M (~25 GB)
huggingface-cli download bartowski/Qwen_Qwen3.5-35B-A3B-GGUF --include "Qwen_Qwen3.5-35B-A3B-Q5_K_M.gguf" --local-dir .\llama-cpp\models
```

If `huggingface-cli` is not on PATH, use the Python module directly:

```powershell
python -m huggingface_hub.cli download bartowski/Qwen_Qwen3.5-35B-A3B-GGUF --include "Qwen_Qwen3.5-35B-A3B-Q5_K_M.gguf" --local-dir .\llama-cpp\models
```

### Starting the Server

```powershell
.\llama-cpp\cuda-build\llama-server.exe `
  -m .\llama-cpp\models\Qwen_Qwen3.5-35B-A3B-Q5_K_M.gguf `
  -ngl 999 `
  -c 65536 `
  -fa on `
  --cache-type-k q8_0 `
  --cache-type-v q8_0 `
  --host 0.0.0.0 `
  --port 8020 `
  --jinja `
  -b 4096 -ub 4096
```

| Flag | Value | Purpose |
|------|-------|---------|
| `-m` | model path | Path to the GGUF model file |
| `-ngl 999` | all layers | Offload all layers to GPU |
| `-c 65536` | 64K | Context window size in tokens |
| `-fa on` | flash attention | Reduces KV cache memory usage |
| `--cache-type-k q8_0` | q8_0 | Quantised KV cache keys (halves memory vs f16) |
| `--cache-type-v q8_0` | q8_0 | Quantised KV cache values (halves memory vs f16) |
| `--host 0.0.0.0` | all interfaces | Accept connections from any interface |
| `--port 8020` | 8020 | Matches existing indexer worker config |
| `--jinja` | enabled | Jinja2 chat templates for Qwen tool call formatting |
| `-b 4096 -ub 4096` | batch sizes | Larger batches for better prompt processing throughput |

### Accessing the Server

| Endpoint | URL |
|----------|-----|
| **OpenAI API base** | `http://localhost:8020/v1` |
| **Chat completions** | `http://localhost:8020/v1/chat/completions` |
| **Models list** | `http://localhost:8020/v1/models` |
| **Web UI** | `http://localhost:8020` |

### Verifying the Server

```powershell
# Check model is loaded
curl http://localhost:8020/v1/models

# Quick test
curl http://localhost:8020/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"qwen3.5","messages":[{"role":"user","content":"Say hello"}],"max_tokens":10}'
```

### VRAM Budget (RTX 5090, 32 GB)

With Q5_K_M weights (~25 GB) and q8_0 KV cache:

| Context | KV Cache (q8_0) | + Weights | Total | Fits? |
|---------|-----------------|-----------|-------|-------|
| 32K | ~2.9 GB | 25 GB | ~27.9 GB | Comfortable |
| 64K | ~5.8 GB | 25 GB | ~30.8 GB | Yes |
| 96K | ~8.7 GB | 25 GB | ~33.7 GB | No — exceeds 32 GB |

### KV Cache Quality Notes

If you see garbled or degraded output, try `--cache-type-k bf16 --cache-type-v bf16` instead of q8_0. Some Qwen3.5 quantisations are sensitive to aggressive KV cache quantisation. For even more VRAM savings (at a quality cost), `q4_0` is available but not recommended for indexing where accuracy matters.

### Troubleshooting (llama.cpp)

| Issue | Fix |
|-------|-----|
| `ggml_vulkan: Device memory allocation of size N failed` | You are using the Vulkan build. Switch to the CUDA build (see Installation above). |
| `llama-server` not found | Download from llama.cpp GitHub releases (CUDA build) or run `winget install ggml.llamacpp` (Vulkan — not recommended) |
| CUDA out of memory | Reduce `-c` (context) or use a smaller quant (Q4_K_M). With Q5_K_M at 64K context, total VRAM is ~30.8 GB — tight on 32 GB cards. |
| Garbled output | Switch KV cache to `bf16` instead of `q8_0` |
| Slow generation | Verify `-ngl 999` is set (CPU fallback is very slow) |
| Port conflict | Stop any running vLLM Docker worker on port 8020 first |
| Extraction truncation (data loss) | Increase `maxOutputTokens` in worker config (32768 recommended). Reduce `maxChunkSize` to 20000 to split dense documents into more chapters. |

---

## vLLM (Docker — Linux / Multi-GPU)

vLLM runs in Docker containers and is better suited for Linux bare-metal or multi-GPU setups with tensor/pipeline parallelism.

### Prerequisites

- NVIDIA GPU with CUDA support
- Docker with NVIDIA Container Toolkit (`nvidia-docker`)
- Docker Compose v2+
- WSL2 (if running on Windows — note: FP8 performance is degraded under WSL2)

### Available Workers

The `docker-compose.yml` defines multiple worker profiles. Each exposes port 8020. **Only run one worker at a time** — they share the GPU.

| Profile | Model | Quantisation | VRAM | Context | Use Case |
|---------|-------|-------------|------|---------|----------|
| `worker-qwen3-4b` | Qwen/Qwen3-4B | None (auto) | ~8 GB | 32K | Fast iteration, low accuracy |
| `worker-qwen3-8b` | Qwen/Qwen3-8B | None (auto) | ~16 GB | 32K | Balanced speed/accuracy |
| `worker-qwen3-14b` | Qwen/Qwen3-14B-AWQ | AWQ (marlin) | ~10 GB | 64K | Best dense model accuracy |
| `worker-qwen35-35b` | Qwen/Qwen3.5-35B-A3B-GPTQ-Int4 | GPTQ (marlin) | ~23 GB | 64K | Largest model, MoE architecture |
| `worker-gemma3-12b` | google/gemma-3-12b-it | None (bfloat16) | ~24 GB | 16K | Top structured extraction benchmark |
| `embeddings` | Qwen/Qwen3-Embedding-8B | FP8 | ~15 GB | 8K | Semantic search embeddings |

### Starting a Worker

```bash
# Start SQL Server (always needed)
docker compose up -d sqlserver

# Start a specific worker
docker compose --profile worker-qwen3-14b up -d

# Check if the model is loaded (returns model list when ready)
curl http://localhost:8020/v1/models

# Stop the worker before starting a different one
docker compose --profile worker-qwen3-14b down
```

Model loading takes 30 seconds to 5 minutes depending on whether weights are cached. First run downloads the model from HuggingFace — this can take 5-20 minutes depending on model size and network speed.

### Model-Specific Configuration Notes

#### Qwen Models (Qwen3-4B, Qwen3-8B)

No special configuration needed. Use `--dtype auto` which selects bfloat16 on supported hardware.

**Thinking mode:** Qwen3 models have a "thinking" mode enabled by default. For structured extraction, disable it via `extraBodyParams` in the indexer config:

```json
"extraBodyParams": {
  "chat_template_kwargs": { "enable_thinking": false }
}
```

#### Qwen3-14B-AWQ (Quantised)

Uses AWQ 4-bit quantisation with the marlin kernel for fast inference. The `--quantization awq_marlin` flag is required.

**dtype must be `float16`** — AWQ quantisation requires float16, not bfloat16 or auto.

#### Qwen3.5-35B-A3B-GPTQ-Int4 (MoE, Quantised)

A Mixture of Experts model: 35B total parameters but only 3B activated per token. Uses GPTQ 4-bit quantisation.

**dtype must be `float16`** — GPTQ quantisation requires float16.

#### Gemma 3 12B (Gated Model)

Gemma 3 is a **gated model** — it requires two extra setup steps before it can be downloaded:

1. **Accept the licence:** Go to [huggingface.co/google/gemma-3-12b-it](https://huggingface.co/google/gemma-3-12b-it) and click "Agree and access repository" while logged in.

2. **Set your HuggingFace token:** Create a token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) with "Read" access. Add it to the `.env` file in the repo root:

   ```
   HF_TOKEN=hf_yourTokenHere
   ```

   Docker Compose reads `.env` automatically and passes the token to the Gemma container. The `.env` file is gitignored.

**dtype must be `bfloat16`** — Gemma 3 does not support float16 due to numerical instability. The docker-compose is already configured for this.

#### Qwen3-Embedding-8B

Used for semantic search, not extraction. Uses FP8 quantisation.

**WSL2 caveat:** FP8 runs slower on WSL2 because Blackwell FP8 tensor cores are not exposed through the WSL driver layer. On bare-metal Linux, FP8 runs at full speed.

### GPU Memory Configuration

All workers are configured with `--gpu-memory-utilization 0.90`. This allocates 90% of VRAM to the model, leaving 10% for CUDA overhead and other processes.

If you see an error like:

```
ValueError: Free memory on device cuda:0 (30.2/31.84 GiB) on startup is less than
desired GPU memory utilization (0.95, 30.25 GiB)
```

This means something else is using GPU memory (display driver, another process). Lower the utilisation value in `docker-compose.yml` or stop other GPU processes.

**Only run one worker at a time.** The workers are configured as Docker Compose profiles so they cannot accidentally start together, but if you manually run multiple containers on port 8020 they will conflict.

### Troubleshooting (vLLM)

#### Model fails to start — check logs

```bash
docker logs deep-memory-worker-qwen3-14b --tail 20
```

#### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `is not a valid model identifier listed on huggingface.co` | Model name is wrong or doesn't exist | Check the exact model ID on huggingface.co |
| `Cannot access gated repo` | Gated model without authentication | Set `HF_TOKEN` in `.env` and accept the model licence on HuggingFace |
| `does not support float16. Reason: Numerical instability` | Model requires bfloat16 | Change `--dtype` to `bfloat16` in docker-compose.yml |
| `Free memory on device cuda:0 ... is less than desired` | Not enough free VRAM | Lower `--gpu-memory-utilization` or stop other GPU processes |
| `CUDA error: no kernel image is available` | vLLM image doesn't support your GPU architecture | Update to latest `vllm/vllm-openai` image |
| `Unterminated string in JSON` (during extraction) | Model ran out of output tokens | Increase `maxOutputTokens` in indexer config |

#### Verifying a Worker is Ready

```bash
# Returns model info when ready, connection refused while loading
curl http://localhost:8020/v1/models

# Quick test — should return a JSON response
curl http://localhost:8020/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "Qwen/Qwen3-4B", "messages": [{"role": "user", "content": "Say hello"}], "max_tokens": 10}'
```

#### Checking Download Progress

On first run, models download from HuggingFace into the `huggingface_cache` Docker volume. Monitor progress:

```bash
docker logs -f deep-memory-worker-qwen3-14b
```

Look for download progress bars. Once download completes, the model loads into GPU memory and compiles CUDA kernels (another 30-120 seconds).

### Adding a New Model (vLLM)

To add a new model to the docker-compose:

1. **Find the model on HuggingFace.** Note the exact model ID (e.g., `Qwen/Qwen3-14B-AWQ`).

2. **Check if it's gated.** If the model page shows "You need to agree to share your contact information" or similar, you'll need HF_TOKEN authentication (see Gemma 3 section above).

3. **Determine the correct dtype:**
   - Most models: `auto` (lets vLLM choose)
   - AWQ/GPTQ quantised models: `float16`
   - Models that reject float16 (e.g., Gemma): `bfloat16`

4. **Determine quantisation flag:**
   - No quantisation needed: omit the `--quantization` flag
   - AWQ models (name contains `-AWQ`): `--quantization awq_marlin`
   - GPTQ models (name contains `-GPTQ`): `--quantization gptq_marlin`
   - FP8 models (name contains `-FP8`): `--quantization fp8`

5. **Estimate VRAM and set context window:**
   - Check model card for weight size
   - Subtract from available VRAM (at 0.90 utilisation) to determine KV cache budget
   - Larger KV cache = longer context window
   - Start with `--max-model-len 32768` and reduce if OOM

6. **Add the service to docker-compose.yml** following the existing pattern. Use a unique profile name and the shared port 8020.

7. **Test by starting the container** and checking `curl http://localhost:8020/v1/models`.
