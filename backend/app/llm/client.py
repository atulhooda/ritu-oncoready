"""The only module allowed to call an LLM provider. Extraction only — never scoring or advice.

Gemini is tried first, Groq second. Every call takes a Pydantic schema and returns a validated
instance of it; output that fails validation from both providers raises `ExtractionFailed`.
"""

import json
import logging
from dataclasses import dataclass
from typing import Generic, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from app.config import get_settings

log = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)

SYSTEM_PROMPT = (
    "You extract facts from synthetic training documents. Copy text spans verbatim from the "
    "input. Do not infer, summarize, diagnose, or recommend treatment. Respond with JSON only, "
    "matching this JSON Schema:\n"
)


class ExtractionFailed(RuntimeError):
    pass


@dataclass(frozen=True)
class Extraction(Generic[T]):
    data: T
    model: str  # "<provider>:<model id>", stored as extracted_by


def _gemini(prompt: str, timeout: float) -> str:
    s = get_settings()
    r = httpx.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{s.gemini_model}:generateContent",
        headers={"x-goog-api-key": s.gemini_api_key or ""},
        json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
        },
        timeout=timeout,
    )
    r.raise_for_status()
    return r.json()["candidates"][0]["content"]["parts"][0]["text"]


def _groq(prompt: str, timeout: float) -> str:
    s = get_settings()
    r = httpx.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {s.groq_api_key or ''}"},
        json={
            "model": s.groq_model,
            "messages": [{"role": "user", "content": prompt}],
            "response_format": {"type": "json_object"},
            "temperature": 0,
        },
        timeout=timeout,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def extract(text: str, schema: type[T], instructions: str = "", timeout: float = 60) -> Extraction[T]:
    s = get_settings()
    prompt = f"{SYSTEM_PROMPT}{json.dumps(schema.model_json_schema())}\n\n{instructions}\n\nDOCUMENT:\n{text}"
    providers = [
        ("gemini", s.gemini_model, _gemini, s.gemini_api_key),
        ("groq", s.groq_model, _groq, s.groq_api_key),
    ]
    errors = []
    for name, model, call, key in providers:
        if not key:
            continue
        try:
            return Extraction(schema.model_validate_json(call(prompt, timeout)), f"{name}:{model}")
        except (httpx.HTTPError, KeyError, IndexError, ValidationError) as e:
            log.warning("llm extraction via %s failed: %s", name, e)
            errors.append(f"{name}: {e}")
    raise ExtractionFailed("; ".join(errors) or "no LLM provider configured")
