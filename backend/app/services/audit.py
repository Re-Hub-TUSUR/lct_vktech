"""Аудит варианта: запуск проверок, модель-судья, хранение результатов, автоисправления.

Проверки по данным идут сразу. Проверки по рендеру читают факты последнего рендера (по отпечаткам
слайдов, services/renders.py), контекстуальные — вердикты модели-судьи из кэша варианта
(Variant.review). Сам судья вызывается отдельно — review_variant: при генерации, после
перерендера в фоновой задаче и при перезапуске аудита. Состояние каждой проверки (выполнена,
запасным правилом, ждёт рендера или модели) сохраняется и показывается в каталоге проверок.
"""

import asyncio
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, replace

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditIssue, ContentFile, Generation, Presentation, Template, Variant
from app.models.base import utcnow
from app.pipeline.ai.llm import judge_model, llm_enabled
from app.pipeline.audit.catalog import AuditContext, CheckInfo, Finding, catalog_by_id, categories, limits, load_catalog
from app.pipeline.audit.fixes import (
    FIXES,
    EditorContext,
    FixContext,
    IssueRef,
    apply_editor_fixes,
    apply_fixes,
    apply_custom_style_rules,
    editor_issues,
)
from app.pipeline.audit.review import (
    ReviewCache,
    ReviewOutcome,
    cache_payload,
    image_key,
    picture_slides,
    review_deck,
    review_images,
    text_keys,
)
from app.pipeline.audit.runner import CheckRun, run_checks
from app.pipeline.export.facts import template_inventory
from app.pipeline.layout.composer import assign_layouts
from app.pipeline.layout.matcher import assign_patterns
from app.pipeline.planning.outline import purpose_label
from app.schemas.audit import AuditIssueOut, AuditReport, AuditSummary, CheckOut
from app.schemas.slide import Slide
from app.services.renders import render_salt, renders_supported, slide_facts_by_id
from app.services.templates import template_theme


@dataclass
class AuditOutcome:
    """Итог прогона проверок варианта — для подписи стадии генерации."""

    runs: dict[str, CheckRun]
    open_issues: Counter


async def build_audit_context(db: AsyncSession, presentation: Presentation, template: Template | None) -> AuditContext:
    texts = [
        text
        for text in await db.scalars(
            select(ContentFile.extracted_text).where(ContentFile.presentation_id == presentation.id)
        )
        if text
    ]
    options = presentation.settings or {}
    latest_generation = await db.scalar(
        select(Generation).where(Generation.presentation_id == presentation.id).order_by(Generation.created_at.desc())
    )
    snapshot_skills = [
        skill for skill in (latest_generation.skills if latest_generation else [])
        if skill.get("source") == "custom" and skill.get("instruction")
    ]
    judge = judge_model()
    return AuditContext(
        theme=template_theme(template),
        layout_keys={layout["key"] for layout in (template.layouts if template else [])},
        sources_text="\n".join([presentation.brief or "", *texts]),
        language=options.get("language", "ru"),
        limits=limits(),
        patterns={p["id"]: p for p in (template.patterns if template else None) or [] if p.get("usable")},
        title=presentation.title,
        purpose=purpose_label(presentation.purpose),
        brief=presentation.brief or "",
        materials="\n\n".join(texts),
        tone=options.get("tone", "business"),
        audience=options.get("audience") or "",
        custom_skills=snapshot_skills or list(options.get("custom_skills") or []),
        tokens=(template.tokens if template else None) or {},
        inventory=await asyncio.to_thread(template_inventory, template.file_path if template else None),
        render_status="pending" if renders_supported(template) else "unavailable",
        judge=judge.model if judge.enabled else None,
        template=template,
    )


def load_slides(variant: Variant) -> list[Slide]:
    return [Slide.model_validate(slide) for slide in variant.slides or []]


def variant_context(ctx: AuditContext, variant: Variant) -> AuditContext:
    """Контекст проверок одного варианта: факты его рендера и вердикты судьи из кэша."""
    template = ctx.template
    slides = load_slides(variant)
    renders = variant.renders or {}
    supported = renders_supported(template)
    facts = slide_facts_by_id(variant, template) if supported else {}
    stored = variant.review or {}
    failed = stored.get("failed") or {}
    reviews: dict[str, dict] = {}
    image_reviews: dict[str, dict] = {}
    if ctx.judge:
        cache = ReviewCache.load(stored, ctx.judge)
        for slide, key in zip(slides, text_keys(slides, ctx.judge, ctx.sources_text)):
            if key in cache.slides:
                reviews[slide.id] = cache.slides[key]
            elif key in (failed.get("slides") or []):
                reviews[slide.id] = {"failed": True}
        salt = render_salt(template)
        for slide in slides:
            key = image_key(slide, ctx.judge, salt)
            if key in cache.images:
                image_reviews[slide.id] = cache.images[key]
            elif key in (failed.get("images") or []):
                image_reviews[slide.id] = {"failed": True}
    return replace(
        ctx,
        render_status=(renders.get("status") or "pending") if supported else "unavailable",
        render_error=renders.get("error"),
        render_error_kind=renders.get("error_kind"),
        renders=facts,
        reviews=reviews,
        image_reviews=image_reviews,
        picture_slides=picture_slides(slides, facts),
    )


