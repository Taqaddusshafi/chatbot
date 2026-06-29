# Backend / Deployment Guide

Covers the three backend tiers and how they connect:

```
        ┌──────────────┐   X-API-Key   ┌─────────────────┐   HTTP    ┌────────────────────┐
client ▶│ Voice Gateway│──────────────▶│  LLM service     │──────────▶│  vLLM (the model)  │
        │  (:8001)     │   proxy /api  │  (chatbot :8008) │  OpenAI   │  GPU :8007         │
        │  auth + DB   │               │  chat/translate/ │  format   └────────────────────┘
        └──────┬───────┘               │  voice tts+stt   │──┐  Edge/Bing TTS (Microsoft, no infra)
               │ Postgres              └─────────────────┘   └▶ Google translate (free, no key)
               ▼                                              └▶ STT engine (:8002)
        conversations, users, …
```

There are **3 things to deploy**: (1) the model on a GPU via vLLM, (2) the LLM
service (this repo's `server/`), (3) point the gateway at it. The gateway itself
is already running.

---

## Tier 1 — The model (vLLM on GPU)

Serves the LLM in OpenAI-compatible format. Run on a CUDA GPU (e.g. L40 48 GB).

```bash
export HF_TOKEN=your_hf_token        # needs Llama 3.1 access approved
./server/gpu_setup.sh                # installs vLLM, writes start_server.sh

# start (OpenAI-compatible server on :8007):
vllm serve meta-llama/Llama-3.1-8B-Instruct \
  --host 0.0.0.0 --port 8007 \
  --gpu-memory-utilization 0.9 --max-model-len 8192 --dtype auto
```

Verify: `curl http://GPU_HOST:8007/v1/models` → lists the model.
This URL becomes `VLLM_BASE_URL` for Tier 2.

---

## Tier 2 — The LLM service (this repo, `server/`)

FastAPI app `server.main:app`. Talks to the model, does **Edge/Bing TTS** and
**translation (LLM + free Google API)**, proxies the **STT engine**.

### 2a. Install

```bash
cd chatbot
python3 -m venv .venv && source .venv/bin/activate
pip install -r server/requirements.txt
# (fastapi, uvicorn, httpx, pydantic-settings, sse-starlette, edge-tts)
```

### 2b. Configure — `server/.env`

```ini
HOST=0.0.0.0
PORT=8008

# The model (Tier 1) — OpenAI-compatible vLLM endpoint
VLLM_BASE_URL=http://GPU_HOST:8007/v1
VLLM_API_KEY=EMPTY
VLLM_MODEL=meta-llama/Llama-3.1-8B-Instruct
VLLM_TIMEOUT=120

# Generation defaults
DEFAULT_TEMPERATURE=0.7
DEFAULT_MAX_TOKENS=2048
DEFAULT_TOP_P=0.9

# STT engine (Whisper-style). TTS uses Edge/Bing (no URL needed).
STT_ENGINE_URL=http://185.14.252.20:8002
STT_ENGINE_PATH=/v1/stt
TTS_ENGINE_URL=http://185.14.252.20:8000   # only used by /api/engine-health
ENGINE_TIMEOUT=60

# Allow the gateway (and any direct callers) through CORS
ALLOWED_ORIGINS=*
```

**What needs no setup:**
- **Edge/Bing TTS** — the `edge-tts` library calls Microsoft directly; no server, no key.
- **Google translation** — `engine="api"` hits the free `translate.googleapis.com`
  endpoint over `httpx`; no key.
- **LLM translation** — `engine="llm"` (default) goes through vLLM.

### 2c. Run

```bash
# dev
uvicorn server.main:app --host 0.0.0.0 --port 8008

# production (multiple workers)
pip install gunicorn
gunicorn server.main:app -k uvicorn.workers.UvicornWorker \
  -w 4 -b 0.0.0.0:8008 --timeout 180
```

systemd unit (`/etc/systemd/system/llm-service.service`):

```ini
[Unit]
Description=Chatbot LLM service
After=network.target
[Service]
WorkingDirectory=/opt/chatbot
EnvironmentFile=/opt/chatbot/server/.env
ExecStart=/opt/chatbot/.venv/bin/gunicorn server.main:app \
  -k uvicorn.workers.UvicornWorker -w 4 -b 0.0.0.0:8008 --timeout 180
Restart=always
[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now llm-service`

Docker:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn
COPY . .
EXPOSE 8008
CMD ["gunicorn","server.main:app","-k","uvicorn.workers.UvicornWorker","-w","4","-b","0.0.0.0:8008","--timeout","180"]
```

### 2d. Verify

```bash
curl http://localhost:8008/api/engine-health        # {llm,tts,stt} all "ok"
curl -X POST http://localhost:8008/api/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":false}'
curl -X POST http://localhost:8008/api/translate -H 'Content-Type: application/json' \
  -d '{"text":"good morning","target_lang":"ar","engine":"api"}'
```

---

## Tier 3 — Connect the gateway to the LLM service

The gateway reverse-proxies `/api/*` and `/v1/*` to the LLM service and adds
API-key management. In the **gateway** repo's `.env`:

```ini
LLM_SERVICE_URL=http://LLM_HOST:8008     # where Tier 2 runs
LLM_SERVICE_TIMEOUT=120
LLM_REQUIRE_API_KEY=true                 # external users need an X-API-Key
```

### Apply DB migrations (chat history tables)
Production runs with `CREATE_DB_TABLES=false`, so create the new tables on RDS:

```bash
cd voice-gateway_1 && alembic upgrade head
# creates: conversations, chat_messages
```

### Issue API keys
Users sign up on the gateway (`POST /signup` → `/verify-otp`); each `users` row has
an `api_key`. Hand that key to the client; it sends it as `X-API-Key`.

### Verify end-to-end (through the gateway)
```bash
curl -X POST https://GATEWAY_HOST:8001/api/chat \
  -H "X-API-Key: <user_key>" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":false}'
```

---

## Database setup (PostgreSQL / Amazon RDS)

Only the **gateway** touches the database — the LLM service and vLLM are DB-less.
The DB stores users/API keys, chat history, TTS/STT job records, OTP, rate limits,
and error logs.

### 1. Provision Postgres
- **Local/dev:** any Postgres 14+, or SQLite for quick tests (`DATABASE_URL=sqlite:///./voice_gateway.db`).
- **Production:** Amazon RDS Postgres (the project already uses one in
  `ap-southeast-2`). Put it in a private subnet; allow inbound `5432` **only** from
  the gateway's security group.

### 2. Create the database & role (run as superuser once)
```sql
CREATE ROLE voicegw WITH LOGIN PASSWORD 'a-strong-password';
CREATE DATABASE voice_gateway OWNER voicegw;
GRANT ALL PRIVILEGES ON DATABASE voice_gateway TO voicegw;
```

### 3. Create the tables — choose ONE method

**A) Alembic migrations (recommended for production):**
```bash
cd voice-gateway_1
source .venv/bin/activate
export DATABASE_URL='postgresql+psycopg2://voicegw:PASSWORD@HOST:5432/voice_gateway'
alembic upgrade head        # builds every table incl. conversations + chat_messages
```

**B) Raw SQL (fresh DB, no migration history):**
```bash
psql -h HOST -U voicegw -d voice_gateway -f voice-gateway_1/schema.sql
```

> If the DB already has the older tables but **not** the chat tables, just run
> `alembic upgrade head` — migration `202606290001_add_conversations` adds
> `conversations` + `chat_messages` without touching existing data.

### 4. Point the gateway at it — gateway `.env`
```ini
DATABASE_URL=postgresql+psycopg2://voicegw:PASSWORD@HOST:5432/voice_gateway
ENVIRONMENT=production
CREATE_DB_TABLES=false      # prod NEVER auto-creates; migrations own the schema
```
- `CREATE_DB_TABLES=true` (dev only) auto-creates tables from the ORM on startup.
- In production the config **rejects** SQLite and `CREATE_DB_TABLES=true` — it
  forces Postgres + migrations.

### 5. Verify the schema
```bash
psql "$DATABASE_URL" -c "\dt"        # expect: users, conversations, chat_messages,
                                     # text_to_speech, speech_to_text, otp_verifications,
                                     # rate_limits, error_logs
psql "$DATABASE_URL" -c "\d chat_messages"
```

### Tables at a glance
| Table | Holds |
|---|---|
| `users` | accounts, hashed password, **api_key**, usage counters |
| `conversations` | one row per chat/translate thread (user-scoped) |
| `chat_messages` | every message; translation turns add `source_lang/target_lang/engine` |
| `text_to_speech` / `speech_to_text` | gateway-native voice job records |
| `otp_verifications` | signup/login OTP codes |
| `rate_limits` | per-user, per-endpoint RPM/RPD counters |
| `error_logs` | all HTTP/unhandled errors |

### Migrations workflow (when you change models later)
```bash
# after editing app/models/*.py
alembic revision --autogenerate -m "describe change"
alembic upgrade head        # apply
alembic downgrade -1        # roll back one (if needed)
alembic current             # show applied revision
```
Back up RDS (snapshot) before running migrations in production.

---

## Other required setup

### JWT (login tokens)
```ini
JWT_SECRET=<64+ random chars>     # e.g. openssl rand -base64 48
JWT_EXPIRES=3600
```
Production refuses to start if `JWT_SECRET` is left at the dev default.

### Email / OTP (signup + verification)
```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@example.com
SMTP_PASSWORD=<app-password>
EMAIL_FROM=noreply@yourdomain.com
OTP_EXPIRES_MINUTES=10
```

### S3 (gateway-native TTS/STT audio storage)
```ini
USE_S3_STORAGE=true
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=your-audio-bucket
AWS_S3_REGION=ap-southeast-2
```
With `USE_S3_STORAGE=false`, audio is written to the local `audio_storage/` dir
and served from `/audio/...`.

### SQS async queue (optional — offload TTS/STT to a worker)
```ini
USE_ASYNC_QUEUE=true
AWS_SQS_REGION=ap-southeast-2
AWS_SQS_TTS_QUEUE_URL=...
AWS_SQS_STT_QUEUE_URL=...
```
Leave `false` for synchronous processing.

### CORS & networking
- Gateway `ALLOWED_ORIGINS` = the frontend origin(s) (comma-separated or JSON list).
- Put the gateway behind HTTPS (Nginx/ALB). Expose only the gateway publicly;
  keep the LLM service (`:8008`), vLLM (`:8007`), and STT (`:8002`) on a private network.
- Health probes: gateway `GET /health` and `GET /ready` (checks DB); LLM service
  `GET /api/engine-health`.

### Secrets hygiene
- Never commit `.env`. Rotate any key that's been shared (RDS password, AWS keys,
  JWT secret).
- Restrict the RDS security group to the gateway only; restrict the IAM user to the
  one S3 bucket + the two SQS queues.

---

## What each endpoint provides (LLM service)

| Endpoint | Purpose | Backed by |
|---|---|---|
| `POST /api/chat` | chat (SSE stream / sync) | vLLM |
| `POST /api/translate` | translate, `engine` llm/api | vLLM **or** Google free API |
| `POST /api/voice/tts` | neural TTS (MP3 stream) | Edge/Bing (`edge-tts`) |
| `POST /api/voice/stt` | speech-to-text | STT engine (:8002) |
| `GET /api/engine-health` | status of llm/tts/stt | — |
| `GET /v1/models`, `POST /v1/chat/completions` | OpenAI-compatible API | vLLM passthrough |

## Storage map

| Data | Where |
|---|---|
| Chats & translations | Postgres `conversations` + `chat_messages` (via gateway `/conversations`) |
| Users / API keys / OTP / rate limits / errors | Postgres (gateway tables) |
| Gateway-native TTS/STT job audio | S3 (`USE_S3_STORAGE=true`) |
| Model weights | GPU host (vLLM cache) |

## Deploy checklist
**Model & services**
- [ ] vLLM serving the model on `:8007`; `VLLM_BASE_URL` points to it.
- [ ] LLM service running on `:8008`; `/api/engine-health` all green.
- [ ] Gateway `LLM_SERVICE_URL` → LLM service; `LLM_REQUIRE_API_KEY` set.

**Database**
- [ ] Postgres/RDS provisioned; role + `voice_gateway` DB created.
- [ ] `DATABASE_URL` set; `ENVIRONMENT=production`, `CREATE_DB_TABLES=false`.
- [ ] `alembic upgrade head` run → all tables incl. `conversations` + `chat_messages`.
- [ ] `\dt` shows the expected tables; RDS snapshot taken before migrating.

**Other setup**
- [ ] `JWT_SECRET` set to a strong value (not the dev default).
- [ ] SMTP configured (OTP emails send).
- [ ] S3 (`USE_S3_STORAGE`) and/or SQS (`USE_ASYNC_QUEUE`) configured if used.
- [ ] `ALLOWED_ORIGINS` = frontend origin(s); gateway behind HTTPS.
- [ ] Only the gateway is public; LLM/vLLM/STT on a private network.
- [ ] Secrets rotated; `.env` files not committed.
