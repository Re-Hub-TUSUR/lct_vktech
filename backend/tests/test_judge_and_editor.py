"""Модель-судья аудита и правка слайда моделью (с подменой HTTP): вердикты, кэш, проверки, исправления."""

import json

import httpx
import pytest

from app.core.config import settings
from app.pipeline.ai import llm
from app.pipeline.audit.catalog import AuditContext, catalog_by_id, limits
from app.pipeline.audit.fixes import EditorContext, FixContext, IssueRef, apply_editor_fixes, apply_fixes, editor_issues
from app.pipeline.audit.review import ReviewCache, review_deck
from app.pipeline.audit.runner import run_checks
from app.pipeline.planning.editor import EditError, edit_slide
from app.schemas.slide import ChartData, ChartSeries, Column, Slide, TableData

THEME = {
    "background": "#FFFFFF",
    "text": "#000000",
    "accent": "#0077FF",
    "accents": ["#0077FF"],
    "cover": {"background": "#0077FF", "text": "#FFFFFF"},
    "section": {"background": "#0077FF", "text": "#FFFFFF"},
    "closing": {"background": "#0077FF", "text": "#FFFFFF"},
}


def deck() -> list[Slide]:
    return [
        Slide(id="s1", kind="title", title="Цифровой дизайнер", subtitle="Презентации за минуты", layout_key="0:1"),
        Slide(id="s2", kind="bullets", title="Проблема", layout_key="0:1",
              bullets=["Вёрстка занимает 8 часов", "Правки разбираеться по кругу"]),
        Slide(id="s3", kind="table", title="Сервис ускоряет подготовку колоды", layout_key="0:1",
              table=TableData(columns=["Этап", "Вручную", "Сервис"],
                              rows=[["Вёрстка", "8 ч", "5 мин"], ["Любимый цвет", "синий", "синий"]])),
        Slide(id="s4", kind="bullets", title="Погода на выходных", layout_key="0:1", bullets=["Солнечно, до +18"]),
    ]


VERDICTS = {
    "slides": [
        {"n": 2, "title_is_topic": True, "content_mismatch": False, "better_title": "Ручная вёрстка отнимает 8 часов",
         "summary": "Ручная вёрстка медленная", "unsupported": [], "typos": [{"wrong": "разбираеться", "right": "разбирается"}],
         "service": [], "foreign": [], "irrelevant": [], "flow_break": False},
        {"n": 3, "title_is_topic": False, "content_mismatch": False, "better_title": "", "summary": "Сервис быстрее",
         "unsupported": [], "typos": [{"wrong": "несуществующее", "right": "слово"}], "service": [], "foreign": [],
         "irrelevant": ["Любимый цвет"], "flow_break": False},
        {"n": 4, "title_is_topic": False, "content_mismatch": False, "better_title": "", "summary": "",
         "unsupported": ["+18"], "typos": [], "service": [], "foreign": [], "irrelevant": [], "flow_break": True},
        {"n": 1, "title_is_topic": False, "content_mismatch": False, "better_title": "", "summary": "Обложка",
         "unsupported": [], "typos": [], "service": [], "foreign": [], "irrelevant": [], "flow_break": False},
    ]
}


