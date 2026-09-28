"""Русская типографика текстов слайдов — правилами, без модели.

Неразрывный пробел после коротких предлогов и союзов и между числом и единицей (строка не
рвётся на «в | рамках», «8 | ч»), «ёлочки» вместо прямых кавычек, тире вместо дефиса между
словами, короткое тире в диапазонах (3–4, 2025–2026), разряды больших чисел (12 000).
Числа в данных диаграмм и таблиц не трогаются — меняется только текст для чтения.
"""

import re
from typing import Any

NBSP = " "
# Короткие слова, которые не должны висеть в конце строки.
SHORT_WORDS = (
    "в|во|к|ко|с|со|у|о|об|от|до|по|за|из|на|не|ни|и|а|но|да|же|ли|без|для|при|про|под|над|"
    "что|как|или|это|его|их|её"
)
SHORT_RX = re.compile(rf"(?<![\w\-])({SHORT_WORDS}) (?=\S)", re.IGNORECASE)
# Число и короткая единица или знак: «8 ч», «5 мин», «120 млн», «12 000 ₽», «№ 5».
UNIT_RX = re.compile(r"(\d) (?=(?:%|₽|\$|€|ч|мин|сек|с|дн|мес|млн|млрд|тыс|руб|кг|км|м|см|мм|ГБ|МБ|шт|п\.п)\b)")
NUMERO_RX = re.compile(r"№ ?(?=\d)")
DASH_RX = re.compile(r"(?<=\S) [-–] (?=\S)")
RANGE_RX = re.compile(r"(?<![\w.,])(\d{1,4})\s?-\s?(\d{1,4})(?![\w.,])")
QUOTES_RX = re.compile(r'"([^"\n]{1,200})"')
# Разряды: пять и больше цифр подряд (не год и не номер с дефисом).
BIG_NUMBER_RX = re.compile(r"(?<![\d.,])(\d{5,})(?![\d.,])")


def _group(match: re.Match[str]) -> str:
    digits = match.group(1)
    parts = []
    while digits:
        parts.append(digits[-3:])
        digits = digits[:-3]
    return NBSP.join(reversed(parts))


def polish(text: str | None, language: str = "ru") -> str | None:
    """Типографика одной строки. Для английских колод — только кавычки и тире не трогаются."""
    if not text or language != "ru":
        return text
    result = " ".join(text.split())
    result = QUOTES_RX.sub(lambda m: f"«{m.group(1)}»", result)
    result = RANGE_RX.sub(lambda m: f"{m.group(1)}–{m.group(2)}", result)
    result = DASH_RX.sub(f"{NBSP}— ", result)
    result = BIG_NUMBER_RX.sub(_group, result)
    result = UNIT_RX.sub(rf"\1{NBSP}", result)
    result = NUMERO_RX.sub(f"№{NBSP}", result)
    # Два прохода: «и в рамках» — оба коротких слова приклеиваются к следующему.
    for _ in range(2):
        result = SHORT_RX.sub(lambda m: m.group(1) + NBSP, result)
    return result


def _polish_list(items: list[Any] | None, language: str) -> list[Any]:
    return [polish(item, language) if isinstance(item, str) else item for item in items or []]


def polish_spec(spec: dict[str, Any], language: str = "ru") -> None:
    """Типографика всех текстов спецификации слайда (на месте). Числа данных не меняются."""
    if language != "ru":
        return
    for key in ("insight", "topic", "subtitle", "notes"):
        if isinstance(spec.get(key), str):
            spec[key] = polish(spec[key], language)
    spec["bullets"] = _polish_list(spec.get("bullets"), language) if spec.get("bullets") else spec.get("bullets", [])
    for card in spec.get("cards") or []:
        card["title"], card["text"] = polish(card.get("title"), language), polish(card.get("text"), language)
    for column in spec.get("columns") or []:
        column["title"] = polish(column.get("title"), language)
        column["bullets"] = _polish_list(column.get("bullets"), language)
    for item in spec.get("timeline") or []:
        item["title"], item["text"] = polish(item.get("title"), language), polish(item.get("text"), language)
    data = spec.get("data")
    if isinstance(data, dict):
        data["caption"] = polish(data.get("caption"), language)
        for kpi in data.get("kpis") or []:
            kpi["value"], kpi["label"] = polish(kpi.get("value"), language), polish(kpi.get("label"), language)
    quote = spec.get("quote")
    if isinstance(quote, dict):
        quote["text"] = polish(quote.get("text"), language)


def polish_slide(slide, language: str = "ru"):
    """Типографика текстов готового слайда (правка из чата, исправления аудита). Возвращает слайд."""
    if language != "ru":
        return slide
    slide.title = polish(slide.title, language) or slide.title
    slide.subtitle = polish(slide.subtitle, language)
    slide.summary = polish(slide.summary, language)
    slide.notes = polish(slide.notes, language)
    slide.bullets = _polish_list(slide.bullets, language)
    for column in slide.columns:
        column.title = polish(column.title, language) or column.title
        column.bullets = _polish_list(column.bullets, language)
    for kpi in slide.kpis:
        kpi.value = polish(kpi.value, language) or kpi.value
        kpi.label = polish(kpi.label, language) or kpi.label
    for item in slide.timeline:
        item.title = polish(item.title, language) or item.title
        item.text = polish(item.text, language)
    if slide.chart is not None:
        slide.chart.caption = polish(slide.chart.caption, language)
    if slide.quote is not None:
        slide.quote.text = polish(slide.quote.text, language) or slide.quote.text
    return slide
