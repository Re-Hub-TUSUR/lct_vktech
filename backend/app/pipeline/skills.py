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
            # Для стадий с моделью показываем ту, что реально подключена сейчас.
            "model": {"llm": settings.llm_model, "vlm": settings.vlm_model, "t2i": settings.t2i_model}.get(
                self.runtime, self.model
            )
            or self.model,
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


@dataclass(frozen=True)
class SkillPreset:
    """Шаблонный пользовательский скилл из стандартной комплектации (backend/skills/presets/*.yaml)."""

    id: str
    title: str
    description: str
    kind: str
    version: str
    instruction: str
    # Пример «до / после» для страницы «Скиллы».
    example_before: str = ""
    example_after: str = ""


PRESET_PREFIX = "preset:"


@lru_cache(maxsize=1)
def load_skill_presets() -> list[SkillPreset]:
    presets: list[SkillPreset] = []
    for path in sorted((settings.skills_dir / "presets").glob("*.yaml")):
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        presets.append(
            SkillPreset(
                id=PRESET_PREFIX + str(data.get("id") or path.stem),
                title=data.get("title", path.stem),
                description=(data.get("description") or "").strip(),
                kind=data.get("kind", "all"),
                version=str(data.get("version", "1.0.0")),
                instruction=(data.get("instruction") or "").strip(),
                example_before=str((data.get("example") or {}).get("before") or "").strip(),
                example_after=str((data.get("example") or {}).get("after") or "").strip(),
            )
        )
    return presets


def skills_snapshot(custom: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    result = [skill.ref() for skill in load_skills().values()]
    for item in custom or []:
        if not item.get("enabled", True) or not str(item.get("instruction") or "").strip():
            continue
        skill_id = str(item.get("id") or item.get("name") or "custom")
        result.append({
            "name": skill_id,
            "title": str(item.get("title") or item.get("name") or skill_id),
            "version": str(item.get("version") or "1.0.0"),
            "runtime": "custom",
            "model": None,
            "source": "custom",
            "skill_id": skill_id,
            "kind": str(item.get("kind") or "all"),
            "instruction": str(item.get("instruction") or "")[:12000],
        })
    return result


def custom_skill_context(custom: list[dict[str, Any]] | None, kinds: set[str] | None = None) -> str:
    chunks = []
    for item in custom or []:
        if not item.get("enabled", True):
            continue
        kind = str(item.get("kind") or "all")
        if kinds and kind not in kinds and kind != "all":
            continue
        instruction = str(item.get("instruction") or "").strip()[:4000]
        if instruction:
            title = str(item.get("title") or item.get("name") or "Пользовательское правило").strip()[:120]
            chunks.append(f"[{title}]\n{instruction}")
    return "\n\n".join(chunks)[:12000]
