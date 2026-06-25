"""Environment-driven configuration for the LLM Chat Service."""

from functools import lru_cache
from typing import Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings loaded from environment variables and .env files."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Application
    host: str = "0.0.0.0"
    port: int = 8008
    log_level: str = "INFO"
    allowed_origins: list[str] = [
        "http://localhost:3000",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:8002",
        "*",
    ]

    # vLLM / OpenAI-compatible LLM backend
    vllm_base_url: str = "http://185.14.252.20:8007/v1"
    vllm_api_key: str = "EMPTY"
    vllm_model: str = "meta-llama/Llama-3.1-8B-Instruct"
    vllm_timeout: float = 120.0

    # Generation defaults
    default_temperature: float = 0.7
    default_max_tokens: int = 2048
    default_top_p: float = 0.9

    # Existing Voice Gateway engines (reuse — no duplication)
    tts_engine_url: str = "http://185.14.252.20:8000"
    tts_engine_path: str = "/v1/tts"
    stt_engine_url: str = "http://185.14.252.20:8002"
    stt_engine_path: str = "/v1/stt"
    engine_timeout: float = 60.0

    # Translation system prompts
    translate_en_to_ar_prompt: str = (
        "You are a professional Arabic-English translator. "
        "Translate the following text from English to Arabic. "
        "Provide only the translation, no explanations or notes. "
        "Use Modern Standard Arabic (MSA) unless the context clearly "
        "requires a specific dialect."
    )
    translate_ar_to_en_prompt: str = (
        "You are a professional Arabic-English translator. "
        "Translate the following text from Arabic to English. "
        "Provide only the translation, no explanations or notes. "
        "Preserve the tone and meaning of the original text."
    )

    # Chat system prompt
    chat_system_prompt: str = (
        "You are a helpful, knowledgeable, and friendly general-purpose AI assistant. "
        "You provide clear, accurate, and well-structured responses. "
        "When appropriate, use markdown formatting for better readability. "
        "Always reply in the same language the user wrote their message in. "
        "Do not switch languages or translate unless the user explicitly asks you to."
    )

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def parse_csv_list(cls, value: Any) -> Any:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    """Return cached settings so all modules share the same configuration."""
    return Settings()
