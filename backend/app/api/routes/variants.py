import asyncio
import random
import re
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Response, status

from app.api.deps import CurrentUser, DbSession, get_variant_for_user
from app.api.serializers import variant_out
from app.pipeline.export.html_export import build_html
from app.pipeline.export.pdf_export import build_pdf
from app.pipeline.export.pptx_export import ExportError, build_pptx
from app.pipeline.layout.composer import compose_single_variant
from app.pipeline.planning.outline import build_outline, group_labels
from app.schemas.audit import AuditReport, ResolveRequest, ResolveResponse
from app.schemas.generation import PresentationBrief, VariantDetailResponse, VariantOut
from app.schemas.presentation import GenerationSettings
from app.schemas.template import SlideTheme
from app.services.audit import audit_report, build_audit_context, issue_counts, load_slides, refresh_audit, resolve_issues
from app.services.templates import slide_size_inches, template_theme

router = APIRouter(prefix="/variants", tags=["variants"])

MEDIA_TYPES = {
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pdf": "application/pdf",
    "html": "text/html; charset=utf-8",
}


async def _variant_payload(db, variant, presentation):
    counts = await issue_counts(db, [variant.id])
    return variant_out(variant, counts.get(variant.id), presentation.selected_variant_id)


@router.get("/{variant_id}", response_model=VariantDetailResponse)
async def get_variant(variant_id: uuid.UUID, user: CurrentUser, db: DbSession) -> VariantDetailResponse:
    variant, presentation = await get_variant_for_user(db, variant_id, user)
    return VariantDetailResponse(
        theme=SlideTheme(**template_theme(presentation.template)),
        presentation=PresentationBrief(
            id=presentation.id,
            title=presentation.title,
            status=presentation.status,
            selected_variant_id=presentation.selected_variant_id,
        ),
        variant=await _variant_payload(db, variant, presentation),
    )


@router.get("/{variant_id}/audit", response_model=AuditReport)
async def get_audit(variant_id: uuid.UUID, user: CurrentUser, db: DbSession) -> AuditReport:
    variant, _ = await get_variant_for_user(db, variant_id, user)
    return await audit_report(db, variant)


@router.post("/{variant_id}/audit/run", response_model=AuditReport)
async def rerun_audit(variant_id: uuid.UUID, user: CurrentUser, db: DbSession) -> AuditReport:
    variant, presentation = await get_variant_for_user(db, variant_id, user)
    ctx = await build_audit_context(db, presentation, presentation.template)
    await refresh_audit(db, variant, ctx)
    await db.commit()
    return await audit_report(db, variant)


@router.post("/{variant_id}/audit/resolve", response_model=ResolveResponse)
async def resolve(variant_id: uuid.UUID, payload: ResolveRequest, user: CurrentUser, db: DbSession) -> ResolveResponse:
    variant, presentation = await get_variant_for_user(db, variant_id, user)
    template = presentation.template
    ctx = await build_audit_context(db, presentation, template)
    applied = await resolve_issues(db, variant, payload.issue_ids, payload.action, ctx, template)
    await db.commit()
    return ResolveResponse(
        applied=applied,
        report=await audit_report(db, variant),
        variant=await _variant_payload(db, variant, presentation),
    )


def _filename(title: str, letter: str, extension: str) -> str:
    base = re.sub(r"[^\w\- ]+", "", title, flags=re.UNICODE).strip().replace(" ", "_")[:80] or "presentation"
    return f"{base}_{letter}.{extension}"


@router.get("/{variant_id}/export/{fmt}")
async def export_variant(
    variant_id: uuid.UUID, fmt: Literal["pptx", "pdf", "html"], user: CurrentUser, db: DbSession
) -> Response:
    variant, presentation = await get_variant_for_user(db, variant_id, user)
    template = presentation.template
    slides = load_slides(variant)
    theme = template_theme(template)

    if fmt == "pptx":
        if template is None or not Path(template.file_path).exists():
            raise HTTPException(status.HTTP_409_CONFLICT, "Файл шаблона недоступен — экспорт в .pptx невозможен")
        try:
            content = await asyncio.to_thread(
                build_pptx, template.file_path, slides, roles=template.layout_roles or {}, theme=theme
            )
        except ExportError as exc:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc)) from exc
    elif fmt == "pdf":
        width, height = slide_size_inches(template)
        content = await asyncio.to_thread(build_pdf, slides, theme, width_in=width, height_in=height)
    else:
        content = build_html(slides, theme, title=presentation.title).encode("utf-8")

    filename = _filename(presentation.title, variant.letter, fmt)
    disposition = f"attachment; filename=\"presentation_{variant.letter}.{fmt}\"; filename*=UTF-8''{quote(filename)}"
    return Response(content=content, media_type=MEDIA_TYPES[fmt], headers={"Content-Disposition": disposition})


@router.post("/{variant_id}/reroll", response_model=VariantOut)
async def reroll_variant(variant_id: uuid.UUID, user: CurrentUser, db: DbSession) -> VariantOut:
    variant, presentation = await get_variant_for_user(db, variant_id, user)
    template = presentation.template
    options = GenerationSettings.model_validate(presentation.settings or {})
    specs = build_outline(title=presentation.title, purpose=presentation.purpose, brief=presentation.brief)
    seed = random.randint(1, 1_000_000)
    draft = compose_single_variant(
        specs,
        axis_key=variant.axis or options.variant_axis,
        position=variant.position,
        slides_count=options.slides_count,
        speaker_notes=options.speaker_notes,
        layouts=template.layouts if template else [],
        roles=template.layout_roles if template else {},
        groups=group_labels(),
        seed=seed,
    )
    variant.slides = [slide.model_dump(mode="json") for slide in draft.slides]
    ctx = await build_audit_context(db, presentation, template)
    await refresh_audit(db, variant, ctx)
    await db.commit()
    counts = await issue_counts(db, [variant.id])
    return variant_out(variant, counts.get(variant.id), presentation.selected_variant_id)
