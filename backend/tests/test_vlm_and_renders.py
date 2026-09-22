"""VLM-разметка паттернов (с подменой HTTP) и состояние превью вариантов (без БД)."""

import copy
import json
import uuid
from types import SimpleNamespace

import httpx
import pytest

from app.core.config import settings
from app.pipeline.ai import vlm
from app.services import renders


def _pattern(parsed) -> dict:
    _, result = parsed
    return copy.deepcopy(next(p for p in result.patterns if p["usable"] and p["items"]))


def test_apply_label_keeps_geometry_and_title(parsed):
    pattern = _pattern(parsed)
    slot = pattern["items"][0]["slots"][0]
    label = vlm.PatternLabel(
        type="timeline",
        category="content",
        purpose="Этапы проекта",
        usage="Шаги с короткими подписями",
        confidence=0.9,
        roles={str(slot["id"]): "date", str(pattern["title"]["id"]): "text"},
    )
    assert vlm.apply_label(pattern, label)
    assert pattern["type"] == "timeline" and pattern["source"] == "vlm"
    assert slot["role"] == "date"
    assert pattern["title"]["role"] == "title", "роль заголовка слайда VLM не меняет"
    assert pattern["usable"]


def test_low_confidence_and_service_category_are_respected(parsed):
    pattern = _pattern(parsed)
    before = copy.deepcopy(pattern)
    assert not vlm.apply_label(pattern, vlm.PatternLabel(type="kpi", confidence=0.2))
    assert pattern == before
    assert vlm.apply_label(pattern, vlm.PatternLabel(type=pattern["type"], category="closing", confidence=0.8))
    assert not pattern["usable"], "финальный слайд не должен уходить под контент"


def test_enrich_patterns_with_openai_compatible_api(parsed, tmp_path, monkeypatch):
    patterns = [_pattern(parsed)]
    patterns[0]["render"] = "1.jpg"
    (tmp_path / "1.jpg").write_bytes(b"\xff\xd8\xff\xe0 fake jpeg")
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        if "response_format" in body:
            return httpx.Response(400, json={"error": "response_format is not supported"})
        answer = {"type": "cards", "category": "content", "purpose": "Преимущества", "confidence": 0.8, "roles": {}}
        return httpx.Response(200, json={"choices": [{"message": {"content": "```json\n" + json.dumps(answer) + "\n```"}}]})

    real_client = httpx.Client
    monkeypatch.setattr(vlm.httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(settings, "vlm_base_url", "http://vlm.test/v1")
    monkeypatch.setattr(settings, "vlm_model", "qwen3.8-27b")
    stats = vlm.enrich_patterns(patterns, tmp_path)
    assert {key: stats[key] for key in ("model", "requested", "labeled", "failed")} == {
        "model": "qwen3.8-27b",
        "requested": 1,
        "labeled": 1,
        "failed": 0,
    }
    assert patterns[0]["source"] == "vlm" and patterns[0]["purpose"] == "Преимущества"
    # Сначала строгая json_schema, затем json_object, после двух 400 — запрос без response_format.
    assert requests[0]["response_format"]["type"] == "json_schema"
    assert requests[1]["response_format"]["type"] == "json_object"
    assert len(requests) == 3 and "response_format" not in requests[2]
    # Рассуждения выключены, картинка уходит в data URL.
    assert requests[2]["reasoning"] == {"enabled": False}
    content = requests[2]["messages"][1]["content"]
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_role_changes_are_limited_to_fillable_roles(parsed):
    pattern = _pattern(parsed)
    item_slot = pattern["items"][0]["slots"][0]
    before = item_slot["role"]
    # «body» у элемента серии сборка не заполняет — такую правку модель сделать не может.
    changed = vlm.apply_label(
        pattern,
        vlm.PatternLabel(type=pattern["type"], confidence=0.9, roles=[{"id": item_slot["id"], "role": "body"}]),
    )
    assert changed is not None and not changed["roles"]
    assert item_slot["role"] == before


def test_type_must_fit_structure(parsed):
    pattern = _pattern(parsed)
    if "table" in pattern["frames"]:
        pytest.skip("у примера есть таблица")
    before = pattern["type"]
    changed = vlm.apply_label(pattern, vlm.PatternLabel(type="table", confidence=0.9))
    assert changed is not None and not changed["type"] and pattern["type"] == before


def test_vlm_is_optional(monkeypatch):
    monkeypatch.setattr(settings, "vlm_base_url", None)
    assert not vlm.vlm_enabled()


def _variant(slides, render=None):
    return SimpleNamespace(id=uuid.uuid4(), slides=slides, renders=render or {})


def test_render_state_tracks_slide_revision(monkeypatch, tmp_path):
    template = SimpleNamespace(id=uuid.uuid4(), parser_version="0.4.0", file_path=str(tmp_path / "t.pptx"))
    slides = [{"id": "a", "kind": "title", "title": "Обложка"}]
    revision = renders.slides_revision(slides, template)
    assert revision == renders.slides_revision(copy.deepcopy(slides), template)
    assert revision != renders.slides_revision([{**slides[0], "title": "Другая"}], template)

    monkeypatch.setattr(renders, "renders_supported", lambda template: True)
    stale = _variant(slides, {"rev": "000000000000", "status": "ready", "slides": [{"image": "1.jpg"}]})
    assert renders.render_state(stale, template) == {"status": "pending", "slides": []}

    ready = _variant(slides, {"rev": revision, "status": "ready", "slides": [{"image": "1.jpg", "targets": {"title": [0, 0, 1, 0.2]}}]})
    state = renders.render_state(ready, template)
    assert state["status"] == "ready"
    assert state["slides"][0]["image"] == f"/api/variants/{ready.id}/renders/{revision}/1.jpg"
    assert state["slides"][0]["targets"]["title"] == [0, 0, 1, 0.2]

    monkeypatch.setattr(renders, "renders_supported", lambda template: False)
    assert renders.render_state(_variant(slides), template)["status"] == "unavailable"


def test_rendered_images_need_all_files(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "storage_dir", tmp_path)
    template = SimpleNamespace(id=uuid.uuid4(), parser_version="0.4.0")
    slides = [{"id": "a", "kind": "title", "title": "Обложка"}, {"id": "b", "kind": "closing", "title": "Спасибо"}]
    revision = renders.slides_revision(slides, template)
    variant = _variant(slides, {"rev": revision, "status": "ready", "slides": [{"image": "1.jpg"}, {"image": "2.jpg"}]})
    directory = renders.variant_dir(variant.id) / revision
    directory.mkdir(parents=True)
    (directory / "1.jpg").write_bytes(b"one")
    assert renders.rendered_images(variant, template) is None
    (directory / "2.jpg").write_bytes(b"two")
    assert renders.rendered_images(variant, template) == [b"one", b"two"]


@pytest.mark.parametrize("status", ["pending", "failed"])
def test_render_state_passes_status(monkeypatch, status):
    template = SimpleNamespace(id=uuid.uuid4(), parser_version="0.4.0")
    slides = [{"id": "a", "kind": "title", "title": "Обложка"}]
    variant = _variant(slides, {"rev": renders.slides_revision(slides, template), "status": status})
    monkeypatch.setattr(renders, "renders_supported", lambda template: True)
    assert renders.render_state(variant, template) == {"status": status, "slides": []}
