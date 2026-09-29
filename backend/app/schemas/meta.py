from pydantic import BaseModel


class Option(BaseModel):
    value: str
    label: str
    description: str | None = None


class AxisVariantOption(BaseModel):
    letter: str
    name: str
    description: str


class AxisOption(Option):
    variants: list[AxisVariantOption]


class SlidesCountRange(BaseModel):
    min: int
    max: int
    default: int


class ImagesOption(BaseModel):
    """Генерация иллюстраций: подключена ли модель text-to-image (T2I_*) и какая."""

    available: bool
    model: str | None = None


class OptionsOut(BaseModel):
    purposes: list[Option]
    variant_axes: list[AxisOption]
    languages: list[Option]
    tones: list[Option]
    slides_count: SlidesCountRange
    content_extensions: list[str]
    images: ImagesOption


class SkillOut(BaseModel):
    name: str
    title: str
    version: str
    kind: str
    runtime: str
    stage: str | None
    model: str | None
    description: str
    file: str
