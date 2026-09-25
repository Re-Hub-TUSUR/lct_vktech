"""Визуализация данных слайдов: правила, по которым диаграммы, таблицы, KPI и таймлайны становятся читаемыми.

Модель пишет данные и называет ключевую категорию, но не решает, как их показать: тип диаграммы,
порядок категорий, акцент, округление и объём задаются правилами (skills/visualizer.yaml) — одинаково
для любого шаблона и воспроизводимо. Слайды меняются на месте; после правил подбор паттернов
перепроверяется, потому что тип диаграммы или число элементов могли измениться.
"""

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from app.pipeline.layout.matcher import assign_patterns
from app.pipeline.skills import get_skill
from app.schemas.slide import ChartData, ChartSeries, Kpi, Slide, TableData, TimelineItem

# Что поменяли правила — для подписи стадии генерации.
CHANGE_LABELS = {
    "retyped": "тип диаграммы по данным",
    "sorted": "сортировка",
    "highlighted": "акцент на ключевом значении",
    "rounded": "округление",
    "unit": "единицы из подписи",
    "trimmed": "объём в пределах лимитов",
    "ordered": "этапы по порядку",
}
PERCENT_RX = re.compile(r"%|процент", re.IGNORECASE)
UNIT_IN_CAPTION_RX = re.compile(r",\s*([^,]{1,12})$")
YEAR_RX = re.compile(r"(19|20)\d{2}")
QUARTER_RX = re.compile(r"q\s*([1-4])|([1-4])\s*кв|кв\.?\s*([1-4])", re.IGNORECASE)
MONTHS = ("янв", "фев", "мар", "апр", "ма", "июн", "июл", "авг", "сен", "окт", "ноя", "дек")


@dataclass
class VisualsReport:
    charts: int = 0
    tables: int = 0
    kpis: int = 0
    timelines: int = 0
    changes: Counter[str] = field(default_factory=Counter)

    def merge(self, other: "VisualsReport") -> "VisualsReport":
        self.charts += other.charts
        self.tables += other.tables
        self.kpis += other.kpis
        self.timelines += other.timelines
        self.changes.update(other.changes)
        return self

    def detail(self) -> str:
        parts = [
            f"Диаграмм: {self.charts}",
            f"таблиц: {self.tables}",
            f"KPI-блоков: {self.kpis}",
            f"таймлайнов: {self.timelines}",
        ]
        applied = [f"{label} — {self.changes[key]}" for key, label in CHANGE_LABELS.items() if self.changes[key]]
        return " · ".join(parts) + (f" · правила: {', '.join(applied)}" if applied else "")


def _params() -> dict[str, Any]:
    return get_skill("visualizer").params


