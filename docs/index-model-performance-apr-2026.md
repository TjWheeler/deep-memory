# Local Model Performance Research — April 2026

Research into optimal local LLM models for structured JSON extraction on RTX 5090 (32GB VRAM) via vLLM. Priority: accuracy over speed, targeting Claude Haiku 4.5 quality.

---

## RTX 5090 + vLLM Platform Notes

**Critical requirements:**
- CUDA 12.8+, PyTorch 2.6+
- Use `VLLM_FLASH_ATTN_VERSION=2` (Flash Attention 3 does not yet work on Blackwell/sm_120)
- Set `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`
- FlashInfer attention backend gives ~8% improvement: `--attention-backend flashinfer`
- CUDA graphs are essential: enforce-eager mode is 8x slower

**WSL2 caveat:** FP8 quantization runs ~3x slower on WSL2 because Blackwell's FP8 tensor cores are not exposed through dxgkrnl yet. Stick with GPTQ or AWQ on WSL2.

**Best quantization on RTX 5090 (WSL2):**
- **GPTQ (marlin kernel)**: 8-19% faster than AWQ in vLLM 0.11-0.17
- **AWQ (marlin kernel)**: Very close to GPTQ, better ecosystem of pre-quantized models
- **NVFP4**: Supported on Blackwell for MoE and dense models, smallest footprint
- **FP8**: Avoid on WSL2; use on bare-metal Linux only

---

## Model Candidates — Summary Table

| Model | Quant | Weight VRAM | Max Context | Speed (tok/s) | Extraction Quality |
|-------|-------|-------------|-------------|---------------|--------------------|
| Qwen3.5-35B-A3B | AWQ 4-bit | ~22 GB | ~92K | ~200 | Very Good |
| Qwen3-30B-A3B | AWQ 4-bit | ~20 GB | ~114K | ~260 | Very Good |
| Qwen3-14B | GPTQ 4-bit | ~8 GB | 16-32K | ~75 | Excellent |
| Qwen3-14B | FP16 | ~28 GB | 4-8K | ~50 | Excellent |
| Qwen3-8B | FP16 | ~16 GB | 32K+ | ~100 | Good |
| Qwen3-8B | GPTQ 4-bit | ~5 GB | 64K+ | ~82 | Good |
| Gemma 3 12B | FP16 | ~24 GB | 8-16K | ~110 | Excellent (top benchmark) |
| Gemma 3 27B | INT4 | ~14 GB | 4-8K | ~60 | Very Good |
| Phi-4 14B | INT4 | ~8 GB | 16K | ~80 | Good |
| Mistral Small 24B | INT4 | ~14 GB | 8-16K | ~70 | Good (JSON issues reported) |
| DeepSeek-R1-14B | GPTQ 4-bit | ~8 GB | 16K | ~70 | Good |
| Llama 3.3 70B | INT4 | ~35 GB | **DNF** | -- | Does not fit |

---

## Detailed Model Analysis

### Tier 1: Best Accuracy (Recommended for Testing)

#### Qwen3-14B (GPTQ 4-bit) — TOP PICK for Dense Model

- 14B dense parameters, GPTQ 4-bit quantization with marlin kernel
- ~8 GB weights, leaving plenty for KV cache on 32GB card
- Context window: 16-32K comfortably at 0.95 GPU utilization
- ~75 tok/s on RTX 5090 (WSL2)
- Qwen3 family excels at tool calling and JSON output
- Best dense accuracy-per-VRAM ratio
- Weakness: dense model = all 14B params active per token, context limited vs MoE

#### Qwen3.5-35B-A3B (AWQ 4-bit) — TOP PICK for Maximum Capability

- 35B total, 3B activated per token (MoE architecture)
- ~22-24 GB weights, ~26.5 GB at 0.83 utilization
- Context window: up to 92K tokens on 32GB (of 128K max)
- ~200 tok/s on RTX 5090 — fast due to MoE sparsity
- 40% lower KV-cache overhead (Gated DeltaNet architecture)
- Outperforms QwQ-32B despite 10x fewer active params
- Weakness: MoE can be less consistent than dense on edge cases, newer model

#### Gemma 3 12B (FP16, no quantization needed)

- 12B dense, runs unquantized at ~24 GB FP16
- Context window: 8-16K at FP16; up to 32K at INT8
- ~110 tok/s estimated
- **#1 on LLMStructBench** (F1_micro 0.95) — eclipses several 70B models for structured extraction
- Google's extensive instruction tuning
- Weakness: smaller knowledge base than 14B+, may struggle with highly domain-specific vocabulary

