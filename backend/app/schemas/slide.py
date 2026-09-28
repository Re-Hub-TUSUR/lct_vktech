"""Модель слайда — общий контракт генерации, вёрстки, аудита, экспорта и фронтенда.

Слайд описывает смысл и тип визуализации, а не координаты. Геометрию задаёт
паттерн шаблона (pattern_id — слайд-пример, который клонируется и заполняется),
а если подходящего паттерна нет — макет шаблона (layout_key).
"""

import hashlib
import json
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field

SlideKind = Literal[
    "title",
    "section",
    "agenda",
    "bullets",
    "two_columns",
    "cards",
    "chart",
    "table",
    "kpi",
    "timeline",
    "quote",
    "image_text",
    "closing",
]

# Слайды на акцентном фоне (обложка, разделитель, финал).
INVERSE_KINDS: frozenset[str] = frozenset({"title", "section", "closing"})


def new_slide_id() -> str:
    return uuid4().hex[:12]


class Column(BaseModel):
    """Колонка (two_columns) или карточка (cards): заголовок и тезисы."""

    title: str = ""
    bullets: list[str] = Field(default_factory=list)


class ChartSeries(BaseModel):
    name: str = ""
    values: list[float] = Field(default_factory=list)


class SlideShape(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex[:8])
    template_shape_id: int | None = None
    kind: Literal["circle", "rect", "badge", "pill", "line", "image"] = "circle"
    x: float = 0.5  # fraction 0..1
    y: float = 0.5  # fraction 0..1
    width: float = 0.15  # fraction
    height: float = 0.15  # fraction
    color: str | None = None
    opacity: float | None = 1.0
    text: str | None = None
    border: bool | None = False
    font_family: str | None = None
    font_size: float | None = None
    bold: bool | None = None
    image_url: str | None = None
    crop: list[float] | None = None  # [top, right, bottom, left] fractions (0..1)
    # Скругление углов картинки: доля половины короткой стороны (0 — прямые углы, 1 — полукруглые края).
    radius: float | None = None


class ChartData(BaseModel):
    type: Literal["bar", "horizontal_bar", "line", "pie", "donut"] = "bar"
    caption: str | None = None
    unit: str | None = None
    categories: list[str] = Field(default_factory=list)
    series: list[ChartSeries] = Field(default_factory=list)
    colors: list[str] | None = None
    show_values: bool | None = True
    show_legend: bool | None = True
    # Категория, которую диаграмма выделяет акцентом (ключевое значение); остальные — приглушённым цветом.
    highlight: int | None = None


class TableData(BaseModel):
    columns: list[str] = Field(default_factory=list)
    rows: list[list[str]] = Field(default_factory=list)


class Kpi(BaseModel):
    value: str
    label: str = ""


class TimelineItem(BaseModel):
    date: str = ""
    title: str = ""
    text: str | None = None


class Quote(BaseModel):
    text: str
    author: str | None = None


class ImageSpec(BaseModel):
    prompt: str
    url: str | None = None
    # placeholder — модель text-to-image ещё не подключена
    status: Literal["placeholder", "generated"] = "placeholder"


AnimationType = Literal["fade", "up", "zoom", "left", "wipe"]
AnimationTrigger = Literal["click", "with", "after"]
TransitionType = Literal["none", "fade", "push", "zoom", "wipe"]


class SlideAnimation(BaseModel):
    """Анимация появления элемента. Порядок в Slide.animations — порядок показа.

    target — адрес элемента, как в element_boxes и аудите (title, subtitle, bullets.1, columns.0, image,
    chart…), или shape:<id> для фигуры слайда. Сборка переносит анимацию в .pptx (export/motion.py).
    """

    target: str = Field(min_length=1, max_length=120)
    type: AnimationType = "fade"
    duration_ms: int = Field(600, ge=100, le=5000)
    delay_ms: int = Field(0, ge=0, le=10000)
    # click — по щелчку, with — вместе с предыдущей, after — после предыдущей.
    trigger: AnimationTrigger = "click"


class SlideTransition(BaseModel):
    """Переход к слайду (при показе и в .pptx)."""

    type: TransitionType = "fade"
    duration_ms: int = Field(600, ge=100, le=5000)


