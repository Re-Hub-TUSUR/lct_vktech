"""Модель-судья аудита: контекстуальные проверки по тексту колоды и по картинкам слайдов.

Текст: один запрос на вариант — модель читает колоду целиком (связность соседних слайдов видна
только так) и возвращает по строке вердиктов на каждый слайд: тема или вывод в заголовке,
соответствие содержимого заголовку, главная мысль одним предложением, неподтверждённые факты,
опечатки, служебный текст, чужой язык, лишние строки таблицы и разрыв логики. Длинная колода
делится на части, у каждой части перед глазами вся колода.

Картинки: рендеры слайдов с фотографиями и иллюстрациями (логотипы и иконки не в счёт) уходят
пакетами по несколько штук; модель отвечает, относятся ли они к теме слайда.

Вердикты кэшируются по отпечатку слайда (плюс модель, материалы и заголовок предыдущего слайда),
поэтому после правки одного слайда модель проверяет только его. Промпты — skills/auditor.yaml.
"""

import hashlib
import io
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from PIL import Image

from app.pipeline.ai.llm import ModelConfig, Usage, ask, in_parallel, judge_model, open_client
from app.pipeline.audit.catalog import review_params
from app.pipeline.skills import get_skill
from app.schemas.slide import Slide, slide_key

logger = logging.getLogger(__name__)

KIND_LABELS = {
    "title": "обложка",
    "section": "разделитель",
    "agenda": "содержание",
    "bullets": "тезисы",
    "two_columns": "две колонки",
    "cards": "карточки",
    "chart": "диаграмма",
    "table": "таблица",
    "kpi": "показатели",
    "timeline": "этапы",
    "quote": "цитата",
    "image_text": "текст и картинка",
    "closing": "финал",
}
CHUNK = 12  # слайдов на разбор в одном запросе: ответ по ним укладывается в AUDIT_MAX_TOKENS

_S = {"type": "string"}
_LIST = {"type": "array", "items": _S}


