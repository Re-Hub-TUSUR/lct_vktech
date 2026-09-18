from fastapi import APIRouter
from sqlalchemy import text

from app.api.deps import DbSession
from app.core.redis import redis_client
from app.pipeline.skills import get_skill, load_skills
from app.schemas.meta import AxisOption, AxisVariantOption, Option, OptionsOut, SkillOut, SlidesCountRange
from app.schemas.presentation import SLIDES_DEFAULT, SLIDES_MAX, SLIDES_MIN

router = APIRouter(tags=["meta"])


@router.get("/health")
async def health(db: DbSession) -> dict[str, str]:
    await db.execute(text("SELECT 1"))
    await redis_client.ping()
    return {"status": "ok"}


@router.get("/meta/options", response_model=OptionsOut)
async def options() -> OptionsOut:
    outline = get_skill("outline_planner").params
    axes = get_skill("layout_composer").params.get("axes") or {}
    return OptionsOut(
        purposes=[
            Option(value=key, label=value["label"], description=value.get("description"))
            for key, value in (outline.get("purposes") or {}).items()
        ],
        variant_axes=[
            AxisOption(
                value=key,
                label=axis["title"],
                description=axis.get("description"),
                variants=[
                    AxisVariantOption(letter=v["letter"], name=v["name"], description=v.get("description", ""))
                    for v in axis.get("variants") or []
                ],
            )
            for key, axis in axes.items()
        ],
        languages=[Option(value="ru", label="Русский"), Option(value="en", label="English")],
        tones=[
            Option(value="business", label="Деловой"),
            Option(value="neutral", label="Нейтральный"),
            Option(value="inspiring", label="Вдохновляющий"),
        ],
        slides_count=SlidesCountRange(min=SLIDES_MIN, max=SLIDES_MAX, default=SLIDES_DEFAULT),
        content_extensions=list(get_skill("content_analyzer").params.get("extensions") or []),
    )


@router.get("/meta/skills", response_model=list[SkillOut])
async def skills() -> list[SkillOut]:
    return [
        SkillOut(
            name=skill.name,
            title=skill.title,
            version=skill.version,
            kind=skill.kind,
            runtime=skill.runtime,
            stage=skill.stage,
            model=skill.model,
            description=skill.description,
            file=skill.file,
        )
        for skill in load_skills().values()
    ]
