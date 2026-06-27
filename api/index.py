"""Vercel serverless entry point — lightweight chatbot proxy, no local storage.

Routes exposed on Vercel:
  GET  /                    — serves the chatbot HTML page
  GET  /api/health          — liveness check
  GET  /api/engine-health   — connectivity to LLM, TTS, STT engines
  POST /api/chat            — proxy chat to vLLM (streaming SSE)
  POST /api/translate       — proxy translation to vLLM
  POST /api/voice/tts       — proxy to existing TTS engine
  POST /api/voice/stt       — proxy to existing STT engine
"""

import json
import os
import re
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

# ── Engine URLs from environment ─────────────────────────────────────────────
VLLM_BASE_URL = os.environ.get("VLLM_BASE_URL", "http://185.14.252.20:8007/v1")
VLLM_API_KEY = os.environ.get("VLLM_API_KEY", "EMPTY")
VLLM_MODEL = os.environ.get("VLLM_MODEL", "meta-llama/Llama-3.1-8B-Instruct")
VLLM_TIMEOUT = float(os.environ.get("VLLM_TIMEOUT", "120"))

TTS_ENGINE_URL = os.environ.get("TTS_ENGINE_URL", "http://185.14.252.20:8000")
TTS_ENGINE_PATH = os.environ.get("TTS_ENGINE_PATH", "/v1/tts")
STT_ENGINE_URL = os.environ.get("STT_ENGINE_URL", "http://185.14.252.20:8002")
STT_ENGINE_PATH = os.environ.get("STT_ENGINE_PATH", "/v1/stt")
ENGINE_TIMEOUT = float(os.environ.get("ENGINE_TIMEOUT", "60"))

CHAT_SYSTEM_PROMPT = os.environ.get(
    "CHAT_SYSTEM_PROMPT",
    "You are a helpful, knowledgeable, and friendly general-purpose AI assistant. "
    "You provide clear, accurate, and well-structured responses. "
    "When appropriate, use markdown formatting for better readability. "
    "Always reply in the same language the user wrote their message in. "
    "Do not switch languages or translate unless the user explicitly asks you to.",
)

TRANSLATE_EN_TO_AR = (
    "You are a professional Arabic-English translator. "
    "Translate the following text from English to Arabic. "
    "Provide only the translation, no explanations or notes. "
    "Use Modern Standard Arabic (MSA)."
)

TRANSLATE_AR_TO_EN = (
    "You are a professional Arabic-English translator. "
    "Translate the following text from Arabic to English. "
    "Provide only the translation, no explanations or notes."
)

# Frontend HTML
_PUBLIC = Path(__file__).resolve().parent.parent / "public" / "index.html"
_ROOT_INDEX = Path(__file__).resolve().parent.parent / "index.html"

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="AI Chatbot", version="1.0.0", docs_url="/api/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Arabic detection ──────────────────────────────────────────────────────────
_ARABIC_RE = re.compile(
    r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]"
)


def is_arabic(text: str) -> bool:
    arabic_chars = len(_ARABIC_RE.findall(text))
    alpha_chars = sum(1 for c in text if c.isalpha())
    return alpha_chars > 0 and arabic_chars / alpha_chars > 0.5


# ── Schemas ───────────────────────────────────────────────────────────────────


class ChatMessage(BaseModel):
    role: str = Field(..., pattern="^(system|user|assistant)$")
    content: str = Field(..., min_length=1)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(..., min_length=1)
    temperature: float | None = None
    max_tokens: int | None = None
    top_p: float | None = None
    stream: bool = True


class TranslateRequest(BaseModel):
    text: str = Field(..., min_length=1)
    target_lang: str | None = Field(default=None, pattern="^(ar|en)$")


# ── Health ────────────────────────────────────────────────────────────────────


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "chatbot"}


@app.get("/api/engine-health")
async def engine_health():
    results = {}
    for label, url in [
        ("llm", f"{VLLM_BASE_URL}/models"),
        ("tts", TTS_ENGINE_URL),
        ("stt", STT_ENGINE_URL),
    ]:
        if not url:
            results[label] = {"status": "not_configured"}
            continue
        try:
            async with httpx.AsyncClient() as client:
                r = await client.get(url, timeout=5)
                results[label] = {"status": "ok", "http": r.status_code}
        except Exception as exc:
            results[label] = {"status": "unreachable", "error": str(exc)}
    return results


