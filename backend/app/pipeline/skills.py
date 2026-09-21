"""Реестр скиллов и агентов: промпты, параметры и версии из backend/skills/*.yaml."""

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import yaml

from app.core.config import settings


@dataclass(frozen=True)
class Skill:
    name: str
    title: str
    version: str
    kind: str
    runtime: str
    stage: str | None
    model: str | None
    description: str
    prompt: dict[str, str] | None
    params: dict[str, Any]
    file: str

    def ref(self) -> dict[str, Any]:
        """Краткая запись для снимка версий в прогоне генерации."""
        return {
            "name": self.name,
            "title": self.title,
            "version": self.version,
            "runtime": self.runtime,
            "model": self.model,
        }


@lru_cache(maxsize=1)
def load_skills() -> dict[str, Skill]:
    skills: dict[str, Skill] = {}
    for path in sorted(settings.skills_dir.glob("*.yaml")):
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        name = data["name"]
        skills[name] = Skill(
            name=name,
            title=data.get("title", name),
            version=str(data.get("version", "0.0.0")),
            kind=data.get("kind", "skill"),
            runtime=data.get("runtime", "code"),
            stage=data.get("stage"),
            model=data.get("model"),
            description=(data.get("description") or "").strip(),
            prompt=data.get("prompt"),
            params=data.get("params") or {},
            file=path.name,
        )
    return skills


def get_skill(name: str) -> Skill:
    skills = load_skills()
    if name not in skills:
        raise KeyError(f"Скилл {name!r} не найден в {settings.skills_dir}")
    return skills[name]


def skills_snapshot() -> list[dict[str, Any]]:
    return [skill.ref() for skill in load_skills().values()]
