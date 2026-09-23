"""Общая обвязка OpenAI-совместимого API для всех моделей проекта.

Серверы различаются: не каждый знает `response_format: json_schema`, не каждый понимает
параметр `reasoning`. Поэтому запрос идёт лестницей — от самого строгого варианта к самому
простому, и первый же не-400 ответ считается рабочим. Ответ разбирается терпимо: модель
может обернуть JSON в ```json или добавить пояснение вокруг.

Здесь нет знаний о задаче: чем заполнять промпт, решают ai/llm.py (тексты) и ai/vlm.py
(разметка паттернов шаблона).
"""

import json
import logging
import re
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger(__name__)


@dataclass
class Answer:
    """Ответ модели: разобранный JSON (None — не дала его) и потраченные токены."""

    data: dict[str, Any] | None
    tokens: int = 0


def parse_json(content: str) -> dict[str, Any]:
    text = content.strip()
    fence = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text, re.IGNORECASE)
    if fence:
        try:
            return json.loads(fence.group(1))
        except json.JSONDecodeError:
            pass
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("в ответе нет JSON")
    return json.loads(match.group(0))


def message_text(message: dict[str, Any]) -> str:
    content = message.get("content") or ""
    if isinstance(content, list):  # некоторые серверы отдают ответ частями
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return content


def extra_body(raw: str | None, name: str) -> dict[str, Any]:
    """Дополнительные поля запроса из переменной окружения (JSON-строка)."""
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("%s — не JSON, параметр пропущен", name)
        return {}


def attempts(*, extra: dict[str, Any], disable_reasoning: bool, schema: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Варианты запроса от строгого к простому: json_schema → json_object → без формата."""
    reasoning = {"reasoning": {"enabled": False}} if disable_reasoning else {}
    formats: list[dict[str, Any]] = []
    if schema is not None:
        formats.append({"response_format": {"type": "json_schema", "json_schema": schema}})
    formats += [{"response_format": {"type": "json_object"}}, {}]
    # Последняя попытка — без reasoning: сервер мог ответить 400 именно на это поле.
    return [{**extra, **reasoning, **fmt} for fmt in formats] + [dict(extra)]


def ask_json(
    client: httpx.Client, payload: dict[str, Any], options: list[dict[str, Any]], label: str
) -> Answer:
    """POST /chat/completions с перебором вариантов запроса и разбором JSON из ответа."""
    response = None
    for extra in options:
        response = client.post("/chat/completions", json={**payload, **extra})
        if response.status_code != 400:
            break
    response.raise_for_status()
    body = response.json()
    tokens = int((body.get("usage") or {}).get("total_tokens") or 0)
    choices = body.get("choices") or []
    if not choices or not choices[0].get("message"):
        logger.warning("Модель не вернула ответ (%s)", label)
        return Answer(None, tokens)
    if choices[0].get("finish_reason") == "length":
        # JSON оборван на середине — дальше он не разберётся; лечится увеличением max_tokens.
        logger.warning("Ответ модели обрезан лимитом токенов (%s)", label)
    content = message_text(choices[0]["message"])
    if not content.strip():
        # У гибридных моделей рассуждения съедают лимит ответа — включите *_DISABLE_REASONING.
        logger.warning("Модель вернула пустой ответ (%s)", label)
        return Answer(None, tokens)
    try:
        return Answer(parse_json(content), tokens)
    except (ValueError, json.JSONDecodeError) as exc:
        logger.warning("Модель вернула не JSON (%s): %s", label, exc)
        return Answer(None, tokens)
