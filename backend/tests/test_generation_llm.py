"""Текстовые стадии на LLM: план колоды, тексты слайдов и их путь в вёрстку (с подменой HTTP)."""

import json

import httpx
import pytest

from app.core.config import settings
from app.pipeline.ai import llm
from app.pipeline.layout.composer import compose_variants
from app.pipeline.planning import planner, writer

BRIEF = "Сервис собирает презентации по шаблону компании. Экономит до 8 часов на колоде."

PLAN_ANSWER = {
    "slides": [
        {"ref": "cover", "kind": "title", "group": "", "priority": 1, "topic": "Цифровой дизайнер",
         "insight": "", "subtitle": "Презентации по шаблону за минуты", "must_include": []},
        {"ref": "problem", "kind": "cards", "group": "problem", "priority": 1, "topic": "Проблема",
         "insight": "Ручная вёрстка съедает время команды", "subtitle": "",
         "must_include": ["8 часов на колоду", "правки идут по кругу"]},
        {"ref": "effect", "kind": "data", "group": "results", "priority": 1, "topic": "Эффект",
         "insight": "Время падает с часов до минут", "subtitle": "", "must_include": ["8 часов", "5 минут"]},
        {"ref": "closing", "kind": "closing", "group": "", "priority": 1, "topic": "Спасибо",
         "insight": "", "subtitle": "Запустим пилот", "must_include": []},
    ]
}
CARDS_ANSWER = {
    "insight": "Ручная вёрстка съедает время команды",
    "notes": "Здесь уместен пример из практики отдела.",
    "bullets": ["Колода готовится восемь часов", "Правки идут по кругу"],
    "cards": [
        {"title": "Восемь часов", "text": "Столько уходит на одну колоду"},
        {"title": "Круги правок", "text": "Текст и вёрстка правятся по очереди"},
        {"title": "Мимо бренда", "text": "Слайды расходятся с шаблоном"},
    ],
    "columns": [
        {"title": "Как сейчас", "bullets": ["Верстают руками"]},
        {"title": "Что мешает", "bullets": ["Нет единого стандарта"]},
    ],
}
DATA_ANSWER = {
    "insight": "Время падает с часов до минут",
    "notes": "",
    "data": {
        "caption": "Время подготовки колоды",
        "unit": "мин",
        "chart_type": "bar",
        "categories": ["Вручную", "Сервис"],
        # Лишнее значение в ряду — нормализация обязана подрезать его под категории.
        "series": [{"name": "Минуты", "values": [480, 5, 999]}],
        "kpis": [{"value": "×96", "label": "быстрее"}],
    },
}


@pytest.fixture
def llm_on(monkeypatch):
    """Включает LLM и подменяет транспорт: ответы отдаёт словарь по типу слайда."""
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        user = body["messages"][1]["content"]
        if "Название презентации" in user:
            answer = PLAN_ANSWER
        elif "Тип: data" in user:
            answer = DATA_ANSWER
        else:
            answer = CARDS_ANSWER
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(answer, ensure_ascii=False)}}]})

    real_client = httpx.Client
    monkeypatch.setattr(
        llm.httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs)
    )
    monkeypatch.setattr(settings, "llm_base_url", "http://llm.test/v1")
    monkeypatch.setattr(settings, "llm_model", "qwen3.8-27b")
    return calls


def test_plan_is_normalized_for_composer(llm_on):
    plan = planner.plan_outline(title="Цифровой дизайнер", purpose="product", brief=BRIEF, sources="", slides_count=5)
    assert plan.source == "llm" and plan.usage.calls == 1
    kinds = [spec["kind"] for spec in plan.specs]
    assert kinds[0] == "title" and kinds[-1] == "closing"
    cards = next(spec for spec in plan.specs if spec["ref"] == "problem")
    # cards и text композитор понимает как гибкие тезисы, data — как числа.
    assert cards["kind"] == "bullets" and cards["flexible"] and cards["plan_kind"] == "cards"
    assert cards["must_include"] == ["8 часов на колоду", "правки идут по кругу"]
    assert plan.specs[0]["subtitle"] == "Презентации по шаблону за минуты"


