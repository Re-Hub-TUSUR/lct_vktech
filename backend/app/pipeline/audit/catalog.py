"""Каталог проверок аудита (skills/auditor.yaml) и общие типы."""

from dataclasses import dataclass, field
from typing import Any

from app.pipeline.skills import get_skill

METHODS = ("data", "render", "llm", "vlm")


@dataclass(frozen=True)
class CheckInfo:
    id: str
    title: str
    category: str
    kind: str
    severity: str
    method: str
    description: str
    fixable: bool
    fix: str | None
    fallback: str | None = None
    # Исправление пишет модель (planning/editor.py) по инструкции fix_prompt.
    editor: bool = False
    fix_prompt: str | None = None


@dataclass
class AuditContext:
    """Всё, что нужно проверкам помимо слайдов."""

    theme: dict[str, Any]
    layout_keys: set[str]
    sources_text: str = ""
    language: str = "ru"
    limits: dict[str, Any] = field(default_factory=dict)
    # Паттерны шаблона по id: у слайда с паттерном ёмкость известна точно — по его слотам.
    patterns: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Презентация — для правок моделью (контекст колоды в промпте редактора).
    title: str = ""
    purpose: str = ""
    brief: str = ""
    materials: str = ""  # тексты контент-пакета без брифа
    tone: str = "business"
    audience: str = ""
    # Snapshot пользовательских правил презентации для автоисправлений.
    custom_skills: list[dict[str, Any]] = field(default_factory=list)
    # Шаблон: сам шаблон, его токены (сетка, шкала кеглей, логотипы) и всё, что встречается в его файле.
    template: Any = None
    tokens: dict[str, Any] = field(default_factory=dict)
    inventory: dict[str, list] = field(default_factory=dict)
    # Рендер: "ready" | "pending" | "failed" | "unavailable"; факты по id слайда (services/renders.py).
    render_status: str = "unavailable"
    render_error: str | None = None
    render_error_kind: str | None = None
    renders: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Модель-судья: подключена ли; вердикты по тексту и по картинкам — по id слайда (audit/review.py).
    judge: str | None = None
    reviews: dict[str, dict[str, Any]] = field(default_factory=dict)
    image_reviews: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Слайды, у которых есть картинки для судьи (иначе проверка картинок им не нужна).
    picture_slides: set[str] = field(default_factory=set)


@dataclass
class Finding:
    check_id: str
    slide_id: str | None
    target: str | None
    message: str
    evidence: str | None = None


def params() -> dict[str, Any]:
    return get_skill("auditor").params


def load_catalog() -> list[CheckInfo]:
    return [
        CheckInfo(
            id=item["id"],
            title=item["title"],
            category=item["category"],
            kind=item["kind"],
            severity=item.get("severity", "warning"),
            method=item.get("method", "data"),
            description=item.get("description", ""),
            fixable=bool(item.get("fixable", False)),
            fix=item.get("fix"),
            fallback=item.get("fallback"),
            editor=bool(item.get("editor", False)),
            fix_prompt=item.get("fix_prompt"),
        )
        for item in params().get("checks") or []
    ]


def catalog_by_id() -> dict[str, CheckInfo]:
    return {check.id: check for check in load_catalog()}


def limits() -> dict[str, Any]:
    return dict(params().get("limits") or {})


def render_params() -> dict[str, Any]:
    return dict(params().get("render") or {})


def review_params() -> dict[str, Any]:
    return dict(params().get("review") or {})


def categories() -> dict[str, str]:
    return dict(params().get("categories") or {})
