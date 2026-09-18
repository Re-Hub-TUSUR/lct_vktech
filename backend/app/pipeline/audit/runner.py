"""Запуск проверок из каталога и подготовка результатов к сохранению."""

import hashlib
from dataclasses import dataclass

from app.pipeline.audit.catalog import RUNNABLE_STATUSES, AuditContext, CheckInfo, Finding, load_catalog
from app.pipeline.audit.checks import CHECKS
from app.schemas.slide import Slide


@dataclass
class AuditResult:
    finding: Finding
    check: CheckInfo
    fingerprint: str


def fingerprint(finding: Finding) -> str:
    raw = "|".join([finding.check_id, finding.slide_id or "", finding.target or "", finding.evidence or ""])
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def runnable_checks() -> list[CheckInfo]:
    return [check for check in load_catalog() if check.status in RUNNABLE_STATUSES and check.id in CHECKS]


def run_checks(slides: list[Slide], ctx: AuditContext) -> list[AuditResult]:
    results: list[AuditResult] = []
    for check in runnable_checks():
        for finding in CHECKS[check.id](slides, ctx):
            results.append(AuditResult(finding=finding, check=check, fingerprint=fingerprint(finding)))
    order = {slide.id: i for i, slide in enumerate(slides)}
    results.sort(key=lambda r: order.get(r.finding.slide_id or "", len(order)))
    return results
