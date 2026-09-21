import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.generation import VariantOut

CheckStatus = Literal["implemented", "heuristic", "stub", "planned", "export"]


class AuditIssueOut(BaseModel):
    id: uuid.UUID
    slide_id: str | None
    slide_index: int | None
    check_id: str
    check_title: str
    category: str
    kind: Literal["deterministic", "contextual"]
    severity: Literal["error", "warning", "info"]
    message: str
    target: str | None
    evidence: str | None
    fixable: bool
    fix_hint: str | None
    status: Literal["open", "fixed", "ignored"]
    created_at: datetime
    resolved_at: datetime | None


class CheckOut(BaseModel):
    id: str
    title: str
    category: str
    kind: Literal["deterministic", "contextual"]
    severity: Literal["error", "warning", "info"]
    status: CheckStatus
    description: str
    fixable: bool
    fix: str | None
    open_findings: int


class AuditSummary(BaseModel):
    open: int
    fixed: int
    ignored: int
    by_severity: dict[str, int]
    by_category: dict[str, int]
    by_kind: dict[str, int]
    checks_run: int
    checks_failed: int


class AuditReport(BaseModel):
    variant_id: uuid.UUID
    categories: dict[str, str]
    summary: AuditSummary
    issues: list[AuditIssueOut]
    checks: list[CheckOut]


class ResolveRequest(BaseModel):
    issue_ids: list[uuid.UUID] = Field(min_length=1)
    action: Literal["fix", "ignore"] = "fix"


class ResolveResponse(BaseModel):
    applied: int
    report: AuditReport
    variant: VariantOut