# ── OpenAI-compatible surface (for AI gateways) ──────────────────────────────
# Exposes the standard /v1/chat/completions and /v1/models contract so any AI
# gateway (Kong AI Gateway, Portkey, LiteLLM, Cloudflare AI Gateway, OpenRouter,
# etc.) can register this microservice as an OpenAI-style provider. Requests are
# proxied to the underlying vLLM engine (already OpenAI-format); we only default
# the model and inject the chat system prompt when the caller omits one.


@app.get("/v1/models")
async def openai_models():
    """OpenAI-style model list. Proxies vLLM, falling back to the configured model."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f"{VLLM_BASE_URL}/models",
                headers={"Authorization": f"Bearer {VLLM_API_KEY}"},
            )
            r.raise_for_status()
            return JSONResponse(content=r.json())
    except Exception:
        # Synthesize a minimal OpenAI-compatible response if vLLM is unreachable.
        return {
            "object": "list",
            "data": [{"id": VLLM_MODEL, "object": "model", "owned_by": "vllm"}],
        }


@app.post("/v1/chat/completions")
async def openai_chat_completions(request: Request):
    """OpenAI-compatible chat completions — transparent proxy to vLLM.

    Supports both streaming (text/event-stream) and non-streaming. The caller's
    request body is forwarded verbatim, so usage stats, ids, and finish_reason
    are preserved exactly as an AI gateway expects.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")

    body.setdefault("model", VLLM_MODEL)

    # Inject the default system prompt only when the caller hasn't set one.
    messages = body.get("messages") or []
    if not messages or messages[0].get("role") != "system":
        body["messages"] = [
            {"role": "system", "content": CHAT_SYSTEM_PROMPT},
            *messages,
        ]

    stream = bool(body.get("stream", False))
    url = f"{VLLM_BASE_URL}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {VLLM_API_KEY}",
    }

    if stream:

        async def relay():
            async with httpx.AsyncClient(timeout=VLLM_TIMEOUT) as client:
                async with client.stream(
                    "POST", url, json=body, headers=headers
                ) as resp:
                    resp.raise_for_status()
                    # Pass vLLM's OpenAI SSE chunks through untouched.
                    async for chunk in resp.aiter_raw():
                        yield chunk

        return StreamingResponse(relay(), media_type="text/event-stream")

    try:
        async with httpx.AsyncClient(timeout=VLLM_TIMEOUT) as client:
            resp = await client.post(url, json=body, headers=headers)
            return JSONResponse(status_code=resp.status_code, content=resp.json())
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"LLM engine error: {exc.response.text[:500]}",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"LLM unreachable: {exc}",
        )


# ── Chat ──────────────────────────────────────────────────────────────────────


@app.post("/api/chat")
async def chat(request: ChatRequest):
    messages = [m.model_dump() for m in request.messages]

    # Prepend system prompt
    if not messages or messages[0].get("role") != "system":
        messages.insert(0, {"role": "system", "content": CHAT_SYSTEM_PROMPT})

    payload = {
        "model": VLLM_MODEL,
        "messages": messages,
        "temperature": request.temperature or 0.7,
        "max_tokens": request.max_tokens or 2048,
        "top_p": request.top_p or 0.9,
        "stream": request.stream,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {VLLM_API_KEY}",
    }

    if request.stream:

        async def event_generator():
            try:
                async with httpx.AsyncClient(timeout=VLLM_TIMEOUT) as client:
                    async with client.stream(
                        "POST",
                        f"{VLLM_BASE_URL}/chat/completions",
                        json=payload,
                        headers=headers,
                    ) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            if not line.startswith("data: "):
                                continue
                            data_str = line[6:].strip()
                            if data_str == "[DONE]":
                                yield {"data": "[DONE]"}
                                break
                            try:
                                chunk = json.loads(data_str)
                                delta = chunk.get("choices", [{}])[0].get(
                                    "delta", {}
                                )
                                content = delta.get("content", "")
                                if content:
                                    yield {
                                        "data": json.dumps({"content": content})
                                    }
                            except json.JSONDecodeError:
                                continue
            except Exception as exc:
                yield {"data": json.dumps({"error": str(exc)})}

        return EventSourceResponse(event_generator())
    else:
        try:
            async with httpx.AsyncClient(timeout=VLLM_TIMEOUT) as client:
                resp = await client.post(
                    f"{VLLM_BASE_URL}/chat/completions",
                    json=payload,
                    headers=headers,
                )
                resp.raise_for_status()
                data = resp.json()
                return {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": data["choices"][0]["message"]["content"],
                            }
                        }
                    ]
                }
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"LLM unreachable: {exc}",
            )


