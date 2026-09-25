"""Проверки аудита по данным слайда и контекстуальные проверки по вердиктам модели-судьи.

Метаданные (название, категория, способ проверки) — в каталоге skills/auditor.yaml. Проверки по
рендеру — в audit/geometry.py. Контекстуальные читают вердикты судьи (audit/review.py) из
контекста; у слайда без вердикта (модель не подключена или не ответила) работает запасное
правило, если оно есть: короткий заголовок — тема, числа ищутся в материалах, служебные маркеры,
доля латиницы.
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


def verdict(ctx: AuditContext, slide: Slide) -> dict | None:
    """Вердикт судьи по слайду; None — вердикта нет, работает запасное правило."""
    found = ctx.reviews.get(slide.id)
    return found if found and not found.get("failed") else None


def clean(text: object) -> str:
    return " ".join(str(text or "").split())


def locate(slide: Slide, fragment: str) -> str | None:
    """Адрес элемента слайда, где встречается фрагмент (без учёта регистра и пунктуации)."""
    needle = normalize(fragment)
    if not needle:
        return None
    for target, text in text_items(slide):
        if needle in normalize(text):
            return target
    return None


# --- Вёрстка -----------------------------------------------------------------------


def text_overflow_estimate(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    """Запасное правило layout.text_overflow без рендера: объём текста против ёмкости рамки."""
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


# --- Содержание (модель-судья, запасные правила) ----------------------------------------

CONTENT_EXEMPT = INVERSE_KINDS | {"agenda"}


@check("content.title_is_insight")
def title_is_insight(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        if slide.kind in CONTENT_EXEMPT or not slide.title:
            continue
        found = verdict(ctx, slide)
        if found is not None:
            if found.get("title_is_topic"):
                better = clean(found.get("better_title"))
                yield Finding(
                    "content.title_is_insight",
                    slide.id,
                    "title",
                    f"«{slide.title}» — тема, а не вывод" + (f". Вывод из содержимого: «{better}»" if better else ""),
                    better or None,
                )
        elif words(slide.title) <= 3:
            yield Finding(
                "content.title_is_insight",
                slide.id,
                "title",
                f"«{slide.title}» — тема, а не вывод: из заголовка непонятно, что следует из слайда",
            )


@check("content.matches_title")
def matches_title(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        found = verdict(ctx, slide)
        if slide.kind in CONTENT_EXEMPT or found is None or not found.get("content_mismatch"):
            continue
        better = clean(found.get("better_title"))
        yield Finding(
            "content.matches_title",
            slide.id,
            "title",
            f"Содержимое не подтверждает заголовок «{slide.title}»"
            + (f". Из содержимого следует: «{better}»" if better else ""),
            better or None,
        )


@check("content.one_sentence")
def one_sentence(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        found = verdict(ctx, slide)
        if slide.kind in CONTENT_EXEMPT or found is None or clean(found.get("summary")):
            continue
        yield Finding(
            "content.one_sentence",
            slide.id,
            "slide",
            "Главную мысль слайда не удаётся пересказать одним предложением — на слайде несколько тем",
        )


def _number_key(raw: str) -> str:
    """Число без оформления: «1 250», «42.0», «×96», «40%» → «1250», «42», «96», «40»."""
    key = raw.replace(" ", "").replace("\u00a0", "").replace(",", ".").lstrip("×x").rstrip("%").rstrip(".")
    try:
        return f"{float(key):g}"
    except ValueError:
        return key


TRIPLE_SUM_LIMIT = 15
# Пересчёт единиц: часы в минуты, сутки в часы, недели в дни, годы в месяцы, доли в проценты, тысячи.
UNIT_FACTORS = (60, 24, 7, 12, 100, 1000)


def _numbers(keys: set[str]) -> list[float]:
    values = []
    for key in keys:
        try:
            values.append(float(key))
        except ValueError:
            continue
    return sorted(set(values))[:60]


def derivable(value: float, numbers: list[float]) -> bool:
    """Число получается из чисел материалов: сумма двух-трёх, разность, отношение, прирост в процентах."""
    close = lambda a, b: abs(a - b) <= max(0.011 * abs(b), 0.051)  # noqa: E731 — округление при пересчёте
    if any(close(value, a * k) or close(value, a / k) for a in numbers for k in UNIT_FACTORS):
        return True  # «8 часов» на слайде стали «480 минутами»
    for i, a in enumerate(numbers):
        for b in numbers[i + 1 :]:
            if close(value, a + b) or close(value, b - a) or (a and close(value, b / a)):
                return True
            if a and close(value, (b - a) / a * 100):
                return True
            # Итог из трёх слагаемых («всего 84 = 42 + 27 + 15») — только для короткого списка чисел,
            # иначе суммой троек объясняется почти любое число.
            if len(numbers) <= TRIPLE_SUM_LIMIT:
                for c in numbers[numbers.index(b) + 1 :]:
                    if close(value, a + b + c):
                        return True
    return False


def _is_trivial(key: str) -> bool:
    try:
        value = float(key)
    except ValueError:
        return True
    # Маленькие числа (шаги, количества) и годы не считаем фактами.
    return value <= 10 or (1990 <= value <= 2100 and value.is_integer())


@check("content.facts_grounded")
def facts_grounded(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    """Числа ищутся в полном тексте материалов (правило), факты сверяет судья по брифу и выдержкам."""
    source_numbers = {_number_key(m) for m in NUMBER_RX.findall(ctx.sources_text or "")}
    values = _numbers(source_numbers)
    for slide in slides:
        if slide.kind in {"title", "closing"}:
            continue
        missing: list[str] = []
        first_target = None
        for target, text in text_items(slide):
            for raw in NUMBER_RX.findall(text):
                key = _number_key(raw)
                if _is_trivial(key) or key in source_numbers or raw.strip() in missing or derivable(float(key), values):
                    continue
                missing.append(raw.strip())
                first_target = first_target or target
        claims: list[str] = []
        found = verdict(ctx, slide)
        for claim in (found or {}).get("unsupported") or []:
            claim = clean(claim)
            target = locate(slide, claim)
            numbers = [_number_key(raw) for raw in NUMBER_RX.findall(claim)]
            # Судья видит только выдержку материалов: число, которое есть в полном тексте, — подтверждено.
            if numbers and all(key in source_numbers or _is_trivial(key) for key in numbers):
                continue
            # Факт должен быть на слайде: иначе судья пересказал своё, и показывать нечего.
            if claim and (target or any(raw.strip() in missing for raw in NUMBER_RX.findall(claim))):
                claims.append(claim)
                first_target = first_target or target
        items = claims + [number for number in missing if not any(number in claim for claim in claims)]
        if items:
            shown = "; ".join(items[:5]) + (" …" if len(items) > 5 else "")
            yield Finding(
                "content.facts_grounded",
                slide.id,
                first_target,
                f"Не найдено в брифе и контент-пакете: {shown}",
                shown,
            )


@check("content.service_text")
def service_text(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        seen: set[str] = set()
        for target, text in text_items(slide):
            match = SERVICE_RX.search(text)
            if match:
                seen.add(normalize(text))
                yield Finding(
                    "content.service_text", slide.id, target, f"Служебный текст на слайде: «{match.group(0)}»", text
                )
        for fragment in (verdict(ctx, slide) or {}).get("service") or []:
            fragment = clean(fragment)
            target = locate(slide, fragment)
            if target and normalize(fragment) not in seen:
                seen.add(normalize(fragment))
                yield Finding(
                    "content.service_text", slide.id, target, f"Служебный текст на слайде: «{fragment[:60]}»", fragment
                )


@check("content.typos")
def typos(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        for typo in (verdict(ctx, slide) or {}).get("typos") or []:
            wrong, right = clean((typo or {}).get("wrong")), clean((typo or {}).get("right"))
            if not wrong or not right or wrong.lower() == right.lower():
                continue
            target = next(
                (t for t, text in text_items(slide) if re.search(rf"(?<!\w){re.escape(wrong)}(?!\w)", text, re.IGNORECASE)),
                None,
            )
            if target:
                yield Finding("content.typos", slide.id, target, f"Опечатка: «{wrong}» → «{right}»", f"{wrong} → {right}")


@check("content.table_relevance")
def table_relevance(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        for item in (verdict(ctx, slide) or {}).get("irrelevant") or []:
            item = clean(item)
            key = normalize(item)
            if not key:
                continue
            if slide.table and any(row and normalize(row[0]) == key for row in slide.table.rows):
                yield Finding("content.table_relevance", slide.id, "table", f"Строка «{item}» не работает на вывод слайда", item)
            elif slide.chart and any(normalize(name) == key for name in slide.chart.categories):
                yield Finding("content.table_relevance", slide.id, "chart", f"Категория «{item}» не работает на вывод слайда", item)
            elif slide.chart and len(slide.chart.series) > 1 and any(normalize(s.name) == key for s in slide.chart.series):
                yield Finding("content.table_relevance", slide.id, "chart", f"Ряд «{item}» не работает на вывод слайда", item)


@check("content.logical_flow")
def logical_flow(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for index, slide in enumerate(slides):
        if index == 0 or slide.kind in {"title", "section"}:
            continue
        found = verdict(ctx, slide)
        if found and found.get("flow_break"):
            yield Finding(
                "content.logical_flow",
                slide.id,
                "slide",
                f"Слайд не продолжает мысль предыдущего («{slides[index - 1].title}») и выпадает из темы колоды",
            )


@check("content.images_relevant")
def images_relevant(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        found = ctx.image_reviews.get(slide.id)
        if found and not found.get("failed") and found.get("relevant") is False:
            reason = clean(found.get("reason"))
            yield Finding(
                "content.images_relevant",
                slide.id,
                "image",
                "Картинка не относится к теме слайда" + (f": {reason}" if reason else ""),
            )


@check("content.single_language")
def single_language(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide in slides:
        found = verdict(ctx, slide)
        if found is not None:
            fragments = [clean(item) for item in found.get("foreign") or [] if locate(slide, clean(item))]
            if fragments:
                shown = "; ".join(fragments[:4])
                yield Finding(
                    "content.single_language", slide.id, locate(slide, fragments[0]), f"Не на языке колоды: {shown}", shown
                )
            continue
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