### Tier 2: Strong Alternatives

#### Qwen3-8B (GPTQ 4-bit or FP16)

- 8B dense, step up from 4B currently in use
- FP16 fits at ~16 GB, GPTQ 4-bit at ~5 GB (huge context possible)
- Good structured extraction, but less capable than 14B for complex schemas
- Best option if context window is the primary constraint

#### Qwen3-30B-A3B (AWQ 4-bit) — Previous Generation MoE

- 30B total, 3B activated (MoE), superseded by 35B variant
- ~20-22 GB weights, up to 114K context
- ~260 tok/s single request, ~1,157 tok/s batched
- Strong tool calling, outperforms QwQ-32B
- Well-tested on RTX 5090

#### Phi-4 14B (INT4)

- 14B dense, INT4 at ~8 GB
- 16K native context
- LLMStructBench: F1_micro 0.94, DOC_micro 0.38
- Strong reasoning from Microsoft's data curation
- Slightly behind Qwen3 for extraction benchmarks

### Does Not Fit / Not Recommended

- **Llama 3.3 70B**: ~35 GB weights at INT4, exceeds 32GB
- **Mistral Small 24B**: Reports of structured output issues with guided decoding in vLLM
- **DeepSeek-R1-14B**: R1 models are verbose (thinking tokens), may need prompting to suppress CoT

---

## Structured Extraction Benchmarks (LLMStructBench, Feb 2026)

| Model | F1_micro | DOC_micro | Combined |
|-------|----------|-----------|----------|
| Gemma 3 12B | 0.95 | 0.49 | 0.72 |
| Qwen3 1.7B | 0.94 | 0.40 | 0.67 |
| DeepSeek-R1 7B | 0.94 | 0.39 | 0.67 |
| Phi-4-mini 3.8B | 0.95 | 0.38 | 0.66 |
| Phi-3 14B | 0.94 | 0.38 | 0.66 |

Key insight: "Choosing the right prompting strategy is more important than model size" for structured extraction.

---

## Recommended vLLM Launch Configurations

### Qwen3-14B-GPTQ

```bash
python3 -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen3-14B-GPTQ-Int4 \
  --quantization gptq_marlin \
  --dtype float16 \
  --gpu-memory-utilization 0.95 \
  --max-model-len 32768 \
  --max-num-batched-tokens 32768 \
  --swap-space 4
```

### Qwen3.5-35B-A3B-AWQ

```bash
python3 -m vllm.entrypoints.openai.api_server \
  --model cyankiwi/Qwen3.5-35B-A3B-AWQ-4bit \
  --quantization compressed-tensors \
  --dtype float16 \
  --gpu-memory-utilization 0.83 \
  --max-model-len 131072 \
  --max-num-seqs 2 \
  --kv-cache-dtype fp8
```

### Gemma 3 12B (FP16)

```bash
python3 -m vllm.entrypoints.openai.api_server \
  --model google/gemma-3-12b-it \
  --dtype float16 \
  --gpu-memory-utilization 0.95 \
  --max-model-len 16384
```

---

## Sources

- [RTX 5090 + WSL2 vLLM Benchmarks (GitHub Issue #37242)](https://github.com/vllm-project/vllm/issues/37242)
- [Benchmarking Qwen3 AWQ vs GPTQ on RTX 5090](https://zenn.dev/toki_mwc/articles/ed9ad65bca8691)
- [Optimizing Qwen3 Coder for RTX 5090 (CloudRift)](https://www.cloudrift.ai/blog/optimizing-qwen3-coder-rtx5090-pro6000)
- [Running Qwen3.5-35B on RTX 5090 (Joshua8.AI)](https://joshua8.ai/qwen35-35b-rtx-5090-vllm-practical-guide/)
- [vLLM v0.16.0 Blackwell Throughput Benchmark](https://joshua8.ai/vllm-v016-blackwell-throughput-benchmark/)
- [vLLM-5090 Docker Container (GitHub)](https://github.com/BoltzmannEntropy/vLLM-5090)
- [LLMStructBench (arXiv)](https://arxiv.org/html/2602.14743v1)
- [StructEval (arXiv)](https://arxiv.org/html/2505.20139v1)
- [Qwen3 Official Blog](https://qwenlm.github.io/blog/qwen3/)
- [VRAM Cheat Sheet for Local LLMs (InsiderLLM)](https://insiderllm.com/guides/vram-requirements-local-llms/)
