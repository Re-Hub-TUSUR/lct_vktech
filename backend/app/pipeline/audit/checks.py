"""Реализации проверок аудита. Метаданные (название, категория, тип, статус) — в каталоге.

Детерминированные проверки работают по данным слайда и шаблона. Контекстуальные
в продукте выполняет VLM по картинке слайда; здесь часть из них заменена
эвристиками (status: heuristic в каталоге), остальные не выполняются (stub).
"""

import re
from collections.abc import Callable, Iterable, Iterator

from app.pipeline.audit.catalog import AuditContext, Finding
from app.pipeline.layout.matcher import text_capacity
from app.pipeline.theme import colors_for, contrast_ratio
from app.schemas.slide import INVERSE_KINDS, Slide

CheckFn = Callable[[list[Slide], AuditContext], Iterable[Finding]]
CHECKS: dict[str, CheckFn] = {}

WORD_RX = re.compile(r"[\w\-–]+", re.UNICODE)
PLACEHOLDER_RX = re.compile(
    r"lorem ipsum|\bTODO\b|\bTBD\b|\b[XxХх]{3,}\b|вставьте текст|текст[- ]заглушк\w*", re.IGNORECASE
)
SERVICE_RX = re.compile(
    r"заметк\w* для спикера|реплик\w* спикера|speaker notes?|\bпромпт\w*|\bprompt\b|"
    r"как (?:языковая )?модель|as an ai|```|</?[a-z]+>",
    re.IGNORECASE,
)
NUMBER_RX = re.compile(r"[×x]?\d+(?:[.,]\d+)?\s?%?")
LATIN_WORD_RX = re.compile(r"\b[A-Za-z]{3,}\b")
CYRILLIC_WORD_RX = re.compile(r"\b[А-Яа-яЁё]{3,}\b")
# Слова на латинице, которые нормальны в русскоязычной деловой колоде.
LATIN_ALLOWED = {"pptx", "pdf", "html", "sla", "kpi", "api", "llm", "vlm", "workspace", "tech", "education"}
# Ёмкость рамки в знаках для макетов разных типов (оценка до появления рендера).
TEXT_CAPACITY = {
    "bullets": 420,
    "agenda": 320,
    "two_columns": 480,
    "cards": 420,
    "image_text": 260,
    "quote": 220,
    "timeline": 360,
    "kpi": 220,
}


def check(check_id: str) -> Callable[[CheckFn], CheckFn]:
    def register(fn: CheckFn) -> CheckFn:
        CHECKS[check_id] = fn
        return fn

    return register


# --- помощники ------------------------------------------------------------------


def bullet_items(slide: Slide) -> Iterator[tuple[str, str]]:
    for i, bullet in enumerate(slide.bullets):
        yield f"bullets.{i}", bullet
    for ci, column in enumerate(slide.columns):
        for bi, bullet in enumerate(column.bullets):
            yield f"columns.{ci}.bullets.{bi}", bullet


def text_items(slide: Slide) -> Iterator[tuple[str, str]]:
    """Все тексты слайда с адресом элемента (для подсветки на фронтенде)."""
    if slide.title:
        yield "title", slide.title
    if slide.subtitle:
        yield "subtitle", slide.subtitle
    yield from bullet_items(slide)
    for ci, column in enumerate(slide.columns):
        if column.title:
            yield f"columns.{ci}.title", column.title
    for i, kpi in enumerate(slide.kpis):
        yield f"kpis.{i}", f"{kpi.value} {kpi.label}"
    for i, item in enumerate(slide.timeline):
        yield f"timeline.{i}", " ".join(filter(None, [item.date, item.title, item.text]))
    if slide.table:
        yield "table", " ".join(slide.table.columns + [cell for row in slide.table.rows for cell in row])
    if slide.chart:
        values = " ".join(f"{v:g}" for series in slide.chart.series for v in series.values)
        parts = [slide.chart.caption or "", *slide.chart.categories, *(s.name for s in slide.chart.series), values]
        yield "chart", " ".join(parts)
    if slide.quote:
        yield "quote", slide.quote.text


def has_body(slide: Slide) -> bool:
    return bool(
        slide.bullets
        or any(column.bullets for column in slide.columns)
        or slide.chart
        or slide.table
        or slide.kpis
        or slide.timeline
        or slide.quote
        or slide.image
    )


