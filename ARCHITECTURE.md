# Architecture — Final (Scalable & Secure)

Complete topology of every microservice, the request flows, and the single
authoritative database schema.

## Services inventory

| # | Service | Repo / path | Port | Role | DB? |
|---|---|---|---|---|---|
| 1 | **Frontend** | `chatbot/` (static: index.html, app.js) | — | Chat/translate/voice UI | no |
| 2 | **Gateway** | `voice-gateway_1/` | 8001 | Auth (API key), rate-limit, proxy, chat history, native voice jobs | **owns DB** |
| 3 | **LLM service** | `chatbot/server/` | 8008 | Chat, translate (LLM + free Google), **Edge/Bing TTS**, STT proxy | no |
| 4 | **vLLM (model)** | GPU host (`gpu_setup.sh`) | 8007 | Llama 3.1 — OpenAI-compatible | no |
| 5 | **STT engine** | `kdext_conversa_ai_stt/` | 8002 | faster-whisper large-v3, `POST /v1/stt` | no |
| 6 | **TTS engine** | `kdext_conversa_ai_tts/` | 8000 | Indic-Parler / Bark, `POST /v1/tts` | no |
| 7 | **Voice worker** | `voice-worker/` | 8006 (health) | SQS consumer: async TTS/STT → S3 → DB → webhook | same DB |

Shared infra: **Postgres (RDS)** · **S3** (audio) · **SQS** (async job queues).
Only services 2 and 4–6 are *stateful by model*; the **only database is the
gateway's Postgres** — every other service is stateless.

## Topology

```
                               Internet (HTTPS only)
                                       │
                              ┌────────▼─────────┐
                              │ TLS / Load Balancer│   ← the ONLY public entry
                              └────────┬─────────┘
                                       │ X-API-Key (per user)
                        ┌──────────────▼───────────────┐
                        │ Gateway :8001 (N replicas)    │ auth·rate-limit·proxy·history
                        └─┬───────────┬──────────────┬──┘
              X-Service-Key│           │ SQL(pooled)  │ enqueue (async voice)
                          │           ▼              ▼
              ┌───────────▼──────┐ ┌────────┐   ┌─────────┐    ┌──────────────┐
              │ LLM service :8008│ │Postgres│   │   SQS   │───▶│ Voice worker │
              │ (N replicas)     │ │  RDS   │   └─────────┘    │ (N replicas) │
              └─┬────────┬───────┘ └────────┘                  └───┬─────┬────┘
     VLLM_API_KEY│        │ (Edge TTS built-in)                    │     │
          ┌──────▼────┐   │                                  S3 ◀──┘     │
          │vLLM :8007 │   ├───────────────┬──────────────────────────────┤
          │ (GPU pool)│   ▼               ▼                              ▼
          └───────────┘ STT :8002      TTS :8000  (Indic-Parler/Bark) ── used by
                        (whisper)      (used by gateway-native + worker) gateway+worker
```

Everything except the load balancer lives on a **private network**; each tier
accepts traffic only from the tier in front of it.

---

## Two voice paths (by design)

**A. Real-time (chatbot / live voice)** — lowest latency, streaming, no job rows:
```
frontend → gateway → LLM service ──▶ vLLM            (chat, streamed)
                                 ├──▶ Edge/Bing TTS   (built-in, MP3 stream)
                                 └──▶ STT engine:8002 (transcribe)
```

**B. Managed / async API (the product)** — durable, webhook-notified:
```
client → gateway /text-to-speech | /speech-to-text → SQS → voice-worker
         → TTS:8000 / STT:8002 → S3 (audio) → Postgres (job row) → webhook
```

> Two TTS engines exist on purpose: **Edge/Bing** (inside the LLM service, for the
> live chatbot) and **Indic-Parler/Bark** (`:8000`, for the gateway-native +
> worker API jobs). STT is one engine (`:8002`) shared by both paths.

---

## API surface (all endpoints)

### Gateway `:8001` (public)
| Group | Endpoint | Auth |
|---|---|---|
| Account | `POST /signup` · `POST /verify-otp` · `POST /login` · `GET /profile` | OTP / JWT |
| Model (proxy → LLM) | `POST /api/chat` · `POST /api/translate` · `POST /api/voice/tts` · `POST /api/voice/stt` · `GET /api/models` · `GET /api/engine-health` · `GET /api/health` | `X-API-Key` |
| OpenAI surface | `GET /v1/models` · `POST /v1/chat/completions` | `X-API-Key` |
| Chat history | `POST/GET /conversations` · `GET/PATCH/DELETE /conversations/{id}` · `POST /conversations/{id}/messages` | `X-API-Key` |
| Native voice jobs | `POST /text-to-speech` · `POST /speech-to-text` · `GET /jobs/{id}` · `GET /voices` | `X-API-Key` |
| Demo (optional) | `GET /demo` · `POST /demo/tts` · `POST /demo/stt` · `GET /demo/voices` | none (`DISABLE_DEMO=true` to remove) |
| Ops | `GET /health` · `GET /ready` · `GET /docs` | none |

