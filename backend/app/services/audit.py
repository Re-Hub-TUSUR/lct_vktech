"""Аудит варианта: запуск проверок, хранение результатов, автоисправления."""

import uuid
from collections import Counter, defaultdict

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditIssue, ContentFile, Presentation, Template, Variant
from app.models.base import utcnow
from app.pipeline.audit.catalog import AuditContext, catalog_by_id, categories, limits, load_catalog
from app.pipeline.audit.fixes import FixContext, IssueRef, apply_fixes
from app.pipeline.audit.runner import run_checks, runnable_checks
from app.schemas.audit import AuditIssueOut, AuditReport, AuditSummary, CheckOut
from app.schemas.slide import Slide
from app.services.templates import template_theme


async def build_audit_context(db: AsyncSession, presentation: Presentation, template: Template | None) -> AuditContext:
    texts = await db.scalars(
        select(ContentFile.extracted_text).where(ContentFile.presentation_id == presentation.id)
    )
    sources = "\n".join([presentation.brief or "", *(text for text in texts if text)])
    return AuditContext(
        theme=template_theme(template),
        layout_keys={layout["key"] for layout in (template.layouts if template else [])},
        sources_text=sources,
        language=(presentation.settings or {}).get("language", "ru"),
        limits=limits(),
    )


def load_slides(variant: Variant) -> list[Slide]:
    return [Slide.model_validate(slide) for slide in variant.slides or []]


async def refresh_audit(db: AsyncSession, variant: Variant, ctx: AuditContext) -> None:
    """Перезапускает проверки: открытые проблемы пересоздаются, игнорированные не возвращаются."""
    ignored = set(
        await db.scalars(
            select(AuditIssue.fingerprint).where(AuditIssue.variant_id == variant.id, AuditIssue.status == "ignored")
        )
    )
    await db.execute(delete(AuditIssue).where(AuditIssue.variant_id == variant.id, AuditIssue.status == "open"))
    for result in run_checks(load_slides(variant), ctx):
        if result.fingerprint in ignored:
            continue
        finding, check = result.finding, result.check
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
                fixable=check.fixable,
                fingerprint=result.fingerprint,
            )
        )
    await db.flush()


async def resolve_issues(
    db: AsyncSession,
    variant: Variant,
    issue_ids: list[uuid.UUID],
    action: str,
    ctx: AuditContext,
    template: Template | None,
) -> int:
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
    refs = [IssueRef(str(i.id), i.check_id, i.slide_id, i.target, i.evidence) for i in issues if i.fixable]
    slides, applied = apply_fixes(
        load_slides(variant),
        refs,
        FixContext(limits=ctx.limits, content_layout_key=content_key, content_layout_name=content_name),
    )
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
            slide_index.get(i.slide_id, len(slide_index)),
            severity_rank.get(i.severity, 3),
        )
    )
    open_issues = [i for i in issues if i.status == "open"]
    open_by_check = Counter(i.check_id for i in open_issues)
    runnable = {check.id for check in runnable_checks()}

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
            checks_run=len(runnable),
            checks_failed=len(open_by_check),
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
        checks=[
            CheckOut(
                id=check.id,
                title=check.title,
                category=check.category,
                kind=check.kind,
                severity=check.severity,
                status=check.status,
                description=check.description,
                fixable=check.fixable,
                fix=check.fix,
                open_findings=open_by_check.get(check.id, 0),
            )
            for check in load_catalog()
        ],
    )