def _object(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


VERDICT = _object(
    {
        "n": {"type": "integer"},
        "title_is_topic": {"type": "boolean"},
        "content_mismatch": {"type": "boolean"},
        "better_title": _S,
        "summary": _S,
        "unsupported": _LIST,
        "typos": {"type": "array", "items": _object({"wrong": _S, "right": _S})},
        "service": _LIST,
        "foreign": _LIST,
        "irrelevant": _LIST,
        "flow_break": {"type": "boolean"},
    }
)
DECK_SCHEMA = {"name": "deck_review", "strict": True, "schema": _object({"slides": {"type": "array", "items": VERDICT}})}
IMAGE_SCHEMA = {
    "name": "images_review",
    "strict": True,
    "schema": _object(
        {"slides": {"type": "array", "items": _object({"n": {"type": "integer"}, "relevant": {"type": "boolean"}, "reason": _S})}}
    ),
}


@dataclass
class ReviewCache:
    """Кэш вердиктов варианта (Variant.review): ключ — отпечаток слайда с контекстом проверки."""

    judge: str | None = None
    slides: dict[str, dict[str, Any]] = field(default_factory=dict)
    images: dict[str, dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def load(cls, stored: dict[str, Any] | None, judge: str | None) -> "ReviewCache":
        stored = stored or {}
        if stored.get("judge") != judge:
            return cls(judge=judge)  # сменилась модель-судья — старые вердикты не в счёт
        return cls(judge=judge, slides=dict(stored.get("slides") or {}), images=dict(stored.get("images") or {}))


@dataclass
class ReviewOutcome:
    reviews: dict[str, dict[str, Any]] = field(default_factory=dict)  # id слайда → вердикт или {"failed": True}
    image_reviews: dict[str, dict[str, Any]] = field(default_factory=dict)
    usage: Usage | None = None
    reviewed: int = 0
    images_reviewed: int = 0


def _clip(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _number(value: float) -> str:
    return f"{value:g}".replace(".", ",")


def slide_text(slide: Slide) -> str:
    """Содержимое слайда одной строкой — так его читает судья."""
    parts: list[str] = []
    if slide.subtitle:
        parts.append(slide.subtitle)
    if slide.bullets:
        parts.append(" | ".join(slide.bullets))
    for column in slide.columns:
        parts.append(f"{column.title}: {'; '.join(column.bullets)}" if column.bullets else column.title)
    if slide.kpis:
        parts.append(" | ".join(f"{kpi.value} — {kpi.label}" for kpi in slide.kpis))
    if slide.timeline:
        parts.append(" | ".join(" ".join(filter(None, [item.date, "—", item.title, item.text])) for item in slide.timeline))
    if slide.table:
        rows = [" / ".join(slide.table.columns)] + [" / ".join(row) for row in slide.table.rows]
        parts.append("таблица: " + "; ".join(rows))
    if slide.chart:
        chart = slide.chart
        series = "; ".join(
            f"{row.name or 'ряд'}: " + ", ".join(f"{cat} = {_number(v)}" for cat, v in zip(chart.categories, row.values))
            for row in chart.series
        )
        parts.append(f"диаграмма «{chart.caption or ''}» ({chart.unit or 'без единиц'}): {series}")
    if slide.quote:
        parts.append(f"цитата: «{slide.quote.text}»" + (f" — {slide.quote.author}" if slide.quote.author else ""))
    return " || ".join(part for part in parts if part) or "—"


def _fill(template: str, values: dict[str, str]) -> str:
    for key, value in values.items():
        template = template.replace("{" + key + "}", value)
    return template


def _digest(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]


def text_keys(slides: list[Slide], judge: str | None, sources: str) -> list[str]:
    """Ключ вердикта: слайд, судья, материалы и заголовок предыдущего слайда (от него зависит связность)."""
    base = f"{judge}|{_digest(sources)}"
    return [
        slide_key(slide, f"{base}|{slides[index - 1].title if index else ''}") for index, slide in enumerate(slides)
    ]


def image_key(slide: Slide, judge: str | None, render_salt: str) -> str:
    return slide_key(slide, f"{judge}|{render_salt}|image")


def review_deck(
    slides: list[Slide],
    *,
    title: str,
    language: str,
    sources: str,
    cache: ReviewCache,
    cfg: ModelConfig | None = None,
) -> ReviewOutcome:
    """Вердикты судьи по тексту для всех слайдов: из кэша или новым запросом. Кэш дополняется."""
    cfg = cfg or judge_model()
    outcome = ReviewOutcome(usage=Usage(model=cfg.model))
    if not cfg.enabled or not slides:
        return outcome
    params = review_params()
    keys = text_keys(slides, cfg.model, sources)
    todo = [index for index, key in enumerate(keys) if key not in cache.slides]
    for index, key in enumerate(keys):
        if key in cache.slides:
            outcome.reviews[slides[index].id] = cache.slides[key]
    if not todo:
        return outcome

    skill = get_skill("auditor")
    prompt = skill.prompt or {}
    limit = int(params.get("slide_chars", 900))
    deck = "\n".join(
        f"{number}. [{KIND_LABELS.get(slide.kind, slide.kind)}] Заголовок: {slide.title or '—'}\n"
        f"   Содержимое: {_clip(slide_text(slide), limit)}"
        for number, slide in enumerate(slides, start=1)
    )
    values = {
        "language": "русский" if language == "ru" else "английский",
        "title": title,
        "sources": _clip(sources or "", int(params.get("sources_chars", 8000))) or "(материалов нет)",
        "deck": deck,
    }
    system = _fill(prompt.get("system") or "", values)
    chunks = [todo[start : start + CHUNK] for start in range(0, len(todo), CHUNK)]

    with open_client(cfg) as http:

        def work(chunk: list[int]) -> dict[int, dict[str, Any]] | None:
            user = _fill(prompt.get("user") or "", {**values, "targets": ", ".join(str(i + 1) for i in chunk)})
            answer = ask(http, system=system, user=user, schema=DECK_SCHEMA, usage=outcome.usage, label="аудит колоды", cfg=cfg)
            if not answer:
                return None
            wanted = {index + 1 for index in chunk}
            found: dict[int, dict[str, Any]] = {}
            for item in answer.get("slides") or []:
                if isinstance(item, dict) and isinstance(item.get("n"), int) and item["n"] in wanted:
                    found[item["n"] - 1] = {key: value for key, value in item.items() if key != "n"}
            return found

        for chunk, found in zip(chunks, in_parallel(chunks, work, limit=cfg.concurrency)):
            for index in chunk:
                slide = slides[index]
                if found and index in found:
                    cache.slides[keys[index]] = found[index]
                    outcome.reviews[slide.id] = found[index]
                    outcome.reviewed += 1
                else:
                    outcome.reviews[slide.id] = {"failed": True}
    logger.info("Судья по тексту: %s слайдов, %s", outcome.reviewed, outcome.usage.as_dict())
    return outcome


def _prepared(path: Path, width: int) -> bytes | None:
    try:
        with Image.open(path) as image:
            image = image.convert("RGB")
            if image.width > width:
                image = image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)
            buffer = io.BytesIO()
            image.save(buffer, "JPEG", quality=85)
            return buffer.getvalue()
    except OSError as exc:
        logger.warning("Рендер слайда %s не прочитан: %s", path, exc)
        return None


def picture_slides(slides: list[Slide], renders: dict[str, dict[str, Any]]) -> set[str]:
    """Слайды с фотографиями или иллюстрациями: картинка крупнее иконки (логотипы мастера сюда не входят)."""
    minimum = float(review_params().get("picture_min_area", 0.04))
    result = set()
    for slide in slides:
        facts = (renders.get(slide.id) or {}).get("facts") or {}
        if any(p["bbox"][2] * p["bbox"][3] >= minimum for p in facts.get("pictures") or [] if len(p.get("bbox") or []) == 4):
            result.add(slide.id)
    return result


def review_images(
    slides: list[Slide],
    renders: dict[str, dict[str, Any]],
    *,
    title: str,
    render_salt: str,
    cache: ReviewCache,
    outcome: ReviewOutcome,
    cfg: ModelConfig | None = None,
) -> None:
    """Вердикты судьи по картинкам: только слайды с иллюстрациями и актуальным рендером."""
    cfg = cfg or judge_model()
    if not cfg.enabled:
        return
    params = review_params()
    with_pictures = picture_slides(slides, renders)
    todo: list[tuple[Slide, str, Path]] = []
    for slide in slides:
        if slide.id not in with_pictures:
            continue
        key = image_key(slide, cfg.model, render_salt)
        if key in cache.images:
            outcome.image_reviews[slide.id] = cache.images[key]
        elif (path := (renders.get(slide.id) or {}).get("image")) is not None and Path(path).exists():
            todo.append((slide, key, Path(path)))
    if not todo:
        return

    prompt = get_skill("auditor").prompt or {}
    size = max(1, int(params.get("images_per_request", 4)))
    width = int(params.get("image_width", 960))
    batches = [todo[start : start + size] for start in range(0, len(todo), size)]
    usage = outcome.usage or Usage(model=cfg.model)

    with open_client(cfg) as http:

        def work(batch: list[tuple[Slide, str, Path]]) -> dict[int, dict[str, Any]] | None:
            images = [image for _, _, path in batch if (image := _prepared(path, width)) is not None]
            if len(images) != len(batch):
                return None
            listing = "\n".join(
                f"{number}. «{slide.title}»: {_clip(slide_text(slide), 200)}" for number, (slide, _, _) in enumerate(batch, start=1)
            )
            answer = ask(
                http,
                system=prompt.get("image_system") or "",
                user=_fill(prompt.get("image_user") or "", {"title": title, "slides": listing}),
                schema=IMAGE_SCHEMA,
                usage=usage,
                label="аудит картинок",
                cfg=cfg,
                images=images,
            )
            if not answer:
                return None
            return {
                item["n"] - 1: {"relevant": bool(item.get("relevant")), "reason": str(item.get("reason") or "")}
                for item in answer.get("slides") or []
                if isinstance(item, dict) and isinstance(item.get("n"), int) and 1 <= item["n"] <= len(batch)
            }

        for batch, found in zip(batches, in_parallel(batches, work, limit=cfg.concurrency)):
            for position, (slide, key, _) in enumerate(batch):
                if found and position in found:
                    cache.images[key] = found[position]
                    outcome.image_reviews[slide.id] = found[position]
                    outcome.images_reviewed += 1
                else:
                    outcome.image_reviews[slide.id] = {"failed": True}
    logger.info("Судья по картинкам: %s слайдов", outcome.images_reviewed)


def cache_payload(cache: ReviewCache, slides: list[Slide], sources: str, render_salt: str) -> dict[str, Any]:
    """Кэш для Variant.review: только вердикты нынешних слайдов, чтобы он не рос бесконечно."""
    text = set(text_keys(slides, cache.judge, sources))
    images = {image_key(slide, cache.judge, render_salt) for slide in slides}
    return {
        "judge": cache.judge,
        "slides": {key: value for key, value in cache.slides.items() if key in text},
        "images": {key: value for key, value in cache.images.items() if key in images},
    }
