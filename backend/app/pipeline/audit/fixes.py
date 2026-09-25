"""Автоисправления найденных проблем.

Два пути. Правки, для которых нужен новый текст (сократить тезис, переписать без выдуманных
фактов, сфокусировать слайд, связать с соседними), пишет модель: планировщик правки
(planning/editor.py) получает слайд, инструкцию из каталога (fix_prompt) и ёмкость слотов
паттерна — apply_editor_fixes. Остальное — детерминированные правки данных слайда: удалить
заглушку или служебную фразу, поставить заголовок, который предложил судья, исправить опечатку,
убрать лишнюю строку таблицы, разбить слайд — apply_fixes. Без модели правки текста делают
простые правила с тем же контрактом.
"""

import copy
import logging
import re
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from app.pipeline.ai.llm import in_parallel, llm_enabled
from app.pipeline.audit.catalog import CheckInfo
from app.pipeline.audit.checks import PLACEHOLDER_RX, SERVICE_RX, WORD_RX, bullet_items, normalize
from app.pipeline.planning.editor import EditError, edit_slide
from app.schemas.slide import Slide, new_slide_id

logger = logging.getLogger(__name__)


@dataclass
class IssueRef:
    """Минимум данных о проблеме, нужный исправлению."""

    id: str
    check_id: str
    slide_id: str | None
    target: str | None
    evidence: str | None
    message: str | None = None


@dataclass
class FixContext:
    limits: dict[str, Any]
    content_layout_key: str | None = None
    content_layout_name: str | None = None


@dataclass
class EditorContext:
    """Контекст колоды для правок моделью."""

    title: str
    purpose: str
    brief: str
    sources: str
    language: str = "ru"
    tone: str = "business"
    audience: str = ""
    patterns: dict[str, dict[str, Any]] = field(default_factory=dict)