### LLM service `:8008` (private; `X-Service-Key` when set)
`POST /api/chat` (SSE/JSON) · `POST /api/translate` (`engine` llm\|api) ·
`POST /api/voice/tts` (form → MP3) · `POST /api/voice/stt` (multipart → `{text}`) ·
`GET /api/health` (open) · `GET /api/models` · `GET /api/engine-health` ·
`GET /v1/models` · `POST /v1/chat/completions`

### Engines (private)
| Engine | Endpoint | Request → Response |
|---|---|---|
| STT `:8002` | `POST /v1/stt` · `GET /health` | multipart `file,language?` → `{text, language, words[]}` |
| TTS `:8000` | `POST /v1/tts` · `GET /health` | JSON `{text, language, voice?, speech_id?}` → audio bytes |
| vLLM `:8007` | `POST /v1/chat/completions` · `GET /v1/models` | OpenAI format |
| Worker `:8006` | `GET /health` | TCP liveness |

## Credentials & headers (per hop)

| Hop | Credential | Header |
|---|---|---|
| client → gateway (model + history + jobs) | per-user API key | `X-API-Key` |
| client → gateway (account: profile, etc.) | login JWT | `Authorization: Bearer` |
| gateway → LLM service | shared service key | `X-Service-Key` |
| LLM service → vLLM | model key | `Authorization: Bearer` |
| gateway/worker → STT/TTS engines | none (network-isolated) | — |

The gateway **strips** any client-sent `X-API-Key`/`X-Service-Key` before
forwarding, and injects the authoritative `X-Service-Key` itself.

---

## Final database schema (gateway Postgres — the single source of truth)

8 tables. Created via `alembic upgrade head` (`schema.sql` mirrors them).

```
users ──┬──< conversations ──< chat_messages
        ├──< text_to_speech        (TTS jobs)
        ├──< speech_to_text        (STT jobs)
        ├──< otp_verifications
        ├──< rate_limits
        └──< error_logs (user_id nullable)
```

| Table | Key columns |
|---|---|
| **users** | user_id PK · email · **api_key** · password · is_verified · total_processing · total_failed · login_time · signout_time · created_at |
| **conversations** | conversation_id PK · user_id FK · title · mode(chat\|translate) · created_at · updated_at |
| **chat_messages** | message_id PK · conversation_id FK · user_id · role · content · source_lang · target_lang · engine · created_at |
| **text_to_speech** | request_id PK · user_id FK · input_text · audio_url · audio_bytes · voice · format · language · model_used · status · queue_position · processing_time · error_message · webhook_url · webhook_sent_at · created_at · completed_at |
| **speech_to_text** | request_id PK · user_id FK · audio_url · audio_bytes · input_format · transcript · language_hint · detected_language · segments(JSON) · status · queue_position · processing_time · error_message · webhook_url · webhook_sent_at · created_at · completed_at |
| **otp_verifications** | id PK · user_id FK · otp_code · purpose · is_used · expires_at · created_at |
| **rate_limits** | id PK · user_id FK · endpoint · window_minute · window_day · rpm_count · rpd_count · created_at · updated_at |
| **error_logs** | id PK · user_id FK(null) · endpoint · method · error_type · status_code · error_message · created_at |

**Ownership:** the gateway and the voice-worker share these tables; the worker's
ORM models are kept identical to the gateway's (verified). STT/TTS/vLLM/LLM
services never touch the DB. Migrations are owned by Alembic
(`CREATE_DB_TABLES=false` in prod); snapshot RDS before `alembic upgrade head`.

---

## Security — layered (defense in depth)

| Layer | Control |
|---|---|
| Edge | TLS/HTTPS; only the gateway is public |
| Identity | per-user `X-API-Key` → `users`; one key = all features |
| Abuse | per-user RPM/RPD rate limits (`LLM_RATE_LIMIT_ENABLED`, `rate_limits`) |
| Service auth | `X-Service-Key` gateway→LLM; direct `:8008` hit → 401 |
| Model auth | `vllm serve --api-key` + `VLLM_API_KEY` |
| Engine isolation | STT/TTS bound to private net; reachable only from LLM service / worker |
| Network | firewall/SG per port: `8007`←LLM, `8008`←gateway, `8000/8002`←LLM+worker |
| Header hygiene | gateway strips client `x-api-key`/`x-service-key` before forwarding |
| Data | secrets in env/Secrets Manager; rotate; S3 private + presigned (recommend) |
| Observability | all errors → `error_logs`; per-user usage counters on `users` |

