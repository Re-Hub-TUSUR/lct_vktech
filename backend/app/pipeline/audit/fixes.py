"""Автоисправления найденных проблем.

Сейчас это детерминированные правки данных слайда. Контекстуальные исправления
(переписать заголовок как вывод, сократить тезис) в продукте делает LLM; здесь
они заменены простыми правилами с тем же контрактом.
"""

import copy
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.pipeline.audit.checks import PLACEHOLDER_RX, SERVICE_RX, WORD_RX, bullet_items
from app.schemas.slide import Slide, new_slide_id


@dataclass
class IssueRef:
    """Минимум данных о проблеме, нужный исправлению."""

    id: str
    check_id: str
    slide_id: str | None
    target: str | None
    evidence: str | None


@dataclass
class FixContext:
    limits: dict[str, Any]
    content_layout_key: str | None = None
    content_layout_name: str | None = None


FixFn = Callable[[list[Slide], int, IssueRef, FixContext], list[Slide] | None]
FIXES: dict[str, FixFn] = {}
# Порядок применения: сначала правки текста, потом структура, в конце удаление слайдов.
FIX_ORDER = [
    "integrity.placeholder_text",
    "content.service_text",
    "density.bullet_words",
    "content.title_is_insight",
    "integrity.chart_labels",
    "density.table_size",
    "density.chart_series",
    "template.layout_from_template",
    "layout.text_overflow",
    "density.max_bullets",
    "integrity.empty_slide",
    "integrity.duplicates",
]


def fix(check_id: str) -> Callable[[FixFn], FixFn]:
    def register(fn: FixFn) -> FixFn:
        FIXES[check_id] = fn
        return fn

    return register


def shorten(text: str, limit: int = 15) -> str:
    """Сокращает тезис: до первой смысловой границы или до limit слов."""
    if len(WORD_RX.findall(text)) <= limit:
        return text
    for separator in (" — ", ", ", "; ", ": "):
        head = text.split(separator)[0].strip()
        if 3 <= len(WORD_RX.findall(head)) <= limit:
            return head.rstrip(".,;:")
    return " ".join(text.split()[:limit]).rstrip(".,;:")


def _bullet_lists(slide: Slide) -> list[list[str]]:
    return [slide.bullets, *(column.bullets for column in slide.columns)]


def _remove_text(slide: Slide, evidence: str | None, pattern: re.Pattern[str]) -> bool:
    """Удаляет тезис с найденным текстом или вычищает фрагмент из заголовка."""
    for bullets in _bullet_lists(slide):
        for i, bullet in enumerate(bullets):
            if bullet == evidence or (evidence is None and pattern.search(bullet)):
                del bullets[i]
                return True
    if slide.title and pattern.search(slide.title):
        cleaned = pattern.sub("", slide.title).strip(" :—-")
        slide.title = cleaned or slide.summary or slide.title
        return True
    if slide.subtitle and pattern.search(slide.subtitle):
        slide.subtitle = pattern.sub("", slide.subtitle).strip(" :—-") or None
        return True
    return False


@fix("integrity.placeholder_text")
def remove_placeholder(slides, index, issue, ctx):
    return slides if _remove_text(slides[index], issue.evidence, PLACEHOLDER_RX) else None


@fix("content.service_text")
def remove_service_text(slides, index, issue, ctx):
    return slides if _remove_text(slides[index], issue.evidence, SERVICE_RX) else None


@fix("density.bullet_words")
def shorten_bullet(slides, index, issue, ctx):
    limit = int(ctx.limits.get("max_bullet_words", 15))
    for bullets in _bullet_lists(slides[index]):
        for i, bullet in enumerate(bullets):
            if bullet == issue.evidence:
                bullets[i] = shorten(bullet, limit)
                return slides
    return None


@fix("content.title_is_insight")
def rewrite_title(slides, index, issue, ctx):
    slide = slides[index]
    if slide.summary and slide.summary != slide.title:
        slide.title = slide.summary
        return slides
    first = next((text for _, text in bullet_items(slide)), None)
    if first:
        slide.title = f"{slide.title}: {shorten(first, 8)}"
        return slides
    return None


