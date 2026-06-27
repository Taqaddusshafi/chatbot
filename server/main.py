"""LLM Chat Service — FastAPI application.

Provides chat and translation endpoints that proxy to vLLM,
plus voice proxy endpoints that forward to the existing Voice Gateway.
"""

import json
import logging
import time

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from config import get_settings
from llm_service import (
    complete_chat,
    detect_language,
    list_models,
    stream_chat,
    translate_text,
)

# ── Setup ─────────────────────────────────────────────────────────────────────
settings = get_settings()

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Chatbot Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve the frontend from the parent directory
import os
from pathlib import Path
from fastapi.responses import HTMLResponse

FRONTEND_DIR = Path(__file__).resolve().parent.parent


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
    target_lang: str | None = Field(
        default=None,
        pattern="^(ar|en)$",
        description="Target language: 'ar' or 'en'. Auto-detects if omitted.",
    )


class TranslateResponse(BaseModel):
    translation: str
    source_lang: str
    target_lang: str


# ── Chat endpoint ─────────────────────────────────────────────────────────────


@app.post("/api/chat")
async def chat(request: ChatRequest):
    """Send a chat message and get a streaming or non-streaming response."""
    messages = [m.model_dump() for m in request.messages]

    if request.stream:

        async def event_generator():
            try:
                async for chunk in stream_chat(
                    messages=messages,
                    temperature=request.temperature,
                    max_tokens=request.max_tokens,
                    top_p=request.top_p,
                    system_prompt=settings.chat_system_prompt,
                ):
                    yield {"data": json.dumps({"content": chunk})}
                yield {"data": "[DONE]"}
            except httpx.HTTPStatusError as exc:
                error_detail = exc.response.text[:500] if exc.response else str(exc)
                yield {
                    "data": json.dumps(
                        {"error": f"LLM engine error: {error_detail}"}
                    )
                }
            except Exception as exc:
                yield {"data": json.dumps({"error": f"LLM unreachable: {str(exc)}"})}

        return EventSourceResponse(event_generator())
    else:
        # Non-streaming
        try:
            content = await complete_chat(
                messages=messages,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
                system_prompt=settings.chat_system_prompt,
            )
            return {
                "choices": [
                    {"message": {"role": "assistant", "content": content}}
                ]
            }
        except httpx.HTTPStatusError as exc:
            raise HTTPException(
                status_code=exc.response.status_code,
                detail=f"LLM engine error: {exc.response.text[:500]}",
            )
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"LLM unreachable: {str(exc)}",
            )


# ── Translation endpoint ─────────────────────────────────────────────────────


@app.post("/api/translate", response_model=TranslateResponse)
async def translate(request: TranslateRequest):
    """Translate text between Arabic and English."""
    try:
        result = await translate_text(
            text=request.text,
            target_lang=request.target_lang,
        )
        return result
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"LLM engine error: {exc.response.text[:500]}",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"LLM unreachable: {str(exc)}",
        )


# ── Voice TTS — Edge TTS (Microsoft Neural voices) ────────────────────────────

import re as _re

# Language → best neural voice mapping
EDGE_TTS_VOICES = {
    "ur": "ur-PK-UzmaNeural",      # Urdu (female, natural)
    "ur-male": "ur-PK-AsadNeural",  # Urdu (male)
    "ar": "ar-SA-ZariyahNeural",    # Arabic (female)
    "ar-male": "ar-SA-HamedNeural", # Arabic (male)
    "hi": "hi-IN-SwaraNeural",      # Hindi (female)
    "hi-male": "hi-IN-MadhurNeural",# Hindi (male)
    "en": "en-US-JennyNeural",      # English US (female)
    "en-male": "en-US-GuyNeural",   # English US (male)
    "en-GB": "en-GB-SoniaNeural",   # English UK
    "fr": "fr-FR-DeniseNeural",     # French
    "es": "es-ES-ElviraNeural",     # Spanish
    "de": "de-DE-KatjaNeural",      # German
    "tr": "tr-TR-EmelNeural",       # Turkish
    "bn": "bn-IN-TanishaaNeural",   # Bengali
    "ta": "ta-IN-PallaviNeural",    # Tamil
    "te": "te-IN-ShrutiNeural",     # Telugu
    "pa": "pa-IN-GurpreetNeural",   # Punjabi
    "ru": "ru-RU-SvetlanaNeural",   # Russian
    "zh": "zh-CN-XiaoxiaoNeural",   # Chinese
    "fa": "fa-IR-DilaraNeural",     # Persian
    "it": "it-IT-ElsaNeural",       # Italian
    "pt": "pt-BR-FranciscaNeural",  # Portuguese
}

