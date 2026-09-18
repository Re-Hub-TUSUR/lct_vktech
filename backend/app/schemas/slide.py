"""Модель слайда — общий контракт генерации, вёрстки, аудита, экспорта и фронтенда.

Слайд описывает смысл и тип визуализации, а не координаты: геометрию задаёт
макет шаблона (layout_key), на котором слайд верстается при экспорте в .pptx.
"""

from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field

SlideKind = Literal[
    "title",
    "section",
    "agenda",
    "bullets",
    "two_columns",
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
    title: str = ""
    bullets: list[str] = Field(default_factory=list)


class ChartSeries(BaseModel):
    name: str = ""
    values: list[float] = Field(default_factory=list)


class ChartData(BaseModel):
    type: Literal["bar", "line", "pie"] = "bar"
    caption: str | None = None
    unit: str | None = None
    categories: list[str] = Field(default_factory=list)
    series: list[ChartSeries] = Field(default_factory=list)


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
    notes: str | None = None
    layout_key: str | None = None
    layout_name: str | None = None