async def review_variant(variant: Variant, ctx: AuditContext, *, images: bool = True) -> ReviewOutcome | None:
    """Вызывает модель-судью для слайдов без вердикта (по тексту и, если есть рендер, по картинкам).
    Кэш вердиктов и отметки о неответах сохраняются в variant.review."""
    if not ctx.judge:
        return None
    slides = load_slides(variant)
    cache = ReviewCache.load(variant.review, ctx.judge)
    vctx = variant_context(ctx, variant)
    salt = render_salt(ctx.template)

    def work() -> ReviewOutcome:
        outcome = review_deck(slides, title=ctx.title, language=ctx.language, sources=ctx.sources_text, cache=cache)
        if images and vctx.render_status != "unavailable":
            review_images(slides, vctx.renders, title=ctx.title, render_salt=salt, cache=cache, outcome=outcome)
        return outcome

    outcome = await asyncio.to_thread(work)
    keys = dict(zip((slide.id for slide in slides), text_keys(slides, ctx.judge, ctx.sources_text)))
    payload = cache_payload(cache, slides, ctx.sources_text, salt)
    payload["failed"] = {
        "slides": [keys[sid] for sid, verdict in outcome.reviews.items() if verdict.get("failed") and sid in keys],
        "images": [
            image_key(slide, ctx.judge, salt)
            for slide in slides
            if (outcome.image_reviews.get(slide.id) or {}).get("failed")
        ],
    }
    payload["checks"] = (variant.review or {}).get("checks") or {}
    variant.review = payload
    return outcome


def _fixable(check: CheckInfo, finding: Finding) -> bool:
    """Можно ли исправить здесь и сейчас: правилом или моделью (если она подключена)."""
    if not check.fixable:
        return False
    if check.editor and llm_enabled():
        return True
    if check.id == "content.matches_title":
        return bool(finding.evidence)  # без модели остаётся только заголовок, который предложил судья
    return check.id in FIXES


async def refresh_audit(db: AsyncSession, variant: Variant, ctx: AuditContext) -> AuditOutcome:
    """Перезапускает проверки: открытые проблемы пересоздаются, игнорированные не возвращаются."""
    ignored = set(
        await db.scalars(
            select(AuditIssue.fingerprint).where(AuditIssue.variant_id == variant.id, AuditIssue.status == "ignored")
        )
    )
    await db.execute(delete(AuditIssue).where(AuditIssue.variant_id == variant.id, AuditIssue.status == "open"))
    results, runs = run_checks(load_slides(variant), variant_context(ctx, variant))
    open_issues: Counter = Counter()
    for result in results:
        if result.fingerprint in ignored:
            continue
        finding, check = result.finding, result.check
        open_issues[check.severity] += 1
        db.add(
            AuditIssue(
                variant_id=variant.id,
                slide_id=finding.slide_id,
                check_id=check.id,
                category=check.category,
                kind=check.kind,
                severity=check.severity,
                message=finding.message,
                target=finding.target,
                evidence=finding.evidence,
                fixable=_fixable(check, finding),
                fingerprint=result.fingerprint,
            )
        )
    variant.review = {
        **(variant.review or {}),
        "judge": ctx.judge,
        "checks": {check_id: {"state": run.state, "note": run.note} for check_id, run in runs.items()},
        "checked_at": utcnow().isoformat(),
    }
    await db.flush()
    return AuditOutcome(runs=runs, open_issues=open_issues)


