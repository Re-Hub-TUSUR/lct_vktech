"""Слайд по описанию из Студии без модели: тип по подсказке и содержимому, числа только из источников."""

import pytest

from app.core.config import settings
from app.pipeline.planning.single import choose_kind, generate_slide, split_prompt, unsupported_numbers
from app.schemas.slide import ChartData, ChartSeries, Slide

CTX = dict(deck=[], title="Колода", purpose="продукт", brief="", sources="")


@pytest.fixture(autouse=True)
def no_model(monkeypatch):
    """Путь без модели: LLM_* из окружения контейнера не должны подменять его настоящей моделью."""
    monkeypatch.setattr(settings, "llm_base_url", None)


def test_split_prompt_title_and_items():
    title, items = split_prompt("Что делаем дальше; собираем библиотеку цитат; запускаем дайджест")
    assert title == "Что делаем дальше"
    assert items == ["Собираем библиотеку цитат", "Запускаем дайджест"]


def test_auto_kind_picks_chart_only_with_numbers_everywhere():
    assert choose_kind("Каналы охвата; мемы 82%; цитаты 64%; отчёты 12%", "auto") == "chart"
    assert choose_kind("Каналы охвата; мемы 82%; цитаты; отчёты 12%", "auto") != "chart"
    assert choose_kind("План; первый этап; второй этап; третий этап", "auto") == "timeline"


def test_hint_is_respected():
    assert choose_kind("Что угодно; пункт", "cards") == "cards"
    assert choose_kind("Что угодно; пункт", "case") == "image_text"


def test_generate_without_model_keeps_numbers_from_prompt():
    result = generate_slide("Каналы охвата; мемы 82%; цитаты 64%; отчёты 12%", hint="auto", **CTX)
    assert result.slide.kind == "chart"
    assert sorted(result.slide.chart.series[0].values) == [12, 64, 82]
    assert not result.used_model


def test_chart_hint_without_numbers_falls_back_to_cards():
    result = generate_slide("Преимущества; скорость; качество; цена", hint="chart", **CTX)
    assert result.slide.kind == "cards"
    assert result.slide.chart is None


def test_unsupported_numbers_detected():
    slide = Slide(kind="chart", title="T", chart=ChartData(categories=["a"], series=[ChartSeries(values=[3.0])]))
    assert unsupported_numbers(slide, "в 2 раза")
    assert not unsupported_numbers(slide, "в 3 раза")


def test_replace_keeps_slide_id():
    base = Slide(kind="bullets", title="Старый", bullets=["x"])
    result = generate_slide("Новый заголовок; пункт один; пункт два; пункт три", hint="bullets", base=base, **CTX)
    assert result.slide.id == base.id
    assert result.slide.title == "Новый заголовок"
