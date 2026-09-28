"""Редактура колоды одним вызовом после автора текстов (skills/deck_editor.yaml).

Слайды пишутся параллельно и не видят друг друга: один объект называется по-разному, числа в
разных форматах, мысль повторяется, между блоками нет связок. Редактор видит тексты всей колоды
и возвращает точечные замены «было → стало» и заметки докладчика с переходом к следующему слайду.
Замена применяется, только если фрагмент дословно есть на слайде, текст не раздувается и числа в
нём не меняются, — факты колоды редактура не трогает.
"""

import logging
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

from app.pipeline.ai.llm import Usage, ask, llm_enabled, open_client
from app.pipeline.planning.planner import TONES
from app.pipeline.planning.typography import polish_spec
from app.pipeline.skills import custom_skill_context, get_skill

logger = logging.getLogger(__name__)

DIGITS_RX = re.compile(r"\d+(?:[.,]\d+)?")
# Числа словами — тоже факты: «восемь часов» не должно стать «десятью».
NUMBER_WORDS_RX = re.compile(
    r"\b(?:ноль|нол|одн|один|два|две|двух|двум|тр[её]х|три|четыр|пят|шест|сем|восем|девят|десят|"
    r"одиннадцат|двенадцат|двадцат|тридцат|сорок|пятьдесят|сто|двест|триста|тысяч|миллион|миллиард|"
    r"половин|трет|четверт|вдвое|втрое|вчетверо|впятеро|вдесятеро|дважды|трижды|полтор)\w*",
    re.IGNORECASE,
)


def _numbers(text: str) -> list[str]:
    return sorted([*DIGITS_RX.findall(text), *(word.lower() for word in NUMBER_WORDS_RX.findall(text))])


_S = {"type": "string"}
SCHEMA = {
    "name": "deck_edit",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "replacements": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"n": {"type": "integer"}, "old": _S, "new": _S},
                    "required": ["n", "old", "new"],
                    "additionalProperties": False,
                },
            },
            "notes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"n": {"type": "integer"}, "text": _S},
                    "required": ["n", "text"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["replacements", "notes"],
        "additionalProperties": False,
    },
}


@dataclass
class DeckEditResult:
    source: str = "skip"  # llm | skip
    replaced: int = 0
    notes: int = 0
    rejected: int = 0
    usage: Usage | None = None

    def detail(self) -> str:
        if self.source != "llm":
            return ""
        return f"редактура колоды: замен {self.replaced}, связок в заметках {self.notes}"


def text_fields(spec: dict[str, Any]) -> Iterator[tuple[Callable[[], str], Callable[[str], None]]]:
    """Все тексты слайда для чтения и замены. Числа диаграмм и таблиц не входят."""

    def field(container: dict[str, Any], key: str):
        return (lambda: container.get(key) or ""), (lambda value: container.__setitem__(key, value))

    def item(container: list[Any], index: int):
        return (lambda: container[index] or ""), (lambda value: container.__setitem__(index, value))

    for key in ("insight", "subtitle"):
        if isinstance(spec.get(key), str):
            yield field(spec, key)
    for index in range(len(spec.get("bullets") or [])):
        yield item(spec["bullets"], index)
    for card in spec.get("cards") or []:
        yield field(card, "title")
        yield field(card, "text")
    for column in spec.get("columns") or []:
        yield field(column, "title")
        for index in range(len(column.get("bullets") or [])):
            yield item(column["bullets"], index)
    for step in spec.get("timeline") or []:
        yield field(step, "title")
        yield field(step, "text")
    data = spec.get("data")
    if isinstance(data, dict):
        yield field(data, "caption")
        for kpi in data.get("kpis") or []:
            yield field(kpi, "label")


def deck_text(specs: list[dict[str, Any]]) -> str:
    lines = []
    for number, spec in enumerate(specs, start=1):
        texts = [get() for get, _ in text_fields(spec) if get()]
        kind = spec.get("plan_kind") or spec.get("kind")
        head = spec.get("insight") or spec.get("topic") or ""
        body = " | ".join(text for text in texts if text != head)
        lines.append(f"{number}. [{kind}] {head}" + (f"\n   {body}" if body else ""))
        if spec.get("notes"):
            lines.append(f"   Заметка: {spec['notes']}")
    return "\n".join(lines)


def _safe(old: str, new: str, params: dict[str, Any]) -> bool:
    if not old or not new or old == new or "\n" in new:
        return False
    if len(new) > len(old) * float(params.get("max_growth", 1.4)) + int(params.get("growth_slack", 12)):
        return False
    # Факты не меняются: числа во фрагменте — цифрами и словами — должны остаться прежними.
    return _numbers(old) == _numbers(new)


def edit_deck(
    specs: list[dict[str, Any]],
    *,
    title: str,
    purpose: str,
    language: str = "ru",
    tone: str = "business",
    custom_skills: list[dict[str, Any]] | None = None,
) -> DeckEditResult:
    """Правит тексты спецификаций на месте. Без модели или без ответа колода остаётся как есть."""
    written = [spec for spec in specs if spec.get("plan_kind")]
    if not llm_enabled() or len(written) < 3:
        return DeckEditResult()
    skill = get_skill("deck_editor")
    params = skill.params or {}
    prompt = skill.prompt or {}
    values = {
        "title": title,
        "purpose": purpose,
        "language": "русский" if language == "ru" else "английский",
        "tone": TONES.get(tone, tone),
        "deck": deck_text(specs),
    }
    system, user = prompt.get("system") or "", prompt.get("user") or ""
    for key, value in values.items():
        system, user = system.replace("{" + key + "}", value), user.replace("{" + key + "}", value)
    if extra := custom_skill_context(custom_skills, {"all", "text"}):
        system += "\n\nПользовательские правила колоды:\n" + extra

    result = DeckEditResult(source="llm", usage=Usage())
    with open_client() as http:
        answer = ask(
            http,
            system=system,
            user=user,
            schema=SCHEMA,
            usage=result.usage,
            label="редактура колоды",
            max_tokens=int(params.get("max_tokens", 2500)),
            temperature=float(params.get("temperature", 0.2)),
        )
    if not answer:
        result.source = "skip"
        return result

    for change in answer.get("replacements") or []:
        old, new = str(change.get("old") or "").strip(), str(change.get("new") or "").strip()
        number = change.get("n") if isinstance(change.get("n"), int) else -1
        if not _safe(old, new, params) or not 0 <= number <= len(specs):
            result.rejected += 1
            continue
        targets = specs if number == 0 else [specs[number - 1]]
        hit = False
        for spec in targets:
            for get, set_ in text_fields(spec):
                text = get()
                if old in text:
                    set_(text.replace(old, new))
                    hit = True
        result.replaced += int(hit)
        result.rejected += int(not hit)
    for note in answer.get("notes") or []:
        number, text = note.get("n"), " ".join(str(note.get("text") or "").split())
        if isinstance(number, int) and 1 <= number <= len(specs) and text and specs[number - 1].get("plan_kind"):
            specs[number - 1]["notes"] = text[:400]
            result.notes += 1
    for spec in specs:
        polish_spec(spec, language)
    logger.info("Редактура колоды: %s замен, %s заметок, отклонено %s", result.replaced, result.notes, result.rejected)
    return result
