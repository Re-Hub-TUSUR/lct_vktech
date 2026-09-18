"""Каталог проверок аудита (skills/auditor.yaml) и общие типы."""

from dataclasses import dataclass, field
from typing import Any

from app.pipeline.skills import get_skill

# Проверки с этими статусами выполняются при аудите.
RUNNABLE_STATUSES = frozenset({"implemented", "heuristic"})


@dataclass(frozen=True)
class CheckInfo:
    id: str
    title: str
    category: str
    kind: str
    severity: str
    status: str
    description: str
    fixable: bool
    fix: str | None


@dataclass
class AuditContext:
    """Всё, что нужно проверкам помимо слайдов."""

    theme: dict[str, Any]
    layout_keys: set[str]
    sources_text: str = ""
    language: str = "ru"
    limits: dict[str, Any] = field(default_factory=dict)


@dataclass
class Finding:
    check_id: str
    slide_id: str | None
    target: str | None
    message: str
    evidence: str | None = None


def _params() -> dict[str, Any]:
    return get_skill("auditor").params


def load_catalog() -> list[CheckInfo]:
    return [
        CheckInfo(
            id=item["id"],
            title=item["title"],
            category=item["category"],
            kind=item["kind"],
            severity=item.get("severity", "warning"),
            status=item.get("status", "planned"),
            description=item.get("description", ""),
            fixable=bool(item.get("fixable", False)),
            fix=item.get("fix"),
        )
        for item in _params().get("checks") or []
    ]


def catalog_by_id() -> dict[str, CheckInfo]:
    return {check.id: check for check in load_catalog()}


def limits() -> dict[str, Any]:
    return dict(_params().get("limits") or {})


def categories() -> dict[str, str]:
    return dict(_params().get("categories") or {})