# ── Translation ───────────────────────────────────────────────────────────────


@app.post("/api/translate")
async def translate(request: TranslateRequest):
    source_lang = "ar" if is_arabic(request.text) else "en"
    target_lang = request.target_lang or ("en" if source_lang == "ar" else "ar")
    system_prompt = TRANSLATE_EN_TO_AR if target_lang == "ar" else TRANSLATE_AR_TO_EN

    payload = {
        "model": VLLM_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": request.text},
        ],
        "temperature": 0.2,
        "max_tokens": 2048,
        "stream": False,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {VLLM_API_KEY}",
    }

    try:
        async with httpx.AsyncClient(timeout=VLLM_TIMEOUT) as client:
            resp = await client.post(
                f"{VLLM_BASE_URL}/chat/completions",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
            translation = data["choices"][0]["message"]["content"].strip()
            return {
                "translation": translation,
                "source_lang": source_lang,
                "target_lang": target_lang,
            }
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"LLM unreachable: {exc}",
        )


# ── Voice TTS proxy ───────────────────────────────────────────────────────────


@app.post("/api/voice/tts")
async def voice_tts(
    text: str = Form(...),
    language: str = Form(default="en"),
    voice: str = Form(default="v2/en_speaker_6"),
):
    url = f"{TTS_ENGINE_URL.rstrip('/')}{TTS_ENGINE_PATH}"
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                url,
                json={"text": text, "language": language, "voice": voice},
                timeout=ENGINE_TIMEOUT,
            )
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "audio/wav")
            return Response(content=resp.content, media_type=content_type)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"TTS engine error: {exc.response.text[:500]}",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"TTS engine unreachable: {exc}",
        )


# ── Voice STT proxy ───────────────────────────────────────────────────────────


@app.post("/api/voice/stt")
async def voice_stt(
    file: UploadFile = File(...),
    language: str = Form(default=None),
):
    url = f"{STT_ENGINE_URL.rstrip('/')}{STT_ENGINE_PATH}"
    data = await file.read()
    filename = file.filename or "audio.wav"
    raw_ct = file.content_type or "audio/wav"
    content_type = raw_ct.split(";")[0].strip()
    form_data = {}
    if language:
        form_data["language"] = language

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                url,
                files={"file": (filename, data, content_type)},
                data=form_data,
                timeout=ENGINE_TIMEOUT,
            )
            resp.raise_for_status()
            ct = resp.headers.get("content-type", "")
            if "application/json" in ct:
                return resp.json()
            return {"text": resp.text.strip()}
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"STT engine error: {exc.response.text[:500]}",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"STT engine unreachable: {exc}",
        )


# ── Static file serving ──────────────────────────────────────────────────────

_STATIC_DIR = Path(__file__).resolve().parent.parent


@app.get("/style.css", include_in_schema=False)
async def serve_css():
    f = _STATIC_DIR / "style.css"
    if f.exists():
        return Response(content=f.read_text("utf-8"), media_type="text/css")
    return Response(status_code=404)


@app.get("/app.js", include_in_schema=False)
async def serve_js():
    f = _STATIC_DIR / "app.js"
    if f.exists():
        return Response(
            content=f.read_text("utf-8"), media_type="application/javascript"
        )
    return Response(status_code=404)


@app.get("/favicon.svg", include_in_schema=False)
async def serve_favicon():
    f = _STATIC_DIR / "favicon.svg"
    if f.exists():
        return Response(content=f.read_text("utf-8"), media_type="image/svg+xml")
    return Response(status_code=404)


# ── Demo page ─────────────────────────────────────────────────────────────────


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
async def demo_page():
    for candidate in [_ROOT_INDEX, _PUBLIC]:
        if candidate.exists():
            return HTMLResponse(candidate.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>AI Chatbot</h1><p>Frontend not found.</p>")