FixFn = Callable[[list[Slide], int, IssueRef, FixContext], list[Slide] | None]
FIXES: dict[str, FixFn] = {}
# Порядок применения: сначала правки текста, потом структура, в конце удаление слайдов.
FIX_ORDER = [
    "integrity.placeholder_text",
    "content.service_text",
    "content.typos",
    "density.bullet_words",
    "content.title_is_insight",
    "content.matches_title",
    "content.table_relevance",
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
    slide = slides[index]
    if _remove_text(slide, issue.evidence, SERVICE_RX):
        return slides
    # Фраза, которую нашёл судья, — часть тезиса: вырезается только она.
    return slides if issue.evidence and _remove_fragment(slide, issue.evidence) else None


@fix("density.bullet_words")
def shorten_bullet(slides, index, issue, ctx):
    limit = int(ctx.limits.get("max_bullet_words", 15))
    for bullets in _bullet_lists(slides[index]):
        for i, bullet in enumerate(bullets):
            if bullet == issue.evidence:
                bullets[i] = shorten(bullet, limit)
                return slides
    return None


def _replace_everywhere(slide: Slide, pattern: re.Pattern[str], replace: Callable[[re.Match[str]], str]) -> bool:
    """Замена во всех текстах слайда. True — что-то заменилось."""
    changed = False

    def apply(text: str | None) -> str | None:
        nonlocal changed
        if not text:
            return text
        result = pattern.sub(replace, text)
        changed = changed or result != text
        return result

    slide.title = apply(slide.title) or slide.title
    slide.subtitle = apply(slide.subtitle)
    slide.bullets = [apply(b) or b for b in slide.bullets]
    for column in slide.columns:
        column.title = apply(column.title) or column.title
        column.bullets = [apply(b) or b for b in column.bullets]
    for kpi in slide.kpis:
        kpi.label = apply(kpi.label) or kpi.label
    for item in slide.timeline:
        item.title = apply(item.title) or item.title
        item.text = apply(item.text)
    if slide.table:
        slide.table.columns = [apply(c) or c for c in slide.table.columns]
        slide.table.rows = [[apply(c) or c for c in row] for row in slide.table.rows]
    if slide.chart:
        slide.chart.caption = apply(slide.chart.caption)
        slide.chart.categories = [apply(c) or c for c in slide.chart.categories]
    if slide.quote:
        slide.quote.text = apply(slide.quote.text) or slide.quote.text
    return changed


@fix("content.typos")
def fix_typo(slides, index, issue, ctx):
    wrong, _, right = (issue.evidence or "").partition(" → ")
    if not wrong or not right:
        return None

    def keep_case(match: re.Match[str]) -> str:
        found = match.group(0)
        return right[:1].upper() + right[1:] if found[:1].isupper() else right

    pattern = re.compile(rf"(?<!\w){re.escape(wrong)}(?!\w)", re.IGNORECASE)
    return slides if _replace_everywhere(slides[index], pattern, keep_case) else None


def _remove_fragment(slide: Slide, fragment: str) -> bool:
    """Вырезает фразу из текстов слайда; тезис, от которого ничего не осталось, удаляется."""
    pattern = re.compile(r"\s*" + r"\s+".join(re.escape(word) for word in fragment.split()) + r"[\s.,;:—-]*", re.IGNORECASE)
    if not fragment.strip() or not _replace_everywhere(slide, pattern, lambda _: " "):
        return False
    for bullets in _bullet_lists(slide):
        bullets[:] = [" ".join(b.split()).strip(" ,;:—-") for b in bullets if len(normalize(b)) >= 3]
    slide.title = " ".join(slide.title.split()).strip(" ,;:—-") or slide.summary or slide.title
    return True


@fix("content.table_relevance")
def drop_irrelevant(slides, index, issue, ctx):
    slide, key = slides[index], normalize(issue.evidence or "")
    if not key:
        return None
    if slide.table and issue.target == "table":
        rows = [row for row in slide.table.rows if not (row and normalize(row[0]) == key)]
        if len(rows) != len(slide.table.rows) and rows:
            slide.table.rows = rows
            return slides
    chart = slide.chart
    if chart and issue.target == "chart":
        if key in [normalize(c) for c in chart.categories] and len(chart.categories) > 2:
            position = [normalize(c) for c in chart.categories].index(key)
            del chart.categories[position]
            for series in chart.series:
                if position < len(series.values):
                    del series.values[position]
            if chart.highlight is not None:
                chart.highlight = None if chart.highlight == position else chart.highlight - (chart.highlight > position)
            return slides
        series = [s for s in chart.series if normalize(s.name) != key]
        if series and len(series) != len(chart.series):
            chart.series = series
            return slides
    return None


def _set_title(slide: Slide, title: str) -> None:
    slide.title = title
    slide.summary = title  # заголовок-вывод — и есть главная мысль слайда


@fix("content.matches_title")
def retitle(slides, index, issue, ctx):
    if not issue.evidence:
        return None
    _set_title(slides[index], issue.evidence)
    return slides


@fix("content.title_is_insight")
def rewrite_title(slides, index, issue, ctx):
    slide = slides[index]
    if issue.evidence:
        # Заголовок-вывод, который предложил судья по содержимому слайда.
        _set_title(slide, issue.evidence)
        return slides
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


def editor_issues(issues: list[IssueRef], catalog: dict[str, CheckInfo]) -> list[IssueRef]:
    """Проблемы, которые исправляет модель: у проверки editor: true, а готового ответа (заголовка от
    судьи) нет. Без модели — ни одной: работают правила."""
    if not llm_enabled():
        return []
    ready = {"content.title_is_insight", "content.matches_title"}
    return [
        issue
        for issue in issues
        if (check := catalog.get(issue.check_id)) is not None
        and check.editor
        and check.fix_prompt
        and not (issue.check_id in ready and issue.evidence)
    ]


def instruction_for(issues: list[IssueRef], slide: Slide, catalog: dict[str, CheckInfo], limits: dict[str, Any]) -> str:
    lines = []
    for issue in issues:
        template = catalog[issue.check_id].fix_prompt or ""
        values = {
            "message": issue.message or "",
            "evidence": issue.evidence or "",
            "title": slide.title,
            "max_bullet_words": str(limits.get("max_bullet_words", 15)),
        }
        for key, value in values.items():
            template = template.replace("{" + key + "}", value)
        if template not in lines:
            lines.append(template)
    if len(lines) == 1:
        return lines[0]
    return "Исправь на слайде:\n" + "\n".join(f"{number}. {line}" for number, line in enumerate(lines, start=1))


def apply_editor_fixes(
    slides: list[Slide],
    issues: list[IssueRef],
    catalog: dict[str, CheckInfo],
    ctx: EditorContext,
    limits: dict[str, Any],
) -> tuple[list[Slide], list[str]]:
    """Правки моделью: по одному запросу на слайд со всеми его проблемами. Вызывать в потоке."""
    slides = [slide.model_copy(deep=True) for slide in slides]
    by_slide: dict[str, list[IssueRef]] = defaultdict(list)
    for issue in issues:
        if issue.slide_id:
            by_slide[issue.slide_id].append(issue)
    targets = [slide for slide in slides if slide.id in by_slide]

    def work(slide: Slide) -> Slide | None:
        try:
            result = edit_slide(
                slide,
                instruction_for(by_slide[slide.id], slide, catalog, limits),
                deck=slides,
                title=ctx.title,
                purpose=ctx.purpose,
                brief=ctx.brief,
                sources=ctx.sources,
                language=ctx.language,
                tone=ctx.tone,
                audience=ctx.audience,
                pattern=ctx.patterns.get(slide.pattern_id or ""),
            )
        except EditError as exc:
            logger.warning("Правка слайда %s моделью не удалась: %s", slide.id, exc)
            return None
        return result.slide

    applied: list[str] = []
    edited = dict(zip((slide.id for slide in targets), in_parallel(targets, work)))
    for position, slide in enumerate(slides):
        if (new := edited.get(slide.id)) is not None:
            slides[position] = new
            applied += [issue.id for issue in by_slide[slide.id]]
    return slides, applied


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