def _clean(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _temporal(categories: list[str], rx: re.Pattern[str]) -> bool:
    return bool(categories) and all(rx.search(category.lower()) for category in categories)


def _round(value: float) -> float:
    return float(round(value)) if abs(value) >= 100 else round(value, 1)


def refine_chart(chart: ChartData, title: str, params: dict[str, Any]) -> set[str]:
    """Правила для диаграммы. Возвращает, что изменилось (ключи CHANGE_LABELS)."""
    changes: set[str] = set()
    rx = re.compile(params.get("temporal_rx") or "$^", re.IGNORECASE)
    key = chart.categories[chart.highlight] if chart.highlight is not None and 0 <= chart.highlight < len(chart.categories) else None

    series = [row for row in chart.series if row.values][: int(params.get("max_series", 5))]
    if len(series) < len(chart.series):
        changes.add("trimmed")
    width = min([len(chart.categories), *(len(row.values) for row in series)]) if series else 0
    categories = [_clean(category) or f"{i + 1}" for i, category in enumerate(chart.categories[:width])]
    rows = [[float(value) for value in row.values[:width]] for row in series]
    temporal = _temporal(categories, rx)
    single = len(rows) == 1

    kind = chart.type
    if kind in {"pie", "donut"}:
        values = rows[0] if single else []
        whole = single and 2 <= width <= int(params.get("pie_max_parts", 6)) and all(v >= 0 for v in values) and sum(values) > 0
        if whole and PERCENT_RX.search(chart.unit or ""):
            whole = abs(sum(values) - 100) <= float(params.get("pie_sum_tolerance", 5))
        if not whole:
            kind = "bar"  # не доли целого — сравнение столбцами
    elif kind == "line" and (not temporal or width < int(params.get("min_line_points", 3))):
        kind = "bar"  # линия обещает динамику во времени
    if kind == "bar" and categories and max(len(category) for category in categories) > int(params.get("long_label_chars", 14)):
        kind = "horizontal_bar"  # длинные подписи под столбцами ломаются в две-три строки
    if kind != chart.type:
        changes.add("retyped")

    order = list(range(width))
    limit = int(params.get("max_categories", 8))
    if width > limit:
        # Для динамики важны последние точки, для сравнения — лидеры.
        order = order[-limit:] if temporal else sorted(order, key=lambda i: -rows[0][i] if rows else 0)[:limit]
        changes.add("trimmed")
    # Рейтинг из многих строк читается сверху вниз по убыванию; короткое сравнение оставляем в порядке автора.
    if kind == "horizontal_bar" and single and not temporal and len(order) >= 5:
        ranked = sorted(order, key=lambda i: -rows[0][i])
        if ranked != order:
            order = ranked
            changes.add("sorted")
    categories = [categories[i] for i in order]
    rows = [[row[i] for i in order] for row in rows]

    # Акцент — ключевая категория от автора текстов или единственная, названная в заголовке.
    highlight = None
    if single and kind in {"bar", "horizontal_bar"} and not chart.colors and len(categories) >= 2:
        if key in categories:
            highlight = categories.index(key)
        else:
            mentioned = [i for i, category in enumerate(categories) if len(category) > 2 and category.lower() in title.lower()]
            highlight = mentioned[0] if len(mentioned) == 1 else None
    if highlight is not None and (highlight != chart.highlight or "sorted" in changes):
        changes.add("highlighted")

    rounded = [[_round(value) for value in row] for row in rows]
    if rounded != rows:
        changes.add("rounded")

    unit = _clean(chart.unit) or None
    if unit is None and chart.caption and (match := UNIT_IN_CAPTION_RX.search(chart.caption)):
        unit = match.group(1).strip()
        changes.add("unit")

    chart.type = kind
    chart.categories = categories
    chart.series = [ChartSeries(name=_clean(row.name) or "Значения", values=values) for row, values in zip(series, rounded)]
    chart.highlight = highlight
    chart.unit = unit
    return changes


def refine_table(table: TableData, params: dict[str, Any]) -> set[str]:
    changes: set[str] = set()
    columns = [_clean(column) for column in table.columns]
    rows = [[_clean(cell) for cell in row] for row in table.rows]
    rows = [row for row in rows if any(row)]
    width = max([len(columns), *(len(row) for row in rows)], default=0)
    columns += [""] * (width - len(columns))
    rows = [row + [""] * (width - len(row)) for row in rows]
    max_cols, max_rows = int(params.get("max_table_cols", 5)), int(params.get("max_table_rows", 7))
    if width > max_cols or len(rows) > max_rows:
        changes.add("trimmed")
    table.columns = columns[:max_cols]
    table.rows = [row[:max_cols] for row in rows[:max_rows]]
    return changes


def refine_kpis(kpis: list[Kpi], params: dict[str, Any]) -> tuple[list[Kpi], set[str]]:
    changes: set[str] = set()
    cleaned = [
        Kpi(value=_clean(kpi.value).rstrip("."), label=_clean(kpi.label))
        for kpi in kpis
        if _clean(kpi.value)
    ]
    limit = int(params.get("max_kpis", 4))
    if len(cleaned) > limit:
        changes.add("trimmed")
    return cleaned[:limit], changes


def _period_key(text: str) -> tuple[int, int, int] | None:
    """Ключ сортировки этапа: год, квартал, месяц. None — дата не похожа на период."""
    lowered = text.lower()
    year = YEAR_RX.search(lowered)
    quarter = QUARTER_RX.search(lowered)
    month = next((i + 1 for i, name in enumerate(MONTHS) if name in lowered), 0)
    if not (year or quarter):
        return None
    q = next((int(group) for group in quarter.groups() if group), 0) if quarter else 0
    return int(year.group(0)) if year else 0, q, month


def refine_timeline(items: list[TimelineItem], params: dict[str, Any]) -> tuple[list[TimelineItem], set[str]]:
    changes: set[str] = set()
    cleaned = [
        TimelineItem(date=_clean(item.date), title=_clean(item.title), text=_clean(item.text) or None)
        for item in items
        if _clean(item.title) or _clean(item.date)
    ]
    keys = [_period_key(item.date) for item in cleaned]
    if cleaned and all(keys):
        ordered = [item for _, item in sorted(zip(keys, cleaned), key=lambda pair: pair[0])]
        if ordered != cleaned:
            cleaned = ordered
            changes.add("ordered")
    limit = int(params.get("max_timeline", 6))
    if len(cleaned) > limit:
        changes.add("trimmed")
    return cleaned[:limit], changes


def refine_visuals(slides: list[Slide]) -> VisualsReport:
    """Правила визуализации для слайдов одного варианта (слайды меняются на месте)."""
    params = _params()
    report = VisualsReport()
    for slide in slides:
        if slide.chart is not None:
            report.charts += 1
            report.changes.update(refine_chart(slide.chart, slide.title, params))
        if slide.table is not None:
            report.tables += 1
            report.changes.update(refine_table(slide.table, params))
        if slide.kpis:
            report.kpis += 1
            slide.kpis, changes = refine_kpis(slide.kpis, params)
            report.changes.update(changes)
        if slide.timeline:
            report.timelines += 1
            slide.timeline, changes = refine_timeline(slide.timeline, params)
            report.changes.update(changes)
    return report


def refine_variant(
    slides: list[Slide],
    patterns: list[dict[str, Any]] | None,
    *,
    position: int,
    layout_names: dict[str, str],
) -> VisualsReport:
    """Правила визуализации + перепроверка паттернов: тип диаграммы и число элементов могли измениться."""
    report = refine_visuals(slides)
    assign_patterns(slides, patterns, position=position, layout_names=layout_names, keep=True)
    return report
