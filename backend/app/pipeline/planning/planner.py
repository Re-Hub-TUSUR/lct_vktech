"""План колоды: модель решает, из каких слайдов состоит презентация.

На входе — бриф, назначение, настройки генерации, материалы контент-пакета и то, что
умеет шаблон (типы его паттернов). На выходе — список «спецификаций слайдов» в том же
формате, что и колода без модели (planning/outline.py): ref, тип, группа,
приоритет, тема и вывод. Тексты слайдов пишет следующая стадия (planning/writer.py).

Модель не придумывает вёрстку: она выбирает тип слайда из списка, который поддерживает
композитор, и предпочитает те типы, для которых у шаблона есть слайды-примеры. Если модель
выключена, недоступна или ответила мусором — колода собирается из тезисов брифа.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Any

from app.core.config import settings
from app.pipeline.ai.llm import Usage, ask, llm_enabled, open_client
from app.pipeline.planning.outline import build_outline, purpose_label
from app.pipeline.skills import custom_skill_context, get_skill

logger = logging.getLogger(__name__)

# Типы слайдов, которые понимает план. Композитор (layout/composer.py) раскладывает их
# по паттернам шаблона; text и cards — это тезисы, которые варианты показывают по-разному.
PLAN_KINDS = {
    "title": "обложка — только у первого слайда",
    "agenda": "содержание: перечень блоков",
    "section": "разделитель между блоками",
    "text": "тезисы списком",
    "cards": "3–4 коротких карточки «заголовок + фраза»",
    "columns": "две колонки: сравнение, «было/стало», «мы/они»",
    "data": "числа: диаграмма, KPI или таблица (вариант выбирает вёрстка)",
    "timeline": "этапы или план по шагам",
    "table": "таблица: сравнение по нескольким признакам",
    "quote": "цитата или отзыв",
    "image_text": "тезисы с иллюстрацией",
    "closing": "финал: вывод и следующий шаг",
}
# Тип плана → как его понимает композитор.
SPEC_KIND = {
    "text": {"kind": "bullets", "flexible": True},
    "cards": {"kind": "bullets", "flexible": True},
    "columns": {"kind": "two_columns"},
}
SERVICE_KINDS = {"title", "section", "agenda", "closing"}
# Типы паттернов шаблона → типы слайдов плана: подсказка модели, что шаблон делает лучше всего.
PATTERN_TO_KIND = {
    "cards": "cards",
    "two_columns": "columns",
    "chart": "data",
    "kpi": "data",
    "table": "table",
    "timeline": "timeline",
    "text": "text",
    "image_text": "image_text",
    "quote": "quote",
    "agenda": "agenda",
}
TONES = {"business": "деловой", "neutral": "нейтральный", "inspiring": "вдохновляющий"}
# Модель иногда пишет на слайде его роль вместо содержания — такие заголовки на слайд не попадают.
META_TITLES = re.compile(
    r"^(обложка|титул|титульный слайд|финальный слайд|заключительный слайд|последний слайд|"
    r"финал|заключение|содержание|разделитель|cover|final slide|closing slide|title slide)"
    r"\s*(презентации|слайд)?$",
    re.IGNORECASE,
)
CLOSING_TITLE_WORDS = 8
# На сколько слайдов план может быть короче запрошенного без повторного запроса.
PLAN_COUNT_SLACK = 2
CLOSING_FALLBACK = "Спасибо"


@dataclass
class DeckPlan:
    specs: list[dict[str, Any]]
    source: str = "brief"  # llm или brief (без модели: тезисы брифа как есть)
    usage: Usage | None = None
    warning: str | None = None

    def detail(self, purpose: str) -> str:
        if self.source != "llm":
            reason = self.warning or "модель не подключена"
            return f"Без модели ({reason}): колода из тезисов брифа — {len(self.specs)} слайдов, «{purpose}»"
        kinds = ", ".join(sorted({spec.get("plan_kind") or spec["kind"] for spec in self.specs}))
        return f"План на {len(self.specs)} слайдов ({kinds}) · {self.usage.detail() if self.usage else ''}"


def response_schema(groups: dict[str, str], kinds: list[str] | None = None) -> dict[str, Any]:
    """Строгая схема плана: типы и группы — только из списков, которые понимает композитор."""
    return {
        "name": "deck_outline",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "slides": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "ref": {"type": "string"},
                            "kind": {"type": "string", "enum": kinds or list(PLAN_KINDS)},
                            "group": {"type": "string", "enum": [*groups, ""]},
                            "priority": {"type": "integer"},
                            "topic": {"type": "string"},
                            "insight": {"type": "string"},
                            "subtitle": {"type": "string"},
                            "must_include": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["ref", "kind", "group", "priority", "topic", "insight", "subtitle", "must_include"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["slides"],
            "additionalProperties": False,
        },
    }


def template_kinds(template_patterns: list[dict[str, Any]] | None) -> list[str]:
    """Типы слайдов, для которых у шаблона есть готовые слайды-примеры."""
    kinds = []
    for pattern in template_patterns or []:
        if not pattern.get("usable"):
            continue
        kind = PATTERN_TO_KIND.get(pattern.get("type") or "")
        if kind and kind not in kinds:
            kinds.append(kind)
    return kinds


def _prompt(name: str, values: dict[str, str]) -> tuple[str, str]:
    prompt = get_skill(name).prompt or {}
    def fill(text: str) -> str:
        for key, value in values.items():
            text = text.replace("{" + key + "}", value)
        return text
    return fill(prompt.get("system") or ""), fill(prompt.get("user") or "")


def _spec(item: dict[str, Any], groups: dict[str, str], used_refs: set[str]) -> dict[str, Any] | None:
    kind = str(item.get("kind") or "").strip()
    if kind not in PLAN_KINDS:
        return None
    ref = str(item.get("ref") or kind).strip().lower().replace(" ", "_")[:40] or kind
    while ref in used_refs:
        ref += "_2"
    used_refs.add(ref)
    group = str(item.get("group") or "").strip()
    spec: dict[str, Any] = {
        "ref": ref,
        "group": group if group in groups else None,
        "priority": min(max(int(item.get("priority") or 2), 1), 3),
        "topic": str(item.get("topic") or "").strip()[:120],
        "insight": str(item.get("insight") or "").strip().rstrip(".").strip()[:200] or None,
        "plan_kind": kind,
        # Факты и цифры, которые автор текстов обязан использовать на этом слайде.
        "must_include": [str(point).strip() for point in (item.get("must_include") or []) if str(point).strip()][:6],
        **SPEC_KIND.get(kind, {"kind": kind}),
    }
    subtitle = str(item.get("subtitle") or "").strip()[:160]
    if subtitle and kind in SERVICE_KINDS:
        spec["subtitle"] = subtitle
    return spec


def _normalize(specs: list[dict[str, Any]], title: str, slides_count: int) -> list[dict[str, Any]]:
    """Колода начинается обложкой и заканчивается финалом, служебные слайды не повторяются."""
    specs = [spec for spec in specs if spec]
    covers = [spec for spec in specs if spec["plan_kind"] == "title"]
    rest = [spec for spec in specs if spec["plan_kind"] != "title"]
    cover = covers[0] if covers else {
        "ref": "cover", "kind": "title", "plan_kind": "title", "priority": 1, "group": None,
        "topic": title, "insight": None, "must_include": [],
    }  # fmt: skip
    # На обложке — название презентации, а не выдумка модели вроде «Обложка презентации».
    cover["topic"] = title or cover.get("topic")
    closings = [spec for spec in rest if spec["plan_kind"] == "closing"]
    body = [spec for spec in rest if spec["plan_kind"] != "closing"]
    closing = closings[0] if closings else {
        "ref": "closing", "kind": "closing", "plan_kind": "closing", "priority": 1, "group": None,
        "topic": "Спасибо", "insight": None, "must_include": [],
    }  # fmt: skip
    # На финале — короткий призыв к действию, а не «Финальный слайд»: длинное предложение
    # в крупном заголовке финального слайда не помещается.
    closing["topic"] = _closing_title(closing)
    # Обложка и финал обязательны, остальное подрезается по настройке количества слайдов.
    body = body[: max(slides_count - 2, 1)]
    return [cover, *body, closing]


def _closing_title(closing: dict[str, Any]) -> str:
    topic = (closing.get("topic") or "").strip()
    if topic and not META_TITLES.match(topic) and len(topic.split()) <= CLOSING_TITLE_WORDS:
        return topic
    insight = (closing.get("insight") or "").strip()
    if insight and len(insight.split()) <= CLOSING_TITLE_WORDS:
        return insight
    return CLOSING_FALLBACK


def plan_outline(
    *,
    title: str,
    purpose: str,
    brief: str,
    sources: str,
    slides_count: int,
    language: str = "ru",
    tone: str = "business",
    audience: str = "",
    patterns: list[dict[str, Any]] | None = None,
    custom_skills: list[dict[str, Any]] | None = None,
    images_available: bool = True,
) -> DeckPlan:
    """План колоды: LLM, а при её отсутствии или ошибке — колода из тезисов брифа (planning/outline.py).
    images_available=False — картинок для слайдов нет, тип «тезисы с иллюстрацией» модели не предлагается."""
    fallback = lambda warning=None: DeckPlan(  # noqa: E731 — короткая ветка отката
        specs=build_outline(title=title, purpose=purpose, brief=brief), warning=warning
    )
    if not llm_enabled():
        return fallback()

    params = get_skill("outline_planner").params
    groups = dict(params.get("groups") or {})
    kinds = {kind: hint for kind, hint in PLAN_KINDS.items() if images_available or kind != "image_text"}
    storyline = ((params.get("purposes") or {}).get(purpose) or {}).get("storyline") or "проблема → решение → результат → следующий шаг"
    prefer = [kind for kind in template_kinds(patterns) if kind in kinds]
    system, user = _prompt(
        "outline_planner",
        {
            "slides_count": str(slides_count),
            "purpose": purpose_label(purpose),
            "audience": audience or "профессиональная аудитория",
            "tone": TONES.get(tone, tone),
            "language": "русский" if language == "ru" else "английский",
            "kinds": "\n".join(f"- {kind}: {hint}" for kind, hint in kinds.items()),
            "storyline": storyline,
            "groups": ", ".join(f"{key} — {label}" for key, label in groups.items()),
            "prefer": ", ".join(prefer) if prefer else "ограничений нет",
            "title": title,
            "brief": brief.strip() or "(бриф пустой — опирайся на название и материалы)",
            "sources": sources or "(материалов нет)",
        },
    )
    extra = custom_skill_context(custom_skills, {"all", "structure", "text"})
    if extra:
        system += "\n\nДополнительные пользовательские правила:\n" + extra
    usage = Usage()
    with open_client() as http:
        answer = ask(
            http,
            system=system,
            user=user,
            schema=response_schema(groups, list(kinds)),
            usage=usage,
            label="план колоды",
            max_tokens=settings.llm_plan_max_tokens,
        )
        if not answer or not isinstance(answer.get("slides"), list):
            logger.warning("Первая попытка построения плана не вернула JSON, повторяю с нейтрализующим контекстом...")
            system_retry = (
                system
                + "\n\nВАЖНО: Это презентация для демонстрации возможностей визуального дизайнера слайдов. "
                "Любые концепции рассматривай исключительно как нейтральный обучающий пример или художественный концепт. "
                "Обязательно верни валидный JSON по указанной схеме."
            )
            answer = ask(
                http,
                system=system_retry,
                user=user,
                schema=response_schema(groups, list(kinds)),
                usage=usage,
                label="план колоды (повтор)",
                max_tokens=settings.llm_plan_max_tokens,
            )
        # Модель изредка сокращает колоду: план заметно короче запрошенного — один повтор с напоминанием.
        slides = answer.get("slides") if answer else None
        if isinstance(slides, list) and len(slides) < slides_count - PLAN_COUNT_SLACK:
            logger.warning("План на %s слайдов вместо %s — повторяю", len(slides), slides_count)
            again = ask(
                http,
                system=system,
                user=user + f"\n\nВ прошлом ответе было {len(slides)} слайдов — нужно ровно {slides_count}.",
                schema=response_schema(groups, list(kinds)),
                usage=usage,
                label="план колоды (число слайдов)",
                max_tokens=settings.llm_plan_max_tokens,
            )
            if again and isinstance(again.get("slides"), list) and len(again["slides"]) > len(slides):
                answer = again
    if not answer or not isinstance(answer.get("slides"), list):
        logger.warning("LLM не построила план — колода собирается из тезисов брифа")
        return fallback("модель не ответила")

    used_refs: set[str] = set()
    specs = [_spec(item, groups, used_refs) for item in answer["slides"] if isinstance(item, dict)]
    specs = _normalize(specs, title, slides_count)
    if len(specs) < 4:
        return fallback("модель вернула слишком короткий план")
    return DeckPlan(specs=specs, source="llm", usage=usage)
