"""Парсер 0.5: форматы шаблонов, паттерны из макетов, служебные паттерны, диаграммы, токены дизайн-системы."""

import io
import zipfile

import pytest
from pptx import Presentation

from app.pipeline.export.pptx_export import build_deck
from app.pipeline.layout.matcher import pattern_score
from app.pipeline.parsing import patterns as patterns_module
from app.pipeline.parsing.formats import PPTX_MAIN, normalize_template
from app.pipeline.parsing.layout_patterns import PH_BASE
from app.pipeline.parsing.template_parser import parse_template
from app.pipeline.theme import slide_theme
from app.schemas.slide import ChartData, ChartSeries, Slide

POTX_MAIN = "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml"


def test_layouts_count(parsed):
    _, result = parsed
    assert result.layouts_count == len(result.layouts)


def test_potx_is_normalized(parsed, tmp_path):
    path, _ = parsed
    potx = tmp_path / "template.potx"
    with zipfile.ZipFile(path) as src, zipfile.ZipFile(potx, "w", zipfile.ZIP_DEFLATED) as out:
        for info in src.infolist():
            data = src.read(info.filename)
            if info.filename == "[Content_Types].xml":
                data = data.replace(PPTX_MAIN.encode(), POTX_MAIN.encode())
            out.writestr(info, data)
    with pytest.raises(Exception):
        Presentation(str(potx))  # python-pptx не открывает шаблон .potx как есть
    normalized = normalize_template(potx, tmp_path / "normalized.pptx")
    assert len(Presentation(str(normalized)).slides) > 0


def test_design_tokens(parsed):
    _, result = parsed
    tokens = result.tokens
    typography = tokens["typography"]
    assert typography and typography["title"]["font"] and typography["body"]["font"]
    grid = tokens["grid"]
    assert grid and all(value is None or 0 <= value < 0.4 for value in grid["margins"].values())
    assert tokens["chrome"] is not None and "slide_number" in tokens["chrome"]
    assert "fonts_check" in tokens and "table_style" in tokens and "chart_style" in tokens


def test_every_pattern_has_schema(parsed):
    _, result = parsed
    for pattern in result.patterns:
        assert pattern["schema"]["type"] == pattern["type"]
        if pattern["usable"]:
            assert pattern["schema"]["title"] == pattern["title"]["chars"]


def test_layout_patterns_reference_placeholders(parsed):
    _, result = parsed
    for pattern in (p for p in result.patterns if p.get("origin") == "layout"):
        assert pattern["usable"] and pattern["layout_key"]
        ids = [pattern["title"]["id"], *(s["id"] for s in pattern["slots"])]
        ids += [s["id"] for item in pattern["items"] for s in item["slots"]]
        assert all(slot_id >= PH_BASE for slot_id in ids)


def test_service_patterns(parsed):
    _, result = parsed
    for pattern in (p for p in result.patterns if p.get("service")):
        assert pattern["category"] in {"cover", "section", "closing"}
        assert not pattern["usable"], "служебный пример не должен уходить под обычный контент"


def test_chart_pattern_gets_new_data(parsed):
    path, result = parsed
    charts = [p for p in result.patterns if p["usable"] and p["type"] == "chart"]
    if not charts:
        pytest.skip("в шаблоне нет простых диаграмм-примеров")
    pattern = charts[0]
    slide = Slide(
        kind="chart",
        title="Время подготовки колоды",
        chart=ChartData(
            type=pattern["frames"]["chart"]["kind"],
            categories=["Вручную", "Ассистент", "Сервис"],
            series=[ChartSeries(name="Минуты", values=[480, 180, 5])],
        ),
        pattern_id=pattern["id"],
    )
    assert pattern_score(slide, pattern) is not None
    theme = slide_theme(result.tokens, result.layouts, result.roles)
    deck = build_deck(path, [slide], roles=result.roles, theme=theme, patterns=result.patterns)
    built = Presentation(io.BytesIO(deck.data))
    charts_on_slide = [shape for shape in built.slides[0].shapes if getattr(shape, "has_chart", False) and shape.has_chart]
    assert charts_on_slide, "диаграмма слайда-примера должна попасть в клон"
    assert list(charts_on_slide[0].chart.plots[0].categories) == ["Вручную", "Ассистент", "Сервис"]


def test_broken_slide_does_not_break_parse(parsed, monkeypatch):
    path, _ = parsed
    original = patterns_module.analyze_slide

    def flaky(slide, index, *args, **kwargs):
        if index == 1:
            raise RuntimeError("битый слайд")
        return original(slide, index, *args, **kwargs)

    monkeypatch.setattr(patterns_module, "analyze_slide", flaky)
    result = parse_template(path)
    assert result.patterns[1]["error"].startswith("RuntimeError")
    assert not result.patterns[1]["usable"]
    assert result.tokens["stats"]["broken_slides"] == 1