def body_chars(slide: Slide) -> int:
    return sum(len(text) for target, text in text_items(slide) if target not in {"title", "subtitle"})


def normalize(text: str) -> str:
    return re.sub(r"\W+", " ", text.lower()).strip()


def words(text: str) -> int:
    return len(WORD_RX.findall(text))


# --- Вёрстка -----------------------------------------------------------------------


@check("layout.text_overflow")
def text_overflow(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    default_title = int(ctx.limits.get("max_title_chars", 100))
    for slide in slides:
        pattern = ctx.patterns.get(slide.pattern_id or "")
        if pattern is not None:
            # Слайд собран из слайда-примера шаблона: ёмкость — по его слотам (с запасом на автоподбор кегля).
            title_chars, body_capacity = text_capacity(slide, pattern)
            max_title = min(default_title, int(title_chars * 1.2)) if title_chars else default_title
            capacity = int(body_capacity * 1.2) or None
            frame = f"слоты паттерна {pattern['id']}"
        else:
            max_title, capacity, frame = default_title, TEXT_CAPACITY.get(slide.kind), "рамку макета"
        if len(slide.title) > max_title:
            yield Finding(
                "layout.text_overflow",
                slide.id,
                "title",
                f"Заголовок из {len(slide.title)} знаков не помещается в рамку (≈{max_title})",
                slide.title,
            )
        chars = body_chars(slide)
        if capacity and chars > capacity:
            target = "columns" if slide.kind in {"two_columns", "cards"} else "bullets" if slide.bullets else "slide"
            yield Finding(
                "layout.text_overflow",
                slide.id,
                target,
                f"Текст ≈{chars} знаков не помещается в {frame} (ёмкость ≈{capacity})",
            )


# --- Шаблон ------------------------------------------------------------------------


@check("template.layout_from_template")
def layout_from_template(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        if not slide.layout_key or slide.layout_key not in ctx.layout_keys:
            yield Finding(
                "template.layout_from_template",
                slide.id,
                "slide",
                f"Макет «{slide.layout_name or slide.layout_key or '—'}» не найден в шаблоне",
            )


@check("template.contrast")
def contrast(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    body_min = float(ctx.limits.get("min_contrast", 4.5))
    large_min = float(ctx.limits.get("min_contrast_large", 3.0))
    for slide in slides:
        bg, fg = colors_for(ctx.theme, slide.kind, slide.layout_key)
        # На обложке, разделителе и финале только крупный текст — для него порог ниже.
        minimum = large_min if slide.kind in INVERSE_KINDS else body_min
        ratio = contrast_ratio(fg, bg)
        if ratio < minimum:
            yield Finding(
                "template.contrast",
                slide.id,
                "slide",
                f"Контраст текста {fg} к фону {bg} — {ratio:.2f}:1, нужно не ниже {minimum:g}:1",
            )


# --- Плотность ---------------------------------------------------------------------


@check("density.max_bullets")
def max_bullets(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    limit = int(ctx.limits.get("max_bullets", 6))
    for slide in slides:
        total = sum(1 for _ in bullet_items(slide))
        if total > limit:
            target = "columns" if slide.columns else "bullets"
            yield Finding("density.max_bullets", slide.id, target, f"На слайде {total} тезисов — больше {limit}")


@check("density.bullet_words")
def bullet_words(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    limit = int(ctx.limits.get("max_bullet_words", 15))
    for slide in slides:
        for target, text in bullet_items(slide):
            count = words(text)
            if count > limit:
                yield Finding(
                    "density.bullet_words", slide.id, target, f"Тезис из {count} слов — длиннее {limit}", text
                )


@check("density.table_size")
def table_size(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    max_rows = int(ctx.limits.get("max_table_rows", 7))
    max_cols = int(ctx.limits.get("max_table_cols", 5))
    for slide in slides:
        if slide.table is None:
            continue
        rows, cols = len(slide.table.rows), len(slide.table.columns)
        if rows > max_rows or cols > max_cols:
            yield Finding(
                "density.table_size",
                slide.id,
                "table",
                f"Таблица {rows}×{cols} — больше {max_rows} строк или {max_cols} колонок",
            )


@check("density.chart_series")
def chart_series(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    limit = int(ctx.limits.get("max_chart_series", 5))
    for slide in slides:
        if slide.chart and len(slide.chart.series) > limit:
            yield Finding(
                "density.chart_series",
                slide.id,
                "chart",
                f"На диаграмме {len(slide.chart.series)} серий — больше {limit}",
            )


# --- Целостность -------------------------------------------------------------------


@check("integrity.placeholder_text")
def placeholder_text(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        for target, text in text_items(slide):
            match = PLACEHOLDER_RX.search(text)
            if match:
                yield Finding(
                    "integrity.placeholder_text", slide.id, target, f"Текст-заглушка «{match.group(0)}»", text
                )


@check("integrity.empty_slide")
def empty_slide(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        if slide.kind not in INVERSE_KINDS and not has_body(slide):
            yield Finding("integrity.empty_slide", slide.id, "slide", "На слайде только заголовок")


@check("integrity.chart_labels")
def chart_labels(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        chart = slide.chart
        if chart is None:
            continue
        missing = []
        if not chart.unit and chart.type != "pie":
            missing.append("единицы измерения")
        if not chart.categories:
            missing.append("подписи категорий")
        if len(chart.series) > 1 and any(not s.name for s in chart.series):
            missing.append("легенда")
        if missing:
            yield Finding("integrity.chart_labels", slide.id, "chart", "У диаграммы нет: " + ", ".join(missing))


@check("integrity.duplicates")
def duplicates(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    seen: dict[str, int] = {}
    for index, slide in enumerate(slides):
        signature = normalize(" ".join(text for _, text in text_items(slide)))
        if not signature:
            continue
        if signature in seen:
            yield Finding(
                "integrity.duplicates", slide.id, "slide", f"Слайд повторяет слайд №{seen[signature] + 1}"
            )
        else:
            seen[signature] = index


# --- Содержание (эвристики вместо VLM) ---------------------------------------------


@check("content.title_is_insight")
def title_is_insight(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        if slide.kind in INVERSE_KINDS or slide.kind == "agenda" or not slide.title:
            continue
        if words(slide.title) <= 3:
            yield Finding(
                "content.title_is_insight",
                slide.id,
                "title",
                f"«{slide.title}» — тема, а не вывод: из заголовка непонятно, что следует из слайда",
                slide.title,
            )


def _number_key(raw: str) -> str:
    return raw.replace(" ", "").replace(",", ".").lstrip("×x").rstrip("%").rstrip(".")


def _is_trivial(key: str) -> bool:
    try:
        value = float(key)
    except ValueError:
        return True
    # Маленькие числа (шаги, количества) и годы не считаем фактами.
    return value <= 10 or (1990 <= value <= 2100 and value.is_integer())


@check("content.facts_grounded")
def facts_grounded(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    source_numbers = {_number_key(m) for m in NUMBER_RX.findall(ctx.sources_text or "")}
    for slide in slides:
        if slide.kind in {"title", "closing"}:
            continue
        missing: list[str] = []
        first_target = None
        for target, text in text_items(slide):
            for raw in NUMBER_RX.findall(text):
                key = _number_key(raw)
                if _is_trivial(key) or key in source_numbers or raw.strip() in missing:
                    continue
                missing.append(raw.strip())
                first_target = first_target or target
        if missing:
            shown = ", ".join(missing[:5]) + (" …" if len(missing) > 5 else "")
            yield Finding(
                "content.facts_grounded",
                slide.id,
                first_target,
                f"Цифры не найдены в брифе и контент-пакете: {shown}",
                shown,
            )


@check("content.service_text")
def service_text(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        for target, text in text_items(slide):
            match = SERVICE_RX.search(text)
            if match:
                yield Finding(
                    "content.service_text", slide.id, target, f"Служебный текст на слайде: «{match.group(0)}»", text
                )


@check("content.single_language")
def single_language(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        text = " ".join(t for _, t in text_items(slide))
        latin = [w for w in LATIN_WORD_RX.findall(text) if w.lower() not in LATIN_ALLOWED and not w.isupper()]
        cyrillic = CYRILLIC_WORD_RX.findall(text)
        if ctx.language == "ru" and len(latin) >= 4 and len(latin) > 0.3 * (len(latin) + len(cyrillic)):
            yield Finding(
                "content.single_language", slide.id, "slide", f"Много слов на латинице: {', '.join(latin[:4])}"
            )
        elif ctx.language == "en" and len(cyrillic) >= 3:
            yield Finding(
                "content.single_language", slide.id, "slide", f"Кириллица в англоязычной колоде: {', '.join(cyrillic[:4])}"
            )
