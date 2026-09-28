"""Качество текстовой генерации: вариант C, слайды без картинок, типографика, бюджеты слотов,
редактура колоды, подгонка текста под слоты, повтор автора текстов, судья по картинкам."""

import json

import httpx
import pytest

from app.core.config import settings
from app.pipeline.ai import llm
from app.pipeline.audit.review import picture_slides
from app.pipeline.layout.composer import compose_variants
from app.pipeline.layout.fitting import fit_drafts
from app.pipeline.planning import deck_editor, planner, writer
from app.pipeline.planning.budgets import budget_lines, overflow_ratio, template_budgets
from app.pipeline.planning.outline import group_labels
from app.pipeline.planning.typography import NBSP, polish
from app.schemas.slide import Slide
from tests.plans import plan


@pytest.fixture
def model(monkeypatch):
    """Подменяет транспорт модели: answers — очередь ответов (строка — сырое содержимое, None — сбой)."""
    state = {"answers": [], "calls": []}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        state["calls"].append(body)
        answer = state["answers"].pop(0) if state["answers"] else None
        if answer is None:
            return httpx.Response(500, json={"error": "down"})
        content = answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False)
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    real_client = httpx.Client
    monkeypatch.setattr(llm.httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(llm, "RETRY_DELAYS", [0, 0, 0])
    monkeypatch.setattr(settings, "llm_base_url", "http://llm.test/v1")
    monkeypatch.setattr(settings, "llm_model", "qwen3.8-27b")
    return state


def compose(parsed, axis: str, images_available: bool = True):
    _, result = parsed
    return compose_variants(
        plan(), axis_key=axis, slides_count=12, speaker_notes=True, layouts=result.layouts, roles=result.roles,
        groups=group_labels(), patterns=result.patterns, images_available=images_available,
    )


def test_variant_c_keeps_insight_titles(parsed):
    """Третий вариант отличается подачей, а не качеством: заголовки-выводы, как у A и B."""
    for axis in ("density", "structure"):
        c = compose(parsed, axis)[2]
        content = [s for s in c.slides if s.kind not in {"title", "section", "closing", "agenda"}]
        insights = {spec["insight"] for spec in plan() if spec.get("insight")}
        assert all(slide.title in insights for slide in content), [s.title for s in content]
        assert len(c.slides) <= 12 + 4


def test_no_empty_image_frames_without_photos(parsed):
    drafts = compose(parsed, "layouts", images_available=False)
    assert not any(slide.kind == "image_text" for draft in drafts for slide in draft.slides)
    assert drafts[2].name == "Колонки и показатели"
    with_photos = compose(parsed, "layouts", images_available=True)
    assert with_photos[2].name == "Текст и изображение"


def test_typography():
    text = polish('Вёрстка занимает 8 ч и в рамках пилота - 3-4 команды, "Дизайнер" для 15000 сотрудников')
    assert f"8{NBSP}ч" in text and f"и{NBSP}в{NBSP}рамках" in text
    assert f"пилота{NBSP}— 3–4" in text and "«Дизайнер»" in text and f"15{NBSP}000" in text
    assert polish("План на 2025-2026 годы") == f"План на{NBSP}2025–2026 годы"
    assert polish("Plan - done", "en") == "Plan - done"


def text_pattern(result):
    pattern = next((p for p in result.patterns if p.get("usable") and p.get("type") == "text"), None)
    if pattern is None:
        pytest.skip("в шаблоне нет текстовых паттернов")
    return pattern


def test_budgets_and_overflow(parsed):
    _, result = parsed
    budgets = template_budgets(result.patterns)
    assert budgets.get("title", {}).get("chars", 0) > 20
    assert "заголовок-вывод — до" in budget_lines(budgets)
    pattern = text_pattern(result)
    body = sum(slot["chars"] for slot in pattern["slots"] if slot["role"] == "body")
    short = Slide(kind="bullets", title="Коротко", bullets=["Тезис"])
    long = Slide(kind="bullets", title="Коротко", bullets=["слово " * (body // 3)])
    assert overflow_ratio(short, pattern) < 1 < overflow_ratio(long, pattern)


def test_deck_editor_applies_safe_replacements(model):
    specs = plan()
    specs[1]["bullets"] = ["Колода готовится восемь часов", "Правки идут по кругу"]
    specs[2]["bullets"] = ["Презентация собирается по шаблону", "Правки идут по кругу"]
    model["answers"].append({
        "replacements": [
            {"n": 0, "old": "Колода", "new": "Презентация"},
            {"n": 3, "old": "Правки идут по кругу", "new": "Круги правок исчезают"},
            {"n": 2, "old": "восемь часов", "new": "десять часов"},  # меняет факт — не применяется
            {"n": 2, "old": "восемь", "new": "8"},  # меняет число — не применяется
        ],
        "notes": [{"n": 2, "text": "Покажите цену ручной работы и переходите к решению."}],
    })
    result = deck_editor.edit_deck(specs, title="Т", purpose="Продукт")
    assert specs[1]["bullets"][0] == f"Презентация готовится восемь часов"
    assert specs[2]["bullets"][1] == "Круги правок исчезают"
    assert specs[1]["notes"].startswith("Покажите цену")
    assert result.replaced == 2 and result.rejected == 2 and result.notes == 1


def test_writer_retries_without_schema_after_reasoning(model):
    specs = plan()
    targets = [s for s in specs if s.get("plan_kind") not in {"title", "closing"}]
    card_answer = {
        "insight": "Ручная вёрстка съедает часы команды", "notes": "",
        "bullets": ["Колода готовится восемь часов"],
        "cards": [{"title": "Время", "text": "8 часов на колоду"}, {"title": "Правки", "text": "Три круга"},
                  {"title": "Бренд", "text": "Разнобой"}],
        "columns": [{"title": "Сейчас", "bullets": ["Руками"]}, {"title": "С сервисом", "bullets": ["По шаблону"]}],
    }
    # Первый ответ — рассуждение вместо JSON, второй (повтор) — JSON.
    model["answers"] += ["I need to return a valid JSON object. Let me analyze..."] + [card_answer] * (2 * len(targets))
    result = writer.write_slides(specs, title="Т", purpose="Продукт", sources="", patterns=None)
    retries = [call for call in model["calls"] if "response_format" not in call or call["response_format"]["type"] != "json_schema"]
    assert retries, "повтор идёт без навязанной схемы"
    assert "только JSON-объект" in retries[0]["messages"][0]["content"]
    assert result.written >= 1
    first = model["calls"][0]["messages"]
    assert "План колоды:" in first[0]["content"] and "Слайд №" in first[1]["content"]


def test_planner_storyline_and_no_image_kind(model):
    model["answers"].append({"slides": [
        {"ref": "cover", "kind": "title", "group": "", "priority": 1, "topic": "Т", "insight": "", "subtitle": "П", "must_include": []},
        {"ref": "closing", "kind": "closing", "group": "", "priority": 1, "topic": "Спасибо", "insight": "", "subtitle": "", "must_include": []},
    ]})
    planner.plan_outline(title="Т", purpose="feature", brief="Бриф", sources="", slides_count=6, images_available=False)
    system = model["calls"][0]["messages"][0]["content"]
    schema = model["calls"][0]["response_format"]["json_schema"]["schema"]
    assert "боль пользователя → решение" in system
    assert "- image_text:" not in system
    assert "image_text" not in schema["properties"]["slides"]["items"]["properties"]["kind"]["enum"]


def test_fitting_shortens_overflowing_slides(parsed, model):
    _, result = parsed
    drafts = compose(parsed, "density")
    pattern = text_pattern(result)
    body = sum(slot["chars"] for slot in pattern["slots"] if slot["role"] == "body")
    slide = drafts[1].slides[1]
    slide.kind, slide.pattern_id, slide.columns = "bullets", pattern["id"], []
    slide.bullets = ["очень длинный тезис " * (body // 8)]  # примерно в 2.5 раза длиннее ёмкости
    # Переполненных слайдов может быть несколько, запросы идут параллельно — ответ на каждый.
    model["answers"] += [{"reply": "Сократил.", "title": slide.title, "notes": "", "bullets": ["Короткий тезис"]}] * 30
    fitted = fit_drafts(drafts, result.patterns, layout_names={}, title="Т", purpose="Продукт", brief="", sources="",
                        threshold=1.2)
    assert fitted.shortened >= 1 and drafts[1].slides[1].bullets == ["Короткий тезис"]
    assert "текст сокращён под слоты" in fitted.detail()


def test_judge_sees_only_content_pictures():
    slides = [Slide(id="a", kind="bullets", title="Т"), Slide(id="b", kind="image_text", title="Т")]
    renders = {
        "a": {"facts": {"pictures": [{"bbox": [0.5, 0.2, 0.4, 0.6], "user": False}]}},  # декор шаблона
        "b": {"facts": {"pictures": [{"bbox": [0.5, 0.2, 0.4, 0.6], "user": True}]}},  # фото из материалов
    }
    assert picture_slides(slides, renders) == {"b"}
