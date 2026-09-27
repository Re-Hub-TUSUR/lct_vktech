import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models import CustomSkill
from app.schemas.custom_skill import CustomSkillCreate, CustomSkillOut, CustomSkillUpdate

router = APIRouter(prefix="/skills", tags=["skills"])

def _out(skill: CustomSkill) -> CustomSkillOut:
    return CustomSkillOut(id=skill.id, title=skill.title, description=skill.description, kind=skill.kind,
                          version=skill.current_version, instruction=skill.instruction, enabled=skill.enabled,
                          history=skill.history or [], created_at=skill.created_at, updated_at=skill.updated_at)

@router.get("", response_model=list[CustomSkillOut])
async def list_skills(user: CurrentUser, db: DbSession) -> list[CustomSkillOut]:
    rows = await db.scalars(select(CustomSkill).where(CustomSkill.owner_id == user.id).order_by(CustomSkill.updated_at.desc()))
    return [_out(skill) for skill in rows]

@router.post("", response_model=CustomSkillOut, status_code=status.HTTP_201_CREATED)
async def create_skill(payload: CustomSkillCreate, user: CurrentUser, db: DbSession) -> CustomSkillOut:
    skill = CustomSkill(owner_id=user.id, title=payload.title.strip(), description=payload.description.strip(), kind=payload.kind, instruction=payload.instruction.strip())
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
    if "instruction" in changes and changes["instruction"] != skill.instruction:
        major, minor, patch = [int(part) for part in skill.current_version.split(".")]
        skill.history = [*(skill.history or []), {"version": skill.current_version, "instruction": skill.instruction}]
        skill.current_version = f"{major}.{minor}.{patch + 1}"
    for key, value in changes.items():
        setattr(skill, key, value.strip() if isinstance(value, str) else value)
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