_URDU_CHARS_RE = _re.compile(r"[\u0679\u0688\u0691\u06BA\u06BE\u06C1\u06C3\u06CC\u06D2]")
_ARABIC_SCRIPT_RE = _re.compile(r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]")
_DEVANAGARI_RE = _re.compile(r"[\u0900-\u097F]")


def _detect_tts_lang(text: str) -> str:
    """Detect language for TTS voice selection."""
    urdu_count = len(_URDU_CHARS_RE.findall(text))
    arabic_count = len(_ARABIC_SCRIPT_RE.findall(text))
    devanagari_count = len(_DEVANAGARI_RE.findall(text))
    latin_count = sum(1 for c in text if c.isascii() and c.isalpha())

    if urdu_count >= 2 or (urdu_count >= 1 and arabic_count > latin_count * 2):
        return "ur"
    if arabic_count > latin_count and arabic_count > 3:
        return "ar"
    if devanagari_count > latin_count:
        return "hi"

    lower = text.lower()
    if _re.search(r"\b(le|la|les|une?|est|sont|avec|dans|pour)\b", lower):
        return "fr"
    if _re.search(r"\b(el|los|las|una?|es|son|con|para|pero)\b", lower):
        return "es"
    if _re.search(r"\b(der|die|das|und|ist|ein|eine|mit|auf)\b", lower):
        return "de"
    if _re.search(r"\b(bir|ve|bu|ile|için|olan|gibi)\b", lower):
        return "tr"

    return "en"


@app.post("/api/voice/tts")
async def voice_tts(
    text: str = Form(...),
    language: str = Form(default=None),
    voice: str = Form(default=None),
    gender: str = Form(default="female"),
):
    """Generate natural speech using Microsoft Edge Neural TTS."""
    import edge_tts
    import io

    lang = language or _detect_tts_lang(text)

    if voice and voice in EDGE_TTS_VOICES.values():
        selected_voice = voice
    elif gender == "male" and f"{lang}-male" in EDGE_TTS_VOICES:
        selected_voice = EDGE_TTS_VOICES[f"{lang}-male"]
    elif lang in EDGE_TTS_VOICES:
        selected_voice = EDGE_TTS_VOICES[lang]
    else:
        selected_voice = EDGE_TTS_VOICES["en"]

    logger.info("Edge TTS → voice=%s lang=%s text=%d chars", selected_voice, lang, len(text))

    try:
        communicate = edge_tts.Communicate(text, selected_voice)
        audio_data = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data.write(chunk["data"])

        audio_data.seek(0)
        return Response(
            content=audio_data.read(),
            media_type="audio/mpeg",
            headers={
                "X-TTS-Voice": selected_voice,
                "X-TTS-Language": lang,
            },
        )
    except Exception as exc:
        logger.error("Edge TTS error: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Edge TTS error: {exc}",
        )


# ── Voice proxy — STT ─────────────────────────────────────────────────────────


@app.post("/api/voice/stt")
async def voice_stt(
    file: UploadFile = File(...),
    language: str = Form(default=None),
):
    """Proxy STT request to the existing Voice Gateway STT engine."""
    url = f"{settings.stt_engine_url.rstrip('/')}{settings.stt_engine_path}"
    data = await file.read()
    filename = file.filename or "audio.wav"
    raw_ct = file.content_type or "audio/wav"
    content_type = raw_ct.split(";")[0].strip()

    form_data = {}
    if language:
        form_data["language"] = language

    logger.info("STT proxy → %s  filename=%s", url, filename)

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                url,
                files={"file": (filename, data, content_type)},
                data=form_data,
                timeout=settings.engine_timeout,
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