class Slide(BaseModel):
    id: str = Field(default_factory=new_slide_id)
    kind: SlideKind
    # Фрагмент сценария, из которого собран слайд (cover, problem, effect…).
    ref: str | None = None
    group: str | None = None
    title: str = ""
    subtitle: str | None = None
    # Главная мысль слайда одним предложением — используется аудитом и автоисправлениями.
    summary: str | None = None
    bullets: list[str] = Field(default_factory=list)
    columns: list[Column] = Field(default_factory=list)
    chart: ChartData | None = None
    table: TableData | None = None
    kpis: list[Kpi] = Field(default_factory=list)
    timeline: list[TimelineItem] = Field(default_factory=list)
    quote: Quote | None = None
    image: ImageSpec | None = None
    shapes: list[SlideShape] = Field(default_factory=list)
    notes: str | None = None
    layout_key: str | None = None
    layout_name: str | None = None
    # Паттерн шаблона (id слайда-примера, см. parsing/patterns.py); None — вёрстка на макете.
    pattern_id: str | None = None

    # Пользовательские переопределения стилей и размеров (Canva Lite)
    font_family: str | None = None
    font_size_scale: float | None = None  # 0.8, 1.0, 1.25 и т.д.
    element_fonts: dict[str, str] = Field(default_factory=dict)
    element_scales: dict[str, float] = Field(default_factory=dict)
    element_boxes: dict[str, list[float]] = Field(default_factory=dict)  # target -> [x, y, w, h] (0..1)
    element_crops: dict[str, list[float]] = Field(default_factory=dict)  # target -> [top, right, bottom, left] (0..1)
    block_density: Literal["compact", "normal", "spacious"] | None = None
    background_color: str | None = None
    text_color: str | None = None
    text_background_color: str | None = None
    accent_color: str | None = None
    element_colors: dict[str, str] = Field(default_factory=dict)
    element_backgrounds: dict[str, str] = Field(default_factory=dict)
    is_bold: bool | None = None
    element_bolds: dict[str, bool] = Field(default_factory=dict)
    # Выравнивание текста поля: left | center | right | justify.
    element_aligns: dict[str, str] = Field(default_factory=dict)
    # Скругление углов картинки слайда (ключ image): как SlideShape.radius.
    element_radii: dict[str, float] = Field(default_factory=dict)
    # Анимации элементов (по порядку показа) и переход к слайду. На рендер не влияют.
    animations: list[SlideAnimation] = Field(default_factory=list)
    transition: SlideTransition | None = None
    # Скрытые элементы (панель «Слои»): не попадают в сборку и экспорт. Адреса — как у animations.target.
    hidden_elements: list[str] = Field(default_factory=list)
    # Закреплённые элементы: редактор не даёт их двигать. На сборку не влияет.
    locked_elements: list[str] = Field(default_factory=list)


class BatchSlidesUpdate(BaseModel):
    slides: list[Slide]


# Поля, которые не меняют картинку слайда: правка анимации не повод перерендеривать и перепроверять слайд.
MOTION_FIELDS = frozenset({"animations", "transition", "locked_elements"})


def slide_key(slide: Slide, salt: str = "") -> str:
    """Отпечаток содержимого слайда (без id): по нему кэшируются факты рендера и вердикты модели-судьи,
    чтобы после правки одного слайда не проверять заново остальные."""
    payload = json.dumps(slide.model_dump(mode="json", exclude={"id", *MOTION_FIELDS}), sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(f"{salt}|{payload}".encode("utf-8")).hexdigest()[:16]


class RegenerateSlideRequest(BaseModel):
    instruction: str | None = None
    style: str | None = None
    # Паттерн выбран пользователем: модель пишет текст под него, подбор паттерна не трогает.
    keep_pattern: bool = False
    # Скиллы, включённые в Студии (id стандартных «preset:…» и скиллов библиотеки).
    skills: list[str] = Field(default_factory=list, max_length=20)


# Подсказка вёрстки из Студии (чипы «Тезисы», «Колонки»…): auto — выбрать по содержимому.
PatternHint = Literal["auto", "bullets", "columns", "cards", "timeline", "chart", "case"]


class GenerateSlideRequest(BaseModel):
    """Новый слайд по описанию (Студия › AI): вставляется после after_slide_id или заменяет replace_slide_id."""

    prompt: str = Field(min_length=1, max_length=4000)
    pattern: PatternHint = "auto"
    skills: list[str] = Field(default_factory=list, max_length=20)
    after_slide_id: str | None = None
    replace_slide_id: str | None = None


