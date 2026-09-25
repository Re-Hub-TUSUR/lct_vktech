"""Оформление нативных диаграмм .pptx поверх данных: подпись с единицей, формат чисел, выделение.

Общее для диаграмм на макете (pptx_export._chart) и диаграмм слайдов-примеров шаблона
(pattern_fill.fill_chart): ключевая категория (ChartData.highlight, её выбирает стадия
визуализаций) остаётся цветом ряда, остальные приглушаются к фону слайда.
"""

from pptx.dml.color import RGBColor

from app.pipeline.theme import mix
from app.schemas.slide import ChartData

# Насколько приглушены столбцы рядом с выделенным (доля смешения с фоном слайда).
CHART_MUTE = 0.6
HIGHLIGHT_TYPES = ("bar", "horizontal_bar")


def chart_caption(chart: ChartData) -> str | None:
    """Подпись диаграммы с единицей измерения: «Время подготовки, ч»."""
    caption, unit = (chart.caption or "").strip(), (chart.unit or "").strip()
    if not unit or unit.lower() in caption.lower():
        return caption or None
    return f"{caption}, {unit}" if caption else unit


def number_format(chart: ChartData) -> str:
    """Формат подписей значений: целые без дробной части, проценты со знаком, разряды отбиты."""
    values = [value for series in chart.series for value in series.values]
    body = "#,##0" if all(float(value).is_integer() for value in values) else "#,##0.0"
    return body + '"%"' if (chart.unit or "").strip() == "%" else body


def highlight_points(plot, chart: ChartData, background: str, fallback: str | None = None) -> bool:
    """Ключевая категория — цветом ряда, остальные приглушены: глаз сразу видит вывод слайда.
    fallback — цвет ряда, если его задаёт стиль диаграммы шаблона, а не заливка самого ряда."""
    index = chart.highlight
    if index is None or len(chart.series) != 1 or chart.type not in HIGHLIGHT_TYPES:
        return False
    series = next(iter(plot.series), None)
    if series is None:
        return False
    try:
        base = "#" + str(series.format.fill.fore_color.rgb)
    except (AttributeError, TypeError):  # цвет ряда — из темы или стиля диаграммы
        if not fallback:
            return False
        base = fallback
    key = RGBColor.from_string(base.lstrip("#"))
    muted = RGBColor.from_string(mix(base, background, CHART_MUTE).lstrip("#"))
    for number, point in enumerate(series.points):
        if number >= len(chart.categories):
            break
        point.format.fill.solid()
        point.format.fill.fore_color.rgb = key if number == index else muted
    return True
