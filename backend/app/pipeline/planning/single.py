"""Один слайд по описанию: Студия › AI «Сгенерировать слайд» и «Заменить».

1. Тип слайда — из подсказки пользователя (чипы «Тезисы», «Колонки», «Карточки», «Этапы», «Столбцы»,
   «Кейс») или по содержимому описания («Авто»).
2. Черновик собирается из описания детерминированно: первая фраза — заголовок, остальные — пункты.
3. Если модель подключена, текст пишет редактор слайда (planning/editor.py) с теми же ограничениями
   вёрстки и скиллами, что и правка из чата.
4. Правило «не придумывать чисел»: диаграмма и KPI остаются, только если каждое число есть в описании,
   брифе или контент-пакете; иначе слайд собирается карточками без цифр.

Паттерн шаблона подбирает composer.relayout_edited_slide — так же, как после правки моделью.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from app.pipeline.planning.editor import EditError, edit_slide
from app.pipeline.skills import get_skill
from app.pipeline.visuals.visualizer import refine_chart
from app.schemas.slide import ChartData, ChartSeries, Column, ImageSpec, Slide, SlideKind, TimelineItem

HINT_KINDS: dict[str, SlideKind] = {
    "bullets": "bullets",
    "columns": "two_columns",
    "cards": "cards",
    "timeline": "timeline",
    "chart": "chart",
    "case": "image_text",
}
HINT_LABELS = {
    "bullets": "тезисы",
    "two_columns": "две колонки",
    "cards": "карточки",
    "timeline": "этапы",
    "chart": "столбцы",
    "image_text": "кейс",
    "kpi": "показатели",
}
# Число с необязательной дробной частью: «82», «3,5», «1 200».
NUMBER_RX = re.compile(r"(?<![\w.,])[-−]?\d{1,3}(?:[\s  ]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?")
STEP_RX = re.compile(r"\b(этап|шаг|фаза|квартал|месяц|неделя|спринт|q[1-4]|20\d\d|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)", re.IGNORECASE)
SPLIT_RX = re.compile(r"[\n;•]+|(?<=[.!?])\s+|\s[—–]\s|,\s(?=[А-ЯA-Z])")


@dataclass
class SingleResult:
    slide: Slide
    reply: str
    used_model: bool


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip(" .,;:—–-")


def _cap(text: str) -> str:
    return text[:1].upper() + text[1:] if text else text


def split_prompt(prompt: str) -> tuple[str, list[str]]:
    """Заголовок и пункты из свободного описания."""
    parts = [_clean(part) for part in SPLIT_RX.split(prompt or "")]
    parts = [part for part in parts if part]
    if not parts:
        return "Новый слайд", []
    return _cap(parts[0][:90]), [_cap(part) for part in parts[1:]]


def _number(text: str) -> float | None:
    match = NUMBER_RX.search(text)
    if not match:
        return None
    raw = re.sub(r"[\s  ]", "", match.group(0)).replace(",", ".").replace("−", "-")
    try:
        return float(raw)
    except ValueError:
        return None


def _label(text: str) -> str:
    """Подпись категории без её числа: «Мемы — 82%» → «Мемы»."""
    label = NUMBER_RX.sub("", text)
    label = re.sub(r"[%₽$€]|\b(млн|млрд|тыс|шт|чел|руб)\b\.?", "", label, flags=re.IGNORECASE)
    return _cap(_clean(label)) or text


def numbers_in(text: str) -> set[float]:
    values = set()
    for match in NUMBER_RX.finditer(text or ""):
        raw = re.sub(r"[\s  ]", "", match.group(0)).replace(",", ".").replace("−", "-")
        try:
            values.add(round(float(raw), 4))
        except ValueError:
            continue
    return values


def choose_kind(prompt: str, hint: str) -> SlideKind:
    if hint in HINT_KINDS:
        return HINT_KINDS[hint]
    _, items = split_prompt(prompt)
    # Столбцы — только если у каждого пункта есть число из описания: цифры не придумываем.
    if len(items) >= 2 and all(_number(item) is not None for item in items):
        return "chart"
    if len(items) >= 3 and sum(bool(STEP_RX.search(item)) for item in items) >= len(items) - 1:
        return "timeline"
    if len(items) >= 4:
        return "cards"
    if len(items) == 2:
        return "two_columns"
    return "bullets"


def draft_slide(prompt: str, kind: SlideKind) -> Slide:
    """Черновик без модели: заголовок и пункты из описания в структуре нужного типа."""
    title, items = split_prompt(prompt)
    fallback = ["Ключевой тезис", "Второй тезис", "Третий тезис"]
    slide = Slide(kind=kind, title=title, summary=title)
    if kind == "chart":
        rows = [(item, _number(item)) for item in items]
        rows = [(label, value) for label, value in rows if value is not None][:8]
        slide.chart = ChartData(
            type="horizontal_bar",
            categories=[_label(label) for label, _ in rows],
            series=[ChartSeries(name="Значения", values=[value for _, value in rows])],
        )
    elif kind == "two_columns":
        pairs = items[:2] or fallback[:2]
        slide.columns = [Column(title=pair, bullets=[]) for pair in pairs]
        while len(slide.columns) < 2:
            slide.columns.append(Column(title="Вторая колонка", bullets=[]))
    elif kind == "cards":
        slide.columns = [Column(title=item[:60], bullets=[item] if len(item) > 60 else []) for item in (items or fallback)[:6]]
    elif kind == "timeline":
        slide.timeline = [TimelineItem(date=f"{index + 1:02d}", title=item[:80]) for index, item in enumerate((items or fallback)[:6])]
    elif kind == "image_text":
        slide.bullets = (items or fallback)[:4]
        slide.image = ImageSpec(prompt=f"Иллюстрация к слайду «{title}»")
    else:
        slide.bullets = (items or fallback)[:5]
    slide.notes = f"Сгенерировано по описанию: {prompt.strip()[:400]}"
    return slide


def unsupported_numbers(slide: Slide, evidence: str) -> bool:
    """На слайде есть число, которого нет ни в описании, ни в брифе, ни в материалах."""
    known = numbers_in(evidence)
    values: list[float] = []
    if slide.chart:
        values += [value for row in slide.chart.series for value in row.values]
    for kpi in slide.kpis:
        number = _number(kpi.value)
        if number is not None:
            values.append(number)
    return any(round(value, 4) not in known for value in values)


def without_numbers(slide: Slide) -> Slide:
    """Диаграмма или KPI без подтверждённых цифр → карточки с подписями, без чисел."""
    labels = list(slide.chart.categories) if slide.chart else [kpi.label or kpi.value for kpi in slide.kpis]
    return slide.model_copy(
        update={
            "kind": "cards",
            "chart": None,
            "kpis": [],
            "columns": [Column(title=label, bullets=[]) for label in labels[:6]] or [Column(title=slide.title, bullets=[])],
        },
        deep=True,
    )


def generate_slide(
    prompt: str,
    *,
    hint: str,
    deck: list[Slide],
    title: str,
    purpose: str,
    brief: str,
    sources: str,
    language: str = "ru",
    tone: str = "business",
    audience: str = "",
    custom_skills: list[dict[str, Any]] | None = None,
    base: Slide | None = None,
) -> SingleResult:
    """Слайд по описанию. base — слайд, который заменяется: его id, заметки и анимации сохраняются."""
    kind = choose_kind(prompt, hint)
    slide = draft_slide(prompt, kind)
    if base is not None:
        slide = slide.model_copy(update={"id": base.id, "transition": base.transition})
    evidence = "\n".join([prompt, brief or "", sources or ""])
    reply = f"Слайд собран из описания · {HINT_LABELS.get(slide.kind, slide.kind)}"
    used_model = False

    instruction = (
        f"Собери этот слайд заново по описанию пользователя: «{prompt.strip()}». "
        "Заголовок — вывод слайда. Используй только факты из описания, брифа и материалов; "
        "не придумывай чисел, процентов и сумм — если их нет в источниках, пиши без цифр."
    )
    try:
        edited = edit_slide(
            slide,
            instruction,
            deck=deck if base is not None else [*deck, slide],
            title=title,
            purpose=purpose,
            brief=brief,
            sources=sources,
            language=language,
            tone=tone,
            audience=audience,
            custom_skills=custom_skills,
        )
        slide, reply, used_model = edited.slide, edited.reply, True
    except EditError:
        pass  # модели нет или она не ответила — остаётся черновик из описания

    if slide.chart is not None and (not slide.chart.categories or not any(row.values for row in slide.chart.series)):
        slide = without_numbers(slide)
        reply = "В описании нет чисел для столбцов — собрал карточками"
    elif (slide.chart is not None or slide.kpis) and unsupported_numbers(slide, evidence):
        slide = without_numbers(slide)
        reply = "Числа не нашлись в описании и материалах — собрал карточками без цифр"
    if slide.chart is not None:
        refine_chart(slide.chart, slide.title, get_skill("visualizer").params)
    return SingleResult(slide=slide, reply=reply, used_model=used_model)