def test_plan_falls_back_to_brief_without_model(monkeypatch):
    monkeypatch.setattr(settings, "llm_base_url", None)
    plan = planner.plan_outline(title="Тест", purpose="product", brief=BRIEF, sources="", slides_count=8)
    assert plan.source == "brief" and plan.specs and plan.specs[0]["kind"] == "title"
    assert plan.specs[-1]["kind"] == "closing"
    assert "Без модели" in plan.detail("Продукт")
    # Ничего не придумано: на слайдах только тезисы брифа.
    texts = " ".join(" ".join([spec.get("subtitle") or "", spec.get("topic") or "", *spec.get("bullets", [])]) for spec in plan.specs[1:-1])
    assert "8 часов" in texts or "8 часов" in plan.specs[0]["subtitle"]


def test_slides_are_written_and_normalized(llm_on):
    plan = planner.plan_outline(title="Цифровой дизайнер", purpose="product", brief=BRIEF, sources="", slides_count=8)
    result = writer.write_slides(plan.specs, title="Цифровой дизайнер", purpose="Продукт", sources="")
    assert result.written == 2 and result.failed == 0
    cards_spec = next(spec for spec in plan.specs if spec["ref"] == "problem")
    assert [card["title"] for card in cards_spec["cards"]] == ["Восемь часов", "Круги правок", "Мимо бренда"]
    assert cards_spec["notes"].startswith("Здесь уместен")

    data = next(spec for spec in plan.specs if spec["ref"] == "effect")["data"]
    assert data["categories"] == ["Вручную", "Сервис"]
    assert data["series"][0]["values"] == [480.0, 5.0], "ряд подрезается под число категорий"
    # Таблица для варианта «данные таблицей» строится из тех же чисел, без нового запроса.
    assert data["table"]["rows"] == [["Вручную", "480"], ["Сервис", "5"]]
    # Служебные слайды модель не пишет: обложка и финал остаются из плана.
    assert all("bullets" not in spec for spec in plan.specs if spec["plan_kind"] in {"title", "closing"})


def test_written_plan_reaches_slides(llm_on):
    plan = planner.plan_outline(title="Цифровой дизайнер", purpose="product", brief=BRIEF, sources="", slides_count=8)
    writer.write_slides(plan.specs, title="Цифровой дизайнер", purpose="Продукт", sources="")
    drafts = compose_variants(
        plan.specs,
        axis_key="density",
        slides_count=8,
        speaker_notes=True,
        layouts=[],
        roles={},
        groups={"problem": "Проблема", "results": "Результаты"},
    )
    lean = drafts[0].slides  # вариант A: карточки и KPI
    problem = next(slide for slide in lean if slide.ref == "problem")
    assert problem.kind == "cards" and problem.columns[0].title == "Восемь часов"
    assert problem.title == "Ручная вёрстка съедает время команды", "заголовок-вывод от модели"
    assert problem.notes.startswith("Здесь уместен"), "заметка спикера от модели, а не дежурная"
    effect = next(slide for slide in lean if slide.ref == "effect")
    assert effect.kind == "kpi" and effect.kpis[0].value == "×96"
    detailed = next(slide for slide in drafts[2].slides if slide.ref == "effect")
    assert detailed.kind == "table" and detailed.table.columns == ["Показатель", "Минуты"]


def test_answer_without_expected_fields_keeps_plan_facts(llm_on, monkeypatch):
    plan = planner.plan_outline(title="Цифровой дизайнер", purpose="product", brief=BRIEF, sources="", slides_count=8)
    spec = next(item for item in plan.specs if item["ref"] == "problem")
    assert not writer._apply(spec, {"insight": "Только вывод"}, {"max_bullets": 5, "max_words": 14, "max_cards": 4})
    assert spec["bullets"] == ["8 часов на колоду", "правки идут по кругу"]


def test_short_plan_is_requested_again(llm_on):
    """План заметно короче запрошенного (4 слайда вместо 8) — один повтор с напоминанием о числе слайдов."""
    plan = planner.plan_outline(title="Цифровой дизайнер", purpose="product", brief=BRIEF, sources="", slides_count=8)
    assert plan.usage.calls == 2
    assert "нужно ровно 8" in llm_on[-1]["messages"][1]["content"]