# ── OpenAI-compatible surface (for AI gateways) ──────────────────────────────
# Standard /v1/chat/completions + /v1/models so any AI gateway can register this
# service as an OpenAI-style provider. Transparent proxy to vLLM; only defaults
# the model and injects the chat system prompt when the caller omits one.


@app.get("/v1/models")
async def openai_models():
    """OpenAI-style model list, proxied from vLLM with a configured fallback."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f"{settings.vllm_base_url}/models",
                headers={"Authorization": f"Bearer {settings.vllm_api_key}"},
            )
            r.raise_for_status()
            return JSONResponse(content=r.json())
    except Exception:
        return {
            "object": "list",
            "data": [
                {"id": settings.vllm_model, "object": "model", "owned_by": "vllm"}
            ],
        }


@app.post("/v1/chat/completions")
async def openai_chat_completions(request: Request):
    """OpenAI-compatible chat completions — transparent proxy to vLLM."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")

    body.setdefault("model", settings.vllm_model)

    messages = body.get("messages") or []
    if not messages or messages[0].get("role") != "system":
        body["messages"] = [
            {"role": "system", "content": settings.chat_system_prompt},
            *messages,
        ]

    stream = bool(body.get("stream", False))
    url = f"{settings.vllm_base_url.rstrip('/')}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.vllm_api_key}",
    }

    if stream:

        async def relay():
            async with httpx.AsyncClient(timeout=settings.vllm_timeout) as client:
                async with client.stream(
                    "POST", url, json=body, headers=headers
                ) as resp:
                    resp.raise_for_status()
                    async for chunk in resp.aiter_raw():
                        yield chunk

        return StreamingResponse(relay(), media_type="text/event-stream")

    try:
        async with httpx.AsyncClient(timeout=settings.vllm_timeout) as client:
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


# ── Utility endpoints ─────────────────────────────────────────────────────────


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "chatbot"}


@app.get("/api/models")
async def models():
    """List available LLM models from vLLM."""
    model_list = await list_models()
    return {"models": model_list, "default": settings.vllm_model}


@app.get("/api/engine-health")
async def engine_health():
    """Connectivity check for all backends."""
    results = {}

    # Check vLLM
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{settings.vllm_base_url}/models", timeout=5)
            results["llm"] = {"status": "ok", "http": r.status_code}
    except Exception as exc:
        results["llm"] = {"status": "unreachable", "error": str(exc)}

    # Check TTS
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(settings.tts_engine_url, timeout=5)
            results["tts"] = {"status": "ok", "http": r.status_code}
    except Exception as exc:
        results["tts"] = {"status": "unreachable", "error": str(exc)}

    # Check STT
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(settings.stt_engine_url, timeout=5)
            results["stt"] = {"status": "ok", "http": r.status_code}
    except Exception as exc:
        results["stt"] = {"status": "unreachable", "error": str(exc)}

    return results


# ── Serve frontend ────────────────────────────────────────────────────────────


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
async def serve_frontend():
    """Serve the chatbot frontend."""
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return HTMLResponse(index_file.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>Chatbot</h1><p>Frontend not found.</p>")



@app.get("/style.css", include_in_schema=False)
async def serve_css():
    css_file = FRONTEND_DIR / "style.css"
    if css_file.exists():
        return Response(content=css_file.read_text(encoding="utf-8"), media_type="text/css")
    return Response(status_code=404)


@app.get("/app.js", include_in_schema=False)
async def serve_js():
    js_file = FRONTEND_DIR / "app.js"
    if js_file.exists():
        return Response(content=js_file.read_text(encoding="utf-8"), media_type="application/javascript")
    return Response(status_code=404)


@app.get("/favicon.svg", include_in_schema=False)
async def serve_favicon():
    fav_file = FRONTEND_DIR / "favicon.svg"
    if fav_file.exists():
        return Response(content=fav_file.read_text(encoding="utf-8"), media_type="image/svg+xml")
    return Response(status_code=404)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
        log_level=settings.log_level.lower(),
    )