A leaked internal IP is useless without the service/model key **and** a firewall
exception. A leaked user key is per-user, rate-limited, and revocable.

---

## Scalability — how each tier grows

- **Stateless replicas** for gateway, LLM service, and worker → scale horizontally
  behind the LB / by SQS fan-out. No sticky sessions.
- **Pooling:** gateway→LLM shared `httpx` client (200 conns/worker); gateway→DB
  `QueuePool` (`DB_POOL_SIZE`/`DB_MAX_OVERFLOW`/`pool_recycle`).
- **Streaming end-to-end** (SSE chat, MP3 TTS) → fast first byte, flat memory.
- **GPU tiers are the bottleneck:** run **multiple vLLM, STT, and TTS replicas**
  behind balancers; point `VLLM_BASE_URL`/`*_ENGINE_URL` at the balancer.
- **Async offload:** heavy TTS/STT go through SQS + worker pods (`USE_ASYNC_QUEUE`)
  so request pods never block; results land in S3. Worker processes each SQS batch
  concurrently (`WORKER_MAX_CONCURRENT`), with retries via SQS visibility timeout
  and a DLQ after `sqs_max_receive_count`.
- **Database:** single RDS now; add a read replica for history/listing reads.

### Scale in this order
1. vLLM / STT / TTS GPU replicas (throughput bottleneck).
2. LLM service + worker pods.
3. Gateway pods (cheap, stateless).
4. Postgres (read replica, bigger instance).

---

## Environment variables (per service)

| Service | Key vars |
|---|---|
| **Gateway** | `DATABASE_URL` · `JWT_SECRET` · `ALLOWED_ORIGINS` · `LLM_SERVICE_URL` · `LLM_SERVICE_API_KEY` · `LLM_REQUIRE_API_KEY` · `LLM_RATE_LIMIT_ENABLED` · `DB_POOL_SIZE`/`DB_MAX_OVERFLOW`/`DB_POOL_RECYCLE` · `USE_S3_STORAGE`+`AWS_*` · `USE_ASYNC_QUEUE`+`AWS_SQS_*` · `SMTP_*` · `CREATE_DB_TABLES=false` · `ENVIRONMENT=production` |
| **LLM service** | `VLLM_BASE_URL` · `VLLM_API_KEY` · `VLLM_MODEL` · `VLLM_TIMEOUT` · `SERVICE_API_KEY` · `STT_ENGINE_URL`/`STT_ENGINE_PATH` · `TTS_ENGINE_URL` · `ENGINE_TIMEOUT` · `ALLOWED_ORIGINS` · `PORT=8008` |
| **Voice worker** | `DATABASE_URL` (same as gateway) · `AWS_*` (S3) · `AWS_SQS_TTS_QUEUE_URL`/`AWS_SQS_STT_QUEUE_URL` · `TTS_ENGINE_URL` · `STT_ENGINE_URL` · `WORKER_MAX_CONCURRENT` · `SQS_VISIBILITY_TIMEOUT`/`SQS_WAIT_TIME_SECONDS`/`SQS_MAX_RECEIVE_COUNT` |
| **STT engine** | `PORT=8002` · `MAX_FILE_SIZE_BYTES` · Whisper model/compute settings |
| **TTS engine** | `PORT=8000` · `MAX_TEXT_CHARS` · model/dtype settings |
| **vLLM** | `--api-key` (= LLM service's `VLLM_API_KEY`) · `HF_TOKEN` |

**Matched pairs (must be equal):** `LLM_SERVICE_API_KEY` (gateway) = `SERVICE_API_KEY`
(LLM); `VLLM_API_KEY` (LLM) = vLLM `--api-key`; `DATABASE_URL` identical on gateway
and worker; `AWS_SQS_*`/`AWS_S3_*` shared by gateway and worker.

---

## Reliability
- Health: gateway `GET /health` + `GET /ready` (DB); LLM `GET /api/engine-health`;
  worker health TCP on `:8006`; engines `GET /health`.
- Graceful: gateway 502 if LLM down; LLM retries Edge TTS then browser fallback;
  failed SQS jobs retry then DLQ.
- Timeouts bound every hop (`LLM_SERVICE_TIMEOUT`, `VLLM_TIMEOUT`, `ENGINE_TIMEOUT`,
  `engine_timeout_seconds`).

See `BACKEND_GUIDE.md` (deploy) and `FRONTEND_GUIDE.md` (client usage).