@fix("integrity.chart_labels")
def add_chart_labels(slides, index, issue, ctx):
    chart = slides[index].chart
    if chart is None:
        return None
    if not chart.unit:
        # Единицы из подписи «…, ч» в заголовке или подписи диаграммы, иначе — нейтральные.
        source = chart.caption or slides[index].title
        match = re.search(r",\s*([^,]{1,12})$", source or "")
        chart.unit = match.group(1).strip() if match else "ед."
    for number, series in enumerate(chart.series, start=1):
        series.name = series.name or f"Серия {number}"
    if not chart.categories:
        length = max((len(s.values) for s in chart.series), default=0)
        chart.categories = [str(i) for i in range(1, length + 1)]
    return slides


@fix("density.table_size")
def trim_table(slides, index, issue, ctx):
    table = slides[index].table
    if table is None:
        return None
    max_rows = int(ctx.limits.get("max_table_rows", 7))
    max_cols = int(ctx.limits.get("max_table_cols", 5))
    table.columns = table.columns[:max_cols]
    table.rows = [row[:max_cols] for row in table.rows[:max_rows]]
    return slides


@fix("density.chart_series")
def trim_series(slides, index, issue, ctx):
    chart = slides[index].chart
    if chart is None:
        return None
    chart.series = chart.series[: int(ctx.limits.get("max_chart_series", 5))]
    return slides


@fix("template.layout_from_template")
def assign_content_layout(slides, index, issue, ctx):
    if not ctx.content_layout_key:
        return None
    slides[index].layout_key = ctx.content_layout_key
    slides[index].layout_name = ctx.content_layout_name
    return slides


@fix("layout.text_overflow")
def fit_text(slides, index, issue, ctx):
    slide = slides[index]
    if issue.target == "title":
        slide.title = shorten(slide.summary or slide.title, 10)
        return slides
    for bullets in _bullet_lists(slide):
        del bullets[4:]
        bullets[:] = [shorten(bullet, 12) for bullet in bullets]
    return slides


@fix("density.max_bullets")
def split_slide(slides, index, issue, ctx):
    slide = slides[index]
    limit = int(ctx.limits.get("max_bullets", 6))
    if slide.columns:
        per_column = max(1, limit // max(len(slide.columns), 1))
        for column in slide.columns:
            del column.bullets[per_column:]
        return slides
    if len(slide.bullets) <= limit:
        return None
    half = (len(slide.bullets) + 1) // 2
    continuation = copy.deepcopy(slide)
    continuation.id = new_slide_id()
    continuation.title = f"{slide.title} (продолжение)"
    continuation.bullets = slide.bullets[half:]
    slide.bullets = slide.bullets[:half]
    slides.insert(index + 1, continuation)
    return slides


@fix("integrity.empty_slide")
def drop_empty_slide(slides, index, issue, ctx):
    del slides[index]
    return slides


@fix("integrity.duplicates")
def drop_duplicate(slides, index, issue, ctx):
    del slides[index]
    return slides


def apply_fixes(slides: list[Slide], issues: list[IssueRef], ctx: FixContext) -> tuple[list[Slide], list[str]]:
    """Применяет исправления по порядку FIX_ORDER. Возвращает слайды и id применённых проблем."""
    slides = [slide.model_copy(deep=True) for slide in slides]
    applied: list[str] = []
    rank = {check_id: i for i, check_id in enumerate(FIX_ORDER)}
    for issue in sorted(issues, key=lambda item: rank.get(item.check_id, len(rank))):
        fn = FIXES.get(issue.check_id)
        index = next((i for i, slide in enumerate(slides) if slide.id == issue.slide_id), None)
        if fn is None or index is None:
            continue
        result = fn(slides, index, issue, ctx)
        if result is not None:
            slides = result
            applied.append(issue.id)
    return slides, applied
