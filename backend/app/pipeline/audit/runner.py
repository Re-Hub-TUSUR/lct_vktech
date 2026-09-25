"""Запуск проверок из каталога и подготовка результатов к сохранению.

У каждой проверки свой источник данных (method в каталоге): данные слайда, рендер, модель-судья по
тексту, судья по картинкам. Перед запуском определяется её состояние в этом отчёте: выполнена,
выполнена запасным правилом, ждёт рендера или ответа модели, недоступна. Недоступные не запускаются.
"""

import hashlib
from dataclasses import dataclass

from app.pipeline.audit import geometry  # noqa: F401 — регистрирует проверки по рендеру
from app.pipeline.audit.catalog import AuditContext, CheckInfo, Finding, load_catalog
from app.pipeline.audit.checks import CHECKS
from app.schemas.slide import Slide

NO_RENDER = "LibreOffice не найден — рендера нет"
NO_JUDGE = "Модель-судья не подключена (AUDIT_MODEL или LLM_MODEL)"


@dataclass
class AuditResult:
    finding: Finding
    check: CheckInfo
    fingerprint: str


@dataclass
class CheckRun:
    check: CheckInfo
    state: str  # done | fallback | pending | unavailable
    note: str | None = None


def fingerprint(finding: Finding) -> str:
    raw = "|".join([finding.check_id, finding.slide_id or "", finding.target or "", finding.evidence or ""])
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _without_input(check: CheckInfo, note: str) -> tuple[str, str]:
    return ("fallback" if check.fallback else "unavailable"), note


def check_state(check: CheckInfo, slides: list[Slide], ctx: AuditContext) -> tuple[str, str | None]:
    """Состояние проверки: есть ли у неё рендер или вердикты модели по всем слайдам."""
    if check.method == "data":
        return "done", None
    if check.method == "render":
        if ctx.render_status == "unavailable":
            return _without_input(check, NO_RENDER)
        if check.id == "integrity.file_opens":
            return ("pending", "Ждёт сборки .pptx") if ctx.render_status == "pending" else ("done", None)
        missing = [slide for slide in slides if slide.id not in ctx.renders]
        if not missing:
            return "done", None
        if ctx.render_status == "failed":
            return _without_input(check, f"Рендер не удался: {ctx.render_error or 'ошибка LibreOffice'}")
        return "pending", f"Ждёт рендера слайдов: {len(missing)}"
    if not ctx.judge:
        return _without_input(check, NO_JUDGE)
    if check.method == "llm":
        missing = [slide for slide in slides if slide.id not in ctx.reviews]
        failed = [slide for slide in slides if (ctx.reviews.get(slide.id) or {}).get("failed")]
        if failed:
            state, _ = _without_input(check, "")
            return state, f"Модель не ответила по слайдам: {len(failed)} — перезапустите аудит"
        return ("pending", f"Ждёт ответа модели по слайдам: {len(missing)}") if missing else ("done", None)
    # vlm: картинки видны только на рендере
    if ctx.render_status == "unavailable":
        return "unavailable", NO_RENDER
    unknown = [slide for slide in slides if slide.id not in ctx.renders]
    waiting = [sid for sid in ctx.picture_slides if sid not in ctx.image_reviews]
    failed = [sid for sid in ctx.picture_slides if (ctx.image_reviews.get(sid) or {}).get("failed")]
    if failed:
        return "unavailable", f"Модель не ответила по слайдам с картинками: {len(failed)}"
    if unknown or waiting:
        return "pending", "Ждёт рендера и ответа модели по картинкам"
    return "done", None


def plan_checks(slides: list[Slide], ctx: AuditContext) -> dict[str, CheckRun]:
    runs = {}
    for check in load_catalog():
        state, note = check_state(check, slides, ctx)
        runs[check.id] = CheckRun(check=check, state=state, note=note)
    return runs


def run_checks(slides: list[Slide], ctx: AuditContext) -> tuple[list[AuditResult], dict[str, CheckRun]]:
    runs = plan_checks(slides, ctx)
    results: list[AuditResult] = []
    for run in runs.values():
        if run.state == "unavailable" or run.check.id not in CHECKS:
            continue
        for finding in CHECKS[run.check.id](slides, ctx):
            results.append(AuditResult(finding=finding, check=run.check, fingerprint=fingerprint(finding)))
    order = {slide.id: i for i, slide in enumerate(slides)}
    results.sort(key=lambda r: order.get(r.finding.slide_id or "", -1))
    return results, runs