async def resolve_issues(
    db: AsyncSession,
    variant: Variant,
    issue_ids: list[uuid.UUID],
    action: str,
    ctx: AuditContext,
    template: Template | None,
) -> int:
    generation = await db.get(Generation, variant.generation_id)
    if generation is not None:
        snapshot_skills = [
            skill for skill in (generation.skills or [])
            if skill.get("source") == "custom" and skill.get("instruction")
        ]
        if snapshot_skills:
            ctx = replace(ctx, custom_skills=snapshot_skills)
    issues = list(
        await db.scalars(
            select(AuditIssue).where(
                AuditIssue.variant_id == variant.id, AuditIssue.id.in_(issue_ids), AuditIssue.status == "open"
            )
        )
    )
    now = utcnow()
    if action == "ignore":
        for issue in issues:
            issue.status, issue.resolved_at = "ignored", now
        await db.flush()
        return len(issues)

    roles = template.layout_roles if template else {}
    content_key = roles.get("content")
    content_name = next((l["name"] for l in (template.layouts if template else []) if l["key"] == content_key), None)
    refs = [IssueRef(str(i.id), i.check_id, i.slide_id, i.target, i.evidence, i.message) for i in issues if i.fixable]
    catalog = catalog_by_id()
    slides = load_slides(variant)
    applied: list[str] = []
    # Сначала текст, который пишет модель, потом правила: разбить слайд, удалить дубликат и т. п.
    if by_model := editor_issues(refs, catalog):
        editor = EditorContext(
            title=ctx.title,
            purpose=ctx.purpose,
            brief=ctx.brief,
            sources=ctx.materials,
            language=ctx.language,
            tone=ctx.tone,
            audience=ctx.audience,
            patterns=ctx.patterns,
            custom_skills=ctx.custom_skills,
        )
        slides, applied = await asyncio.to_thread(apply_editor_fixes, slides, by_model, catalog, editor, ctx.limits)
    done = set(applied)
    # Правка моделью не удалась — срабатывает правило, если оно у проверки есть.
    slides, by_rules = apply_fixes(
        slides,
        [ref for ref in refs if ref.id not in done],
        FixContext(limits=ctx.limits, content_layout_key=content_key, content_layout_name=content_name),
    )
    applied += by_rules
    apply_custom_style_rules(slides, ctx.custom_skills)
    if template is not None:
        # После правок содержимое могло перестать помещаться в паттерн (или начать помещаться в другой):
        # подходящие паттерны сохраняются, остальные слайды подбираются заново.
        names = {layout["key"]: layout["name"] for layout in template.layouts or []}
        assign_layouts(slides, roles, names)
        assign_patterns(slides, template.patterns, position=variant.position, layout_names=names, keep=True)
    variant.slides = [slide.model_dump(mode="json") for slide in slides]
    applied_ids = set(applied)
    for issue in issues:
        if str(issue.id) in applied_ids:
            issue.status, issue.resolved_at = "fixed", now
    await db.flush()
    await refresh_audit(db, variant, ctx)
    return len(applied_ids)


async def issue_counts(db: AsyncSession, variant_ids: list[uuid.UUID]) -> dict[uuid.UUID, Counter[str]]:
    counts: dict[uuid.UUID, Counter[str]] = defaultdict(Counter)
    if not variant_ids:
        return counts
    rows = await db.execute(
        select(AuditIssue.variant_id, AuditIssue.severity).where(
            AuditIssue.variant_id.in_(variant_ids), AuditIssue.status == "open"
        )
    )
    for variant_id, severity in rows:
        counts[variant_id][severity] += 1
    return counts


async def audit_report(db: AsyncSession, variant: Variant) -> AuditReport:
    issues = list(await db.scalars(select(AuditIssue).where(AuditIssue.variant_id == variant.id)))
    catalog = catalog_by_id()
    slide_index = {slide.get("id"): i for i, slide in enumerate(variant.slides or [])}
    severity_rank = {"error": 0, "warning": 1, "info": 2}
    issues.sort(
        key=lambda i: (
            i.status != "open",
            slide_index.get(i.slide_id, -1),
            severity_rank.get(i.severity, 3),
        )
    )
    open_issues = [i for i in issues if i.status == "open"]
    open_by_check = Counter(i.check_id for i in open_issues)
    review = variant.review or {}
    states = review.get("checks") or {}

    def state(check: CheckInfo) -> tuple[str, str | None]:
        stored = states.get(check.id)
        if stored:
            return stored.get("state") or "pending", stored.get("note")
        # Отчёт старше этой версии аудита — проверка ещё не запускалась.
        return ("done", None) if check.method == "data" else ("pending", "Перезапустите аудит")

    checks = []
    for check in load_catalog():
        status, note = state(check)
        checks.append(
            CheckOut(
                id=check.id,
                title=check.title,
                category=check.category,
                kind=check.kind,
                severity=check.severity,
                method=check.method,
                fallback=check.fallback,
                status=status,
                note=note,
                description=check.description,
                fixable=check.fixable,
                fix=check.fix,
                open_findings=open_by_check.get(check.id, 0),
            )
        )

    return AuditReport(
        variant_id=variant.id,
        categories=categories(),
        summary=AuditSummary(
            open=len(open_issues),
            fixed=sum(1 for i in issues if i.status == "fixed"),
            ignored=sum(1 for i in issues if i.status == "ignored"),
            by_severity=dict(Counter(i.severity for i in open_issues)),
            by_category=dict(Counter(i.category for i in open_issues)),
            by_kind=dict(Counter(i.kind for i in open_issues)),
            checks_run=sum(1 for check in checks if check.status in {"done", "fallback"}),
            checks_failed=len(open_by_check),
            checks_pending=sum(1 for check in checks if check.status == "pending"),
        ),
        issues=[
            AuditIssueOut(
                id=i.id,
                slide_id=i.slide_id,
                slide_index=slide_index.get(i.slide_id),
                check_id=i.check_id,
                check_title=catalog[i.check_id].title if i.check_id in catalog else i.check_id,
                category=i.category,
                kind=i.kind,
                severity=i.severity,
                message=i.message,
                target=i.target,
                evidence=i.evidence,
                fixable=i.fixable,
                fix_hint=catalog[i.check_id].fix if i.check_id in catalog else None,
                status=i.status,
                created_at=i.created_at,
                resolved_at=i.resolved_at,
            )
            for i in issues
        ],
        checks=checks,
        judge=review.get("judge"),
    )
