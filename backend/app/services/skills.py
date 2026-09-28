"""Скиллы, выбранные в Студии: id стандартных (preset:…) и библиотечных скиллов → инструкции для агентов."""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CustomSkill, User
from app.pipeline.skills import PRESET_PREFIX, load_skill_presets


async def resolve_skills(db: AsyncSession, user: User, ids: list[str]) -> list[dict[str, Any]]:
    presets = {preset.id: preset for preset in load_skill_presets()}
    result: list[dict[str, Any]] = []
    library_ids: list[uuid.UUID] = []
    for skill_id in dict.fromkeys(ids):
        if skill_id.startswith(PRESET_PREFIX):
            preset = presets.get(skill_id)
            if preset is not None:
                result.append(
                    {"id": preset.id, "title": preset.title, "kind": preset.kind, "version": preset.version, "instruction": preset.instruction}
                )
            continue
        try:
            library_ids.append(uuid.UUID(skill_id))
        except ValueError:
            continue
    if library_ids:
        rows = await db.scalars(select(CustomSkill).where(CustomSkill.id.in_(library_ids), CustomSkill.owner_id == user.id))
        for skill in rows:
            result.append(
                {"id": str(skill.id), "title": skill.title, "kind": skill.kind, "version": skill.current_version, "instruction": skill.instruction}
            )
    return result
