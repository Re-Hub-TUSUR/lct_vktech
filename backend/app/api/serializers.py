"""Преобразование ORM-моделей в схемы ответа API."""

from collections import Counter

from app.models import ContentFile, Generation, Presentation, Template, Variant
from app.schemas.generation import GenerationOut, VariantOut, VariantRenders, VariantStats
from app.schemas.presentation import ContentFileOut, GenerationSettings, PresentationOut, PresentationUserOut
from app.schemas.slide import Slide
from app.schemas.template import SlideTheme, TemplateDetail, TemplateSummary
from app.services.renders import render_state
from app.services.templates import template_theme


def template_summary(template: Template) -> TemplateSummary:
    tokens = template.tokens or {}
    ready = template.status == "ready" and bool(tokens)
    return TemplateSummary(
        id=template.id,
        name=template.name,
        description=template.description,
        is_builtin=template.is_builtin,
        status=template.status,
        error=template.error,
        slides_count=template.slides_count,
        layouts_count=len(template.layouts or []),
        aspect_ratio=(tokens.get("slide_size") or {}).get("aspect"),
        palette=[color["hex"] for color in (tokens.get("palette") or [])[:8]],
        fonts=[font["name"] for font in (tokens.get("fonts") or [])[:3]],
        theme=SlideTheme(**template_theme(template)) if ready else None,
        created_at=template.created_at,
    )


def template_detail(template: Template) -> TemplateDetail:
    return TemplateDetail(
        **template_summary(template).model_dump(),
        file_size=template.file_size,
        parser_version=template.parser_version,
        tokens=template.tokens or {},
        layouts=template.layouts or [],
        layout_roles=template.layout_roles or {},
        patterns=template.patterns or [],
    )


def content_file_out(file: ContentFile) -> ContentFileOut:
    return ContentFileOut(
        id=file.id,
        filename=file.filename,
        content_type=file.content_type,
        size=file.size,
        has_text=bool(file.extracted_text),
        created_at=file.created_at,
    )


def presentation_out(presentation: Presentation, files: list[ContentFile]) -> PresentationOut:
    return PresentationOut(
        id=presentation.id,
        title=presentation.title,
        purpose=presentation.purpose,
        brief=presentation.brief,
        settings=GenerationSettings.model_validate(presentation.settings or {}),
        status=presentation.status,
        template_id=presentation.template_id,
        template=template_summary(presentation.template) if presentation.template else None,
        selected_variant_id=presentation.selected_variant_id,
        access_role=presentation.access_role or "owner",
        owner=PresentationUserOut(
            id=presentation.owner.id, full_name=presentation.owner.full_name, email=presentation.owner.email
        ),
        files=[content_file_out(file) for file in files],
        created_at=presentation.created_at,
        updated_at=presentation.updated_at,
    )


def generation_out(generation: Generation) -> GenerationOut:
    return GenerationOut(
        id=generation.id,
        presentation_id=generation.presentation_id,
        status=generation.status,
        progress=generation.progress,
        current_stage=generation.current_stage,
        stages=generation.stages or [],
        skills=generation.skills or [],
        error=generation.error,
        created_at=generation.created_at,
        started_at=generation.started_at,
        finished_at=generation.finished_at,
    )


VISUAL_KINDS = {"chart", "table", "kpi", "timeline", "image_text"}


def variant_out(variant: Variant, counts: Counter[str] | None, selected_id, template: Template | None = None) -> VariantOut:
    slides = [Slide.model_validate(slide) for slide in variant.slides or []]
    words = 0
    for slide in slides:
        texts = [slide.title, *slide.bullets, *(b for c in slide.columns for b in c.bullets)]
        words += sum(len(text.split()) for text in texts)
    counts = counts or Counter()
    return VariantOut(
        id=variant.id,
        position=variant.position,
        letter=variant.letter,
        name=variant.name,
        description=variant.description,
        axis=variant.axis,
        profile=variant.profile or {},
        slides=slides,
        stats=VariantStats(
            slides=len(slides),
            visuals=sum(1 for slide in slides if slide.kind in VISUAL_KINDS),
            words=words,
            avg_words=round(words / len(slides)) if slides else 0,
            issues_open=sum(counts.values()),
            errors=counts.get("error", 0),
            warnings=counts.get("warning", 0),
        ),
        is_selected=variant.id == selected_id,
        renders=VariantRenders(**render_state(variant, template)),
    )
