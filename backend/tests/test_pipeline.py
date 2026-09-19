"""Сквозной прогон без БД: план → три варианта → аудит → экспорт в три формата."""

from io import BytesIO

import pymupdf
import pytest
from pptx import Presentation

from app.pipeline.audit.catalog import AuditContext, limits
from app.pipeline.audit.runner import run_checks
from app.pipeline.export.html_export import build_html
from app.pipeline.export.pdf_export import build_pdf
from app.pipeline.export.pptx_export import build_pptx
from app.pipeline.layout.composer import axis_config, compose_single_variant, compose_variants
from app.pipeline.planning.outline import build_outline, group_labels
from app.pipeline.theme import slide_theme

BRIEF = (
    "Сервис собирает презентации в фирменном стиле за минуты. "
    "Команды тратят часы на ручную вёрстку слайдов. "
    "Дизайнеры перегружены типовыми задачами. "
    "AI-инструменты не соблюдают брендбук."
)


def compose(parsed, axis: str = "density"):
    _, result = parsed
    specs = build_outline(title="Цифровой дизайнер презентаций", purpose="product", brief=BRIEF)
    return compose_variants(
        specs,
        axis_key=axis,
        slides_count=12,
        speaker_notes=True,
        layouts=result.layouts,
        roles=result.roles,
        groups=group_labels(),
    )


@pytest.mark.parametrize("axis", ["density", "visualization", "structure", "layouts"])
def test_three_distinct_variants(parsed, axis):
    drafts = compose(parsed, axis)
    assert [d.letter for d in drafts] == ["A", "B", "C"]
    signatures = {tuple((s.kind, s.title) for s in d.slides) for d in drafts}
    assert len(signatures) == 3, "варианты должны различаться"
    _, result = parsed
    keys = {layout["key"] for layout in result.layouts}
    for draft in drafts:
        assert draft.slides[0].kind == "title" and draft.slides[-1].kind == "closing"
        assert all(slide.layout_key in keys for slide in draft.slides)
    assert axis_config(axis)[0] == axis


def test_audit_finds_demo_defects(parsed):
    _, result = parsed
    ctx = AuditContext(
        theme=slide_theme(result.tokens),
        layout_keys={layout["key"] for layout in result.layouts},
        sources_text=BRIEF,
        limits=limits(),
    )
    for draft in compose(parsed):
        found = {r.finding.check_id for r in run_checks(draft.slides, ctx)}
        assert found, f"в варианте {draft.letter} демо-дефекты должны находиться аудитом"
        assert "template.layout_from_template" not in found


def test_exports(parsed):
    path, result = parsed
    theme = slide_theme(result.tokens)
    slides = compose(parsed)[1].slides

    pptx_bytes = build_pptx(path, slides, roles=result.roles, theme=theme)
    deck = Presentation(BytesIO(pptx_bytes))
    assert len(deck.slides) == len(slides)
    assert deck.slides[0].shapes.title.text == slides[0].title

    html = build_html(slides, theme, title="Тест")
    assert html.count('class="slide') == len(slides)

    pdf = pymupdf.open(stream=build_pdf(slides, theme), filetype="pdf")
    assert pdf.page_count == len(slides)


def test_compose_single_variant(parsed):
    _, result = parsed
    specs = build_outline(title="Цифровой дизайнер презентаций", purpose="product", brief=BRIEF)
    draft1 = compose_single_variant(
        specs,
        axis_key="density",
        position=1,
        slides_count=12,
        speaker_notes=True,
        layouts=result.layouts,
        roles=result.roles,
        groups=group_labels(),
        seed=42,
    )
    draft2 = compose_single_variant(
        specs,
        axis_key="density",
        position=1,
        slides_count=12,
        speaker_notes=True,
        layouts=result.layouts,
        roles=result.roles,
        groups=group_labels(),
        seed=99,
    )
    assert draft1.letter == "B"
    assert draft2.letter == "B"
    assert len(draft1.slides) == len(draft2.slides)
