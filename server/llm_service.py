"""LLM service — streaming chat completions via vLLM's OpenAI-compatible API."""

import json
import logging
import re
from typing import AsyncGenerator

import httpx

from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# ---------------------------------------------------------------------------
# Arabic detection
# ---------------------------------------------------------------------------
_ARABIC_RE = re.compile(r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]")


def is_arabic(text: str) -> bool:
    """Return True if the text contains predominantly Arabic characters."""
    arabic_chars = len(_ARABIC_RE.findall(text))
    alpha_chars = sum(1 for c in text if c.isalpha())
    if alpha_chars == 0:
        return False
    return arabic_chars / alpha_chars > 0.5


def detect_language(text: str) -> str:
    """Detect if text is Arabic or English."""
    return "ar" if is_arabic(text) else "en"


# ---------------------------------------------------------------------------
# Streaming chat completion
# ---------------------------------------------------------------------------
async def stream_chat(
    messages: list[dict],
    temperature: float | None = None,
    max_tokens: int | None = None,
    top_p: float | None = None,
    system_prompt: str | None = None,
) -> AsyncGenerator[str, None]:
    """Stream chat completion tokens from vLLM.

    Yields individual content chunks as they arrive via SSE.
    """
    temp = temperature if temperature is not None else settings.default_temperature
    max_tok = max_tokens if max_tokens is not None else settings.default_max_tokens
    tp = top_p if top_p is not None else settings.default_top_p

    # Prepend system prompt if provided and not already in messages
    full_messages = list(messages)
    if system_prompt and (not full_messages or full_messages[0].get("role") != "system"):
        full_messages.insert(0, {"role": "system", "content": system_prompt})

    payload = {
        "model": settings.vllm_model,
        "messages": full_messages,
        "temperature": temp,
        "max_tokens": max_tok,
        "top_p": tp,
        "stream": True,
    }

    url = f"{settings.vllm_base_url}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.vllm_api_key}",
    }

    logger.info("LLM stream → %s  model=%s  msgs=%d", url, settings.vllm_model, len(full_messages))

    async with httpx.AsyncClient(timeout=settings.vllm_timeout) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    content = delta.get("content", "")
                    if content:
                        yield content
                except json.JSONDecodeError:
                    continue


# ---------------------------------------------------------------------------
# Non-streaming chat completion (for translation)
# ---------------------------------------------------------------------------
async def complete_chat(
    messages: list[dict],
    temperature: float | None = None,
    max_tokens: int | None = None,
    system_prompt: str | None = None,
) -> str:
    """Get a full (non-streaming) chat completion from vLLM."""
    temp = temperature if temperature is not None else 0.3  # Lower temp for translation
    max_tok = max_tokens if max_tokens is not None else settings.default_max_tokens

    full_messages = list(messages)
    if system_prompt and (not full_messages or full_messages[0].get("role") != "system"):
        full_messages.insert(0, {"role": "system", "content": system_prompt})

    payload = {
        "model": settings.vllm_model,
        "messages": full_messages,
        "temperature": temp,
        "max_tokens": max_tok,
        "stream": False,
    }

    url = f"{settings.vllm_base_url}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.vllm_api_key}",
    }

    logger.info("LLM complete → %s  model=%s", url, settings.vllm_model)

    async with httpx.AsyncClient(timeout=settings.vllm_timeout) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


# ---------------------------------------------------------------------------
# Translation helper
# ---------------------------------------------------------------------------
async def translate_text(text: str, target_lang: str | None = None) -> dict:
    """Translate text between Arabic and English.

    If target_lang is not specified, auto-detects the source language
    and translates to the other.

    Returns:
        dict with keys: translation, source_lang, target_lang
    """
    source_lang = detect_language(text)

    if target_lang is None:
        target_lang = "en" if source_lang == "ar" else "ar"

    if target_lang == "ar":
        system_prompt = settings.translate_en_to_ar_prompt
    else:
        system_prompt = settings.translate_ar_to_en_prompt

    messages = [{"role": "user", "content": text}]
    translation = await complete_chat(
        messages=messages,
        system_prompt=system_prompt,
        temperature=0.2,  # Very low for accurate translation
    )

    return {
        "translation": translation.strip(),
        "source_lang": source_lang,
        "target_lang": target_lang,
    }


# ---------------------------------------------------------------------------
# Model info
# ---------------------------------------------------------------------------
async def list_models() -> list[dict]:
    """List available models from vLLM."""
    url = f"{settings.vllm_base_url}/models"
    headers = {"Authorization": f"Bearer {settings.vllm_api_key}"}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data.get("data", [])
    except Exception as exc:
        logger.warning("Failed to list models: %s", exc)
        return []