@pytest.fixture
def model(monkeypatch):
    """Подменяет транспорт модели; answers — очередь ответов (None — сбой сервера)."""
    state = {"answers": [], "calls": []}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        state["calls"].append(body)
        answer = state["answers"].pop(0) if state["answers"] else None
        if answer is None:
            return httpx.Response(500, json={"error": "down"})
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(answer, ensure_ascii=False)}}]})

    real_client = httpx.Client
    monkeypatch.setattr(llm.httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(llm, "RETRY_DELAYS", [0, 0, 0])
    monkeypatch.setattr(settings, "llm_base_url", "http://llm.test/v1")
    monkeypatch.setattr(settings, "llm_model", "qwen3.8-27b")
    return state


def reviewed_ctx(model) -> tuple[list[Slide], AuditContext, ReviewCache]:
    slides = deck()
    model["answers"].append(VERDICTS)
    cache = ReviewCache(judge="qwen3.8-27b")
    outcome = review_deck(slides, title="Цифровой дизайнер", language="ru", sources="Вёрстка занимает 8 часов", cache=cache)
    ctx = AuditContext(
        theme=THEME, layout_keys={"0:1"}, limits=limits(), sources_text="Вёрстка занимает 8 часов",
        judge="qwen3.8-27b", reviews=outcome.reviews,
    )
    return slides, ctx, cache


def test_deck_review_is_cached_per_slide(model):
    slides, ctx, cache = reviewed_ctx(model)
    assert len(model["calls"]) == 1 and len(ctx.reviews) == 4
    request = model["calls"][0]
    assert request["temperature"] == 0 and "Проверь слайды: 1, 2, 3, 4" in request["messages"][1]["content"]
    # Повторный разбор той же колоды — из кэша, без запроса.
    again = review_deck(slides, title="Цифровой дизайнер", language="ru", sources="Вёрстка занимает 8 часов", cache=cache)
    assert len(model["calls"]) == 1 and again.reviewed == 0 and len(again.reviews) == 4
    # Изменился один слайд — судья получает только его.
    slides[3].bullets = ["Солнечно"]
    model["answers"].append({"slides": [{**VERDICTS["slides"][2], "n": 4}]})
    partial = review_deck(slides, title="Цифровой дизайнер", language="ru", sources="Вёрстка занимает 8 часов", cache=cache)
    assert "Проверь слайды: 4." in model["calls"][1]["messages"][1]["content"] and partial.reviewed == 1


def test_failed_review_falls_back_to_rules(model):
    slides = deck()
    model["answers"] += [None, None]  # сервер лежит: и запрос, и повтор после 500 не удались
    outcome = review_deck(slides, title="Т", language="ru", sources="", cache=ReviewCache(judge="qwen3.8-27b"))
    assert all(verdict.get("failed") for verdict in outcome.reviews.values())
    ctx = AuditContext(theme=THEME, layout_keys={"0:1"}, limits=limits(), judge="qwen3.8-27b", reviews=outcome.reviews)
    results, runs = run_checks(slides, ctx)
    assert runs["content.title_is_insight"].state == "fallback", "короткий заголовок — тема по правилу"
    assert runs["content.typos"].state == "unavailable"
    assert "content.title_is_insight" in {r.finding.check_id for r in results}


def test_verdicts_become_findings(model):
    slides, ctx, _ = reviewed_ctx(model)
    results, runs = run_checks(slides, ctx)
    by_check = {}
    for result in results:
        by_check.setdefault(result.finding.check_id, []).append(result.finding)
    title = by_check["content.title_is_insight"][0]
    assert title.slide_id == "s2" and title.evidence == "Ручная вёрстка отнимает 8 часов"
    typos = by_check["content.typos"]
    assert [t.evidence for t in typos] == ["разбираеться → разбирается"], "опечатка, которой нет на слайде, не показывается"
    assert by_check["content.table_relevance"][0].evidence == "Любимый цвет"
    assert {f.slide_id for f in by_check["content.logical_flow"]} == {"s4"}
    assert {f.slide_id for f in by_check["content.one_sentence"]} == {"s4"}
    assert "+18" in by_check["content.facts_grounded"][0].message
    assert runs["content.typos"].state == "done"
    assert runs["content.images_relevant"].state == "unavailable", "картинки судья видит только на рендере"


def test_judge_fixes_apply_without_model(model):
    slides, ctx, _ = reviewed_ctx(model)
    results, _ = run_checks(slides, ctx)
    wanted = {"content.title_is_insight", "content.typos", "content.table_relevance"}
    refs = [
        IssueRef(str(i), r.finding.check_id, r.finding.slide_id, r.finding.target, r.finding.evidence, r.finding.message)
        for i, r in enumerate(results)
        if r.finding.check_id in wanted
    ]
    fixed, applied = apply_fixes(slides, refs, FixContext(limits=ctx.limits))
    assert len(applied) == len(refs) == 3
    assert fixed[1].title == "Ручная вёрстка отнимает 8 часов" and fixed[1].summary == fixed[1].title
    assert fixed[1].bullets[1] == "Правки разбирается по кругу"
    assert [row[0] for row in fixed[2].table.rows] == ["Вёрстка"]


def test_editor_rewrites_within_pattern_limits(model):
    slide = Slide(id="c1", kind="cards", title="Проблема", layout_key="0:1",
                  columns=[Column(title="Время", bullets=["8 часов на колоду"])] * 3)
    pattern = {"schema": {"type": "cards", "title": 40, "items": {"min": 3, "max": 3, "fields": {"title": 16, "text": 60}}}}
    model["answers"].append({
        "reply": "Сделал заголовок выводом и сократил карточки.",
        "title": "Ручная вёрстка отнимает 8 часов",
        "notes": "Начните с примера.",
        "columns": [{"title": f"Карточка {i}", "bullets": ["Коротко"]} for i in range(5)],
    })
    result = edit_slide(slide, "Сделай заголовок выводом", deck=[slide], title="Т", purpose="Продукт",
                        brief="Вёрстка занимает 8 часов", sources="", pattern=pattern)
    prompt = model["calls"][0]["messages"][0]["content"]
    assert "элементов — от 3 до 3" in prompt and "заголовок — не длиннее 40 знаков" in prompt
    assert result.reply.startswith("Сделал") and result.slide.kind == "cards"
    assert len(result.slide.columns) == 3, "карточек не больше, чем слотов в паттерне"
    assert result.slide.title == result.slide.summary == "Ручная вёрстка отнимает 8 часов"
    schema = model["calls"][0]["response_format"]["json_schema"]["schema"]
    assert "columns" in schema["properties"] and "bullets" not in schema["properties"]


def test_editor_chart_edit_goes_through_visual_rules(model):
    slide = Slide(id="c2", kind="chart", title="Сервис быстрее ручной вёрстки", layout_key="0:1",
                  chart=ChartData(type="bar", unit="мин", categories=["Вручную", "Сервис"],
                                  series=[ChartSeries(name="Минуты", values=[480, 5])], highlight=1))
    model["answers"].append({
        "reply": "Добавил этап правок.", "title": slide.title, "notes": "",
        "chart": {"type": "line", "caption": "Время, мин", "unit": "мин", "categories": ["Вручную", "Правки", "Сервис"],
                  "series": [{"name": "Минуты", "values": [480.4, 120, 5, 7]}]},
    })
    result = edit_slide(slide, "Добавь этап правок", deck=[slide], title="Т", purpose="Продукт", brief="", sources="")
    chart = result.slide.chart
    assert chart.categories == ["Вручную", "Правки", "Сервис"] and chart.series[0].values == [480.0, 120.0, 5.0]
    assert chart.type == "bar", "линия без оси времени становится столбцами"
    assert chart.highlight == 2, "выделение осталось на той же категории"


def test_editor_without_model_raises(monkeypatch):
    monkeypatch.setattr(settings, "llm_base_url", None)
    with pytest.raises(EditError):
        edit_slide(Slide(kind="bullets", title="Т"), "Сократи", deck=[], title="Т", purpose="", brief="", sources="")


def test_audit_fixes_go_to_editor_in_one_request_per_slide(model):
    slides, ctx, _ = reviewed_ctx(model)
    results, _ = run_checks(slides, ctx)
    refs = [
        IssueRef(str(i), r.finding.check_id, r.finding.slide_id, r.finding.target, r.finding.evidence, r.finding.message)
        for i, r in enumerate(results)
        if r.finding.slide_id == "s4" and r.check.fixable
    ]
    catalog = catalog_by_id()
    by_model = editor_issues(refs, catalog)
    assert {ref.check_id for ref in by_model} >= {"content.logical_flow", "content.one_sentence", "content.facts_grounded"}
    model["answers"].append({"reply": "Связал с предыдущим слайдом.", "title": "Сервис освобождает выходные команды",
                             "notes": "", "bullets": ["Колода готова за пять минут"]})
    editor = EditorContext(title="Т", purpose="Продукт", brief="", sources="")
    fixed, applied = apply_editor_fixes(slides, by_model, catalog, editor, limits())
    assert len(model["calls"]) == 2, "все проблемы слайда — одним запросом"
    assert "Исправь на слайде" in model["calls"][1]["messages"][1]["content"]
    assert set(applied) == {ref.id for ref in by_model}
    assert fixed[3].bullets == ["Колода готова за пять минут"] and slides[3].bullets == ["Солнечно, до +18"]


def test_editor_keeps_pattern_minimum(model):
    """Модель убрала показатель, а паттерн рассчитан на три: недостающий берётся из исходного слайда."""
    from app.schemas.slide import Kpi

    slide = Slide(id="k1", kind="kpi", title="Пилот охватил три команды", layout_key="0:1",
                  kpis=[Kpi(value="84", label="презентации"), Kpi(value="3", label="команды"), Kpi(value="42", label="продажи")])
    pattern = {"schema": {"type": "kpi", "title": 60, "items": {"min": 3, "max": 3, "fields": {"value": 6, "text": 30}}}}
    model["answers"].append({"reply": "Убрал лишний показатель.", "title": slide.title, "notes": "",
                             "kpis": [{"value": "84", "label": "презентации"}, {"value": "3", "label": "команды"}]})
    result = edit_slide(slide, "Сократи", deck=[slide], title="Т", purpose="", brief="", sources="", pattern=pattern)
    assert [kpi.value for kpi in result.slide.kpis] == ["84", "3", "42"]


def test_relayout_after_edit_touches_only_edited_slide():
    """После правки моделью вёрстка подбирается только правленому слайду; соседние сохраняют паттерн и макет."""
    from app.api.routes.variants import relayout_edited_slide

    slides = deck()
    for slide in slides:
        slide.pattern_id, slide.layout_key = "s9", "0:5"
    edited = slides[1]
    # Паттернов нет — правленый слайд уходит на макет своей роли, остальные не меняются.
    relayout_edited_slide(edited, [], {"content": "0:2", "title": "0:0"}, [{"key": "0:2", "name": "Контент"}])
    assert (edited.pattern_id, edited.layout_key, edited.layout_name) == (None, "0:2", "Контент")
    assert all((s.pattern_id, s.layout_key) == ("s9", "0:5") for s in slides if s is not edited)


def test_relayout_lives_in_layout_layer():
    """Маршруты и сервис аудита используют одну функцию переподбора вёрстки правленого слайда."""
    from app.api.routes import variants
    from app.pipeline.layout import composer
    from app.services import audit

    assert variants.relayout_edited_slide is composer.relayout_edited_slide
    assert audit.relayout_edited_slide is composer.relayout_edited_slide
