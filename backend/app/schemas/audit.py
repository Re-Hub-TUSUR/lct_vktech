import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.generation import VariantOut

# Чем выполняется проверка: данные слайда и шаблона, собранный .pptx и его рендер, модель-судья по тексту
# колоды, модель-судья по картинке слайда.
CheckMethod = Literal["data", "render", "llm", "vlm"]
# Состояние проверки в этом отчёте: выполнена; выполнена запасным правилом (нет рендера или модели);
# ждёт рендера или ответа модели; недоступна (нет LibreOffice или модели и нет запасного правила).
CheckState = Literal["done", "fallback", "pending", "unavailable"]


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
    method: CheckMethod
    fallback: CheckMethod | None = None
    status: CheckState
    note: str | None = None
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
    checks_pending: int = 0


class AuditReport(BaseModel):
    variant_id: uuid.UUID
    categories: dict[str, str]
    summary: AuditSummary
    issues: list[AuditIssueOut]
    checks: list[CheckOut]
    # Модель-судья контекстуальных проверок (AUDIT_MODEL или LLM_MODEL); None — не подключена.
    judge: str | None = None
    # Слайды правили после последней проверки: замечания могут не совпадать с текущей версией.
    stale: bool = False


class ResolveRequest(BaseModel):
    issue_ids: list[uuid.UUID] = Field(min_length=1)
    action: Literal["fix", "ignore"] = "fix"


class NotFixed(BaseModel):
    """Замечание, которое исправить не вышло: id открытого замечания после перепроверки и причина."""

    issue_id: uuid.UUID
    reason: str


class ResolveResponse(BaseModel):
    applied: int
    report: AuditReport
    variant: VariantOut
    not_fixed: list[NotFixed] = Field(default_factory=list)


class RegenerateSlideResponse(ResolveResponse):
    """Правка слайда из чата: ответ модели для чата и состояние варианта после правки."""

    reply: str
