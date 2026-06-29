# ConversaAI Platform

A scalable, secure multi-microservice AI platform: **chat + translation + voice
(STT/TTS)**, fronted by an API gateway that manages access with API keys. Built so
one gateway key unlocks every feature, and the model/engines stay private behind it.

> Detailed docs: **[ARCHITECTURE.md](ARCHITECTURE.md)** ·
> **[BACKEND_GUIDE.md](BACKEND_GUIDE.md)** · **[FRONTEND_GUIDE.md](FRONTEND_GUIDE.md)**

---

## Services (microservices)

| # | Service | Repo / path | Port | Role |
|---|---|---|---|---|
| 1 | **Frontend** | `chatbot/` (index.html, app.js) | — | Chat / translate / live-voice UI |
| 2 | **Gateway** | `voice-gateway_1/` | 8001 | Auth (API key), rate-limit, proxy, chat history, async voice jobs — **owns the DB** |
| 3 | **LLM service** | `chatbot/server/` | 8008 | Chat, translate (LLM + free Google), **Edge/Bing TTS**, STT proxy |
| 4 | **vLLM (model)** | GPU host (`server/gpu_setup.sh`) | 8007 | Llama 3.1 8B — OpenAI-compatible |
| 5 | **STT engine** | `kdext_conversa_ai_stt/` (Desktop) | 8002 | faster-whisper large-v3 · `POST /v1/stt` |
| 6 | **TTS engine** | `kdext_conversa_ai_tts/` (home dir) | 8000 | Indic-Parler / Bark · `POST /v1/tts` |
| 7 | **Voice worker** | `voice-worker/` | 8006 | SQS consumer: async TTS/STT → S3 → DB → webhook |

Shared infra: **Postgres (RDS)** · **S3** (audio) · **SQS** (async queues).
The **only database is the gateway's Postgres**; every other service is stateless.

---

## Architecture

```
                       Internet (HTTPS) ── only the gateway is public
                                 │  X-API-Key (per user)
                    ┌────────────▼─────────────┐
                    │   Gateway :8001 (N pods)  │ auth · rate-limit · proxy · history
                    └─┬──────────┬───────────┬──┘
         X-Service-Key│          │ SQL(pool) │ enqueue
                      ▼          ▼           ▼
        ┌─────────────────┐  ┌────────┐   ┌─────┐    ┌──────────────┐
        │ LLM service:8008│  │Postgres│   │ SQS │───▶│ Voice worker │──▶ S3
        │ (N pods)        │  │  RDS   │   └─────┘    └──────┬───────┘
        └─┬──────┬────────┘  └────────┘                    │
  VLLM key│      │ Edge TTS (built-in)             ┌────────┴────────┐
     ┌────▼────┐ └─────────────────────────────────▶ STT:8002  TTS:8000
     │vLLM:8007│   (LLM service also calls STT)     (whisper) (parler/bark)
     └─────────┘
```

**Two voice paths by design:**
- **Real-time (live chatbot):** frontend → gateway → LLM service → vLLM + **Edge TTS** + STT:8002. Streaming, low latency.
- **Managed/async API:** client → gateway `/text-to-speech` `/speech-to-text` → SQS → worker → **TTS:8000 / STT:8002** → S3 + DB + webhook.

---

## Database (gateway Postgres — single source of truth)

8 tables, owned by Alembic migrations (`alembic upgrade head`):

`users` · `conversations` · `chat_messages` · `text_to_speech` ·
`speech_to_text` · `otp_verifications` · `rate_limits` · `error_logs`

The worker shares these tables (ORM kept identical to the gateway — verified).
STT/TTS/vLLM/LLM services never touch the DB. Full column list in
[ARCHITECTURE.md](ARCHITECTURE.md#final-database-schema-gateway-postgres--the-single-source-of-truth).

---

## Security (defense in depth)

1. **Edge:** TLS; only the gateway is public.
2. **User key** (`X-API-Key`) — one key = all features, per user, rate-limited, revocable.
3. **Service key** (`X-Service-Key`) — gateway→LLM; direct `:8008` hit → 401.
4. **Model key** — `vllm serve --api-key` + `VLLM_API_KEY`.
5. **Network** — firewall each port to the caller in front (`8007`←LLM, `8008`←gateway, `8000/8002`←LLM+worker); engines have no public IP.

---

## Scalability ✅

- **Stateless replicas** for gateway, LLM service, and worker → scale horizontally.
- **Connection pooling:** gateway→LLM shared `httpx` client (200 conns/worker);
  gateway→DB `QueuePool` (`DB_POOL_SIZE`/`DB_MAX_OVERFLOW`/`pool_recycle`).
- **End-to-end streaming** (SSE chat, MP3 TTS) → fast first byte, flat memory.
- **GPU tiers scale by replicas** behind balancers (`VLLM_BASE_URL`, `*_ENGINE_URL`).
- **Async offload** via SQS + worker pods (`USE_ASYNC_QUEUE`); worker processes
  each batch concurrently with SQS retries + DLQ.
- **DB:** add a read replica for history/listing reads.

Scale order: GPU engines → LLM/worker pods → gateway pods → Postgres.

---

## Quick start (local)

```bash
# 1. Model (GPU host)
./chatbot/server/gpu_setup.sh && ./start_server.sh          # vLLM :8007

# 2. STT + TTS engines
cd kdext_conversa_ai_stt && python run.py                   # :8002
cd kdext_conversa_ai_tts && python run.py                   # :8000

# 3. LLM service
cd chatbot && pip install -r server/requirements.txt
uvicorn server.main:app --port 8008                         # :8008

# 4. Gateway
cd voice-gateway_1 && alembic upgrade head
uvicorn app.main:app --port 8001                            # :8001
```

Verify:
```bash
curl http://localhost:8008/api/engine-health                # llm/tts/stt all ok
curl -X POST http://localhost:8001/api/chat \
  -H "X-API-Key: <key>" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

See **[BACKEND_GUIDE.md](BACKEND_GUIDE.md)** for full deploy (DB, secrets, firewalling)
and **[FRONTEND_GUIDE.md](FRONTEND_GUIDE.md)** for client integration.

---

## Features
- Streaming SSE chat · translation (AI model **or** free Google API toggle)
- Live hands-free voice (STT → LLM → TTS) with barge-in and sentence-streaming
- Neural TTS (Edge/Bing multilingual + Indic-Parler/Bark) · Whisper STT
- Server-side chat history · OpenAI-compatible `/v1/*` surface · per-user metering
