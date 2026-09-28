import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models import CustomSkill
from app.models.base import utcnow
from app.pipeline.skills import load_skill_presets
from app.schemas.custom_skill import (
    CustomSkillCreate,
    CustomSkillOut,
    CustomSkillUpdate,
    PresetDefaultUpdate,
    SkillExample,
    SkillPresetOut,
    SkillVersion,
    SkillVersionOut,
)

router = APIRouter(prefix="/skills", tags=["skills"])


def _current_since(skill: CustomSkill):
    """Когда появилась текущая версия: момент последней смены инструкции или создание скилла."""
    history = skill.history or []
    return (history[-1].get("superseded_at") if history else None) or skill.created_at


def _versions(skill: CustomSkill) -> list[SkillVersionOut]:
    """Текущая версия и прошлые — от новой к старой, с датой появления."""
    current = SkillVersionOut(version=skill.current_version, created_at=_current_since(skill), current=True)
    past = [
        SkillVersionOut(version=item.get("version", "?"), created_at=item.get("created_at"))
        for item in reversed(skill.history or [])
    ]
    return [current, *past]


def _out(skill: CustomSkill) -> CustomSkillOut:
    return CustomSkillOut(
        id=skill.id,
        title=skill.title,
        description=skill.description,
        kind=skill.kind,
        version=skill.current_version,
        instruction=skill.instruction,
        enabled=skill.enabled,
        example=SkillExample(before=skill.example_before or "", after=skill.example_after or ""),
        history=[SkillVersion.model_validate(item) for item in skill.history or []],
        versions=_versions(skill),
        created_at=skill.created_at,
        updated_at=skill.updated_at,
    )


def next_version(version: str) -> str:
    """Новая инструкция — новая минорная версия: 1.2.0 → 1.3.0."""
    try:
        major, minor, _patch = [int(part) for part in version.split(".")]
    except ValueError:
        return "1.1.0"
    return f"{major}.{minor + 1}.0"


@router.get("", response_model=list[CustomSkillOut])
async def list_skills(user: CurrentUser, db: DbSession) -> list[CustomSkillOut]:
    rows = await db.scalars(select(CustomSkill).where(CustomSkill.owner_id == user.id).order_by(CustomSkill.updated_at.desc()))
    return [_out(skill) for skill in rows]


@router.get("/presets", response_model=list[SkillPresetOut])
async def list_presets(user: CurrentUser) -> list[SkillPresetOut]:
    defaults = set(user.default_presets or [])
    return [
        SkillPresetOut(
            id=preset.id,
            title=preset.title,
            description=preset.description,
            kind=preset.kind,
            version=preset.version,
            instruction=preset.instruction,
            example=SkillExample(before=preset.example_before, after=preset.example_after),
            versions=[SkillVersionOut(version=preset.version, current=True)],
            enabled=preset.id in defaults,
        )
        for preset in load_skill_presets()
    ]


@router.put("/presets/{preset_id}/default", response_model=SkillPresetOut)
async def set_preset_default(preset_id: str, payload: PresetDefaultUpdate, user: CurrentUser, db: DbSession) -> SkillPresetOut:
    """Включить стандартный скилл по умолчанию: он подключается к новым презентациям и в Студии."""
    preset = next((item for item in load_skill_presets() if item.id == preset_id), None)
    if preset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Скилл не найден")
    defaults = [item for item in user.default_presets or [] if item != preset_id]
    if payload.enabled:
        defaults.append(preset_id)
    user.default_presets = defaults
    await db.commit()
    return SkillPresetOut(
        id=preset.id,
        title=preset.title,
        description=preset.description,
        kind=preset.kind,
        version=preset.version,
        instruction=preset.instruction,
        example=SkillExample(before=preset.example_before, after=preset.example_after),
        versions=[SkillVersionOut(version=preset.version, current=True)],
        enabled=payload.enabled,
    )


@router.post("", response_model=CustomSkillOut, status_code=status.HTTP_201_CREATED)
async def create_skill(payload: CustomSkillCreate, user: CurrentUser, db: DbSession) -> CustomSkillOut:
    example = payload.example or SkillExample()
    skill = CustomSkill(
        owner_id=user.id,
        title=payload.title.strip(),
        description=payload.description.strip(),
        kind=payload.kind,
        instruction=payload.instruction.strip(),
        enabled=payload.enabled,
        example_before=example.before.strip(),
        example_after=example.after.strip(),
    )
    db.add(skill)
    await db.commit()
    await db.refresh(skill)
    return _out(skill)


@router.patch("/{skill_id}", response_model=CustomSkillOut)
async def update_skill(skill_id: uuid.UUID, payload: CustomSkillUpdate, user: CurrentUser, db: DbSession) -> CustomSkillOut:
    skill = await db.scalar(select(CustomSkill).where(CustomSkill.id == skill_id, CustomSkill.owner_id == user.id))
    if skill is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Скилл не найден")
    changes = payload.model_dump(exclude_unset=True)
    example = changes.pop("example", None)
    if "instruction" in changes and changes["instruction"] is not None and changes["instruction"].strip() != skill.instruction:
        started = _current_since(skill)
        skill.history = [
            *(skill.history or []),
            {
                "version": skill.current_version,
                "instruction": skill.instruction,
                "created_at": started if isinstance(started, str) else started.isoformat(),
                "superseded_at": utcnow().isoformat(),
            },
        ]
        skill.current_version = next_version(skill.current_version)
    for key, value in changes.items():
        if value is not None:
            setattr(skill, key, value.strip() if isinstance(value, str) else value)
    if example is not None:
        skill.example_before = (example.get("before") or "").strip()
        skill.example_after = (example.get("after") or "").strip()
    skill.updated_at = utcnow()
    await db.commit()
    await db.refresh(skill)
    return _out(skill)


@router.delete("/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(skill_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    skill = await db.scalar(select(CustomSkill).where(CustomSkill.id == skill_id, CustomSkill.owner_id == user.id))
    if skill is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Скилл не найден")
    await db.delete(skill)
    await db.commit()
