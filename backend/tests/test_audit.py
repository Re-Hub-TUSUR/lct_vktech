from app.pipeline.audit.catalog import AuditContext, limits, load_catalog
from app.pipeline.audit.checks import CHECKS
from app.pipeline.audit.fixes import FIXES, FixContext, IssueRef, apply_fixes, shorten
from app.pipeline.audit.runner import run_checks
from app.schemas.slide import ChartData, ChartSeries, Slide, TableData

THEME = {
    "background": "#FFFFFF",
    "text": "#000000",
    "muted": "#737373",
    "accent": "#0077FF",
    "accents": ["#0077FF"],
    "surface": "#E6F1FF",
    "cover": {"background": "#0077FF", "text": "#FFFFFF"},
    "section": {"background": "#0077FF", "text": "#FFFFFF"},
    "closing": {"background": "#0077FF", "text": "#FFFFFF"},
    "heading_font": "Arial",
    "body_font": "Arial",
    "aspect": 16 / 9,
}


def make_ctx(**overrides) -> AuditContext:
    return AuditContext(theme=THEME, layout_keys={"0:1"}, limits=limits(), **overrides)


def found(slides: list[Slide], ctx: AuditContext | None = None) -> set[str]:
    return {result.finding.check_id for result in run_checks(slides, ctx or make_ctx())}


def content_slide(**fields) -> Slide:
    defaults = {"kind": "bullets", "title": "Сервис сокращает подготовку презентаций", "layout_key": "0:1"}
    return Slide(**(defaults | fields))


def test_catalog_is_consistent():
    catalog = load_catalog()
    ids = [check.id for check in catalog]
    assert len(ids) == len(set(ids)), "идентификаторы проверок должны быть уникальны"
    for check in catalog:
        if check.status in {"implemented", "heuristic"}:
            assert check.id in CHECKS, f"нет реализации для {check.id}"
        if check.fixable:
            assert check.id in FIXES, f"нет автоисправления для {check.id}"


def test_clean_slide_passes():
    slide = content_slide(bullets=["Шаблон разбирается автоматически", "Три варианта вёрстки"])
    assert found([slide]) == set()


def test_density_checks():
    slide = content_slide(bullets=[f"Тезис номер {i}" for i in range(8)])
    long = content_slide(bullets=["слово " * 20])
    table = Slide(
        kind="table", title="Таблица показателей по кварталам", layout_key="0:1",
        table=TableData(columns=["a", "b"], rows=[["1", "2"]] * 9),
    )
    result = found([slide, long, table])
    assert {"density.max_bullets", "density.bullet_words", "density.table_size"} <= result


def test_integrity_checks():
    todo = content_slide(bullets=["TODO: вставьте цифры"])
    empty = Slide(kind="bullets", title="Пустой слайд без содержания", layout_key="0:1")
    chart = Slide(
        kind="chart", title="Рост аудитории сервиса", layout_key="0:1",
        chart=ChartData(categories=["2025", "2026"], series=[ChartSeries(name="", values=[1, 2])]),
    )
    result = found([todo, empty, chart, todo.model_copy(update={"id": "copy"})])
    assert {
        "integrity.placeholder_text",
        "integrity.empty_slide",
        "integrity.chart_labels",
        "integrity.duplicates",
    } <= result


def test_template_checks():
    foreign = Slide(kind="bullets", title="Слайд на чужом макете", bullets=["Тезис"], layout_key="9:9")
    assert "template.layout_from_template" in found([foreign])
    low_contrast = AuditContext(theme=dict(THEME, text="#CCCCCC"), layout_keys={"0:1"}, limits=limits())
    assert "template.contrast" in found([content_slide(bullets=["Тезис"])], low_contrast)


def test_content_heuristics():
    topic = content_slide(title="Проблема", bullets=["Тезис без цифр"])
    numbers = content_slide(bullets=["Рост выручки на 37%"])
    note = content_slide(bullets=["Заметка для спикера: рассказать про пилот"])
    assert {"content.title_is_insight", "content.facts_grounded", "content.service_text"} <= found(
        [topic, numbers, note]
    )
    # Цифра из брифа считается подтверждённой.
    assert "content.facts_grounded" not in found([numbers], make_ctx(sources_text="Выручка выросла на 37%"))


def test_fixes_resolve_findings():
    slides = [
        content_slide(title="Проблема", summary="Ручная вёрстка отнимает часы", bullets=[f"Тезис {i}" for i in range(8)]),
        content_slide(bullets=["Нормальный тезис", "TODO: вставьте цифры", "слово " * 20]),
    ]
    ctx = make_ctx()
    results = run_checks(slides, ctx)
    issues = [
        IssueRef(str(i), r.finding.check_id, r.finding.slide_id, r.finding.target, r.finding.evidence)
        for i, r in enumerate(results)
        if r.check.fixable
    ]
    fixed, applied = apply_fixes(slides, issues, FixContext(limits=ctx.limits))
    assert applied
    remaining = found(fixed, ctx)
    assert not remaining & {
        "density.max_bullets",
        "density.bullet_words",
        "integrity.placeholder_text",
        "content.title_is_insight",
    }
    assert len(fixed) == 3, "слайд с 8 тезисами должен разделиться на два"


def test_shorten_keeps_short_text():
    assert shorten("Короткий тезис") == "Короткий тезис"
    assert len(shorten("слово " * 30, 15).split()) <= 15
