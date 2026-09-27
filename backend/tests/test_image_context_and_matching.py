"""Тесты мультимодального анализа изображений и контекстного подбора фотографий в слайды."""

import io
import uuid
from pathlib import Path
from PIL import Image
import pytest

from app.models import ContentFile
from app.pipeline.content.image_analyzer import (
    ImageAnalysis,
    analyze_image_content,
    format_extracted_text,
    parse_image_meta,
)
from app.pipeline.content.image_matcher import (
    ImageAsset,
    _score_slide_asset_match,
    extract_image_assets,
    match_images_to_slides,
)
from app.schemas.slide import ImageSpec, Slide


def make_png_bytes(width: int = 400, height: int = 300, color: str = "blue") -> bytes:
    img = Image.new("RGB", (width, height), color=color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_svg_bytes(text: str = "VK Cloud Architecture") -> bytes:
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150">'
        f'<rect width="300" height="150" fill="#0077FF"/>'
        f'<text x="20" y="50" fill="#FFFFFF">{text}</text>'
        f'</svg>'
    )
    return svg.encode("utf-8")


def test_image_analyzer_svg_ocr_text(tmp_path: Path):
    svg_path = tmp_path / "cloud_diagram.svg"
    svg_path.write_bytes(make_svg_bytes("Архитектура микросервисов VK Tech"))

    extracted = analyze_image_content(svg_path, "cloud_diagram.svg")
    assert extracted is not None
    meta = parse_image_meta(extracted)
    assert meta is not None
    assert meta["has_text"] is True
    assert "Архитектура микросервисов" in meta["ocr_text"]
    assert meta["category"] in ("diagram", "screenshot", "illustration")


def test_image_analyzer_fallback_heuristics(tmp_path: Path):
    from app.pipeline.content.image_analyzer import _fallback_analysis

    png_path = tmp_path / "team_presentation_photo.png"
    png_path.write_bytes(make_png_bytes(800, 600))

    analysis = _fallback_analysis(png_path, "team_presentation_photo.png")
    assert analysis.is_visual is True
    assert analysis.category == "photo"
    assert "команда" in analysis.tags or "team" in analysis.tags or "people" in analysis.tags


def test_image_analyzer_logo_recognition(tmp_path: Path, monkeypatch):
    # Проверяем разбор по правилам (логотип — по имени файла). С заданными VLM_*/LLM_* анализатор
    # спросил бы настоящую модель, и её ответ о пустой картинке делал тест случайным.
    from app.core.config import settings
    from app.pipeline.content import image_analyzer

    monkeypatch.setattr(image_analyzer, "vlm_enabled", lambda: False)
    monkeypatch.setattr(settings, "llm_base_url", None)
    png_path = tmp_path / "company_logo_vk.png"
    png_path.write_bytes(make_png_bytes(200, 200))

    extracted = analyze_image_content(png_path, "company_logo_vk.png")
    meta = parse_image_meta(extracted)
    assert meta is not None
    assert meta["category"] == "logo"
    assert meta["recommended_placement"] == "logo"
    assert meta["is_visual"] is True


def test_image_matcher_title_logo_binding():
    slides = [
        Slide(kind="title", title="Презентация облачных сервисов"),
        Slide(kind="bullets", title="Основные возможности", bullets=["Быстрота", "Безопасность"]),
    ]

    assets = [
        ImageAsset(
            id="1",
            filename="vk_tech_logo.png",
            url="/api/presentations/1111/files/1/content",
            category="logo",
            recommended_placement="logo",
            is_visual=True,
            visual_description="Логотип VK Tech",
            tags=["логотип", "бренд"],
        ),
        ImageAsset(
            id="2",
            filename="datacenter_servers.jpg",
            url="/api/presentations/1111/files/2/content",
            category="photo",
            is_visual=True,
            visual_description="Серверные стойки дата-центра",
            tags=["серверы", "облако", "дата-центр", "инфраструктура"],
        ),
    ]

    matched = match_images_to_slides(slides, assets)
    assert matched >= 1
    # Титульный слайд получил логотип
    assert slides[0].image is not None
    assert slides[0].image.url == "/api/presentations/1111/files/1/content"
    assert slides[0].image.status == "generated"


def test_image_matcher_contextual_topic_matching():
    slides = [
        Slide(kind="title", title="Обзор компании"),
        Slide(
            kind="image_text",
            title="Наша серверная инфраструктура и облако",
            summary="Высоконадежные дата-центры уровня Tier III",
            bullets=["Резервирование 2N", "Uptime 99.99%"],
            image=ImageSpec(prompt="Иллюстрация дата-центра"),
        ),
        Slide(
            kind="image_text",
            title="Команда инженеров и разработчиков",
            summary="Опытные специалисты",
            bullets=["Более 200 разработчиков", "Круглосуточная поддержка"],
            image=ImageSpec(prompt="Фото команды инженеров"),
        ),
    ]

    assets = [
        ImageAsset(
            id="img-team",
            filename="team_photo.jpg",
            url="/api/files/img-team/content",
            category="photo",
            is_visual=True,
            visual_description="Команда разработчиков за рабочими местами",
            tags=["команда", "разработчики", "инженеры", "люди"],
        ),
        ImageAsset(
            id="img-servers",
            filename="datacenter.jpg",
            url="/api/files/img-servers/content",
            category="photo",
            is_visual=True,
            visual_description="Серверные стойки в дата-центре",
            tags=["серверная", "инфраструктура", "дата-центр", "облако"],
        ),
    ]

    matched = match_images_to_slides(slides, assets)
    assert matched == 2

    # Слайд про серверы должен получить дата-центр
    assert slides[1].image.url == "/api/files/img-servers/content"
    # Слайд про команду должен получить фото команды
    assert slides[2].image.url == "/api/files/img-team/content"


def test_score_slide_asset_match_prioritizes_visual():
    slide = Slide(
        kind="image_text",
        title="Развитие IT платформы",
        bullets=["Новые модули", "Высокая производительность"],
    )

    # Фото без текста
    visual_asset = ImageAsset(
        id="1",
        filename="it_platform_servers.png",
        url="/1",
        is_visual=True,
        has_text=False,
        visual_description="IT платформа серверная архитектура",
        tags=["it", "платформа", "серверы"],
    )

    # Текстовый документ
    doc_asset = ImageAsset(
        id="2",
        filename="contract_scan.png",
        url="/2",
        is_visual=False,
        has_text=True,
        ocr_text="Договор поставки оборудования IT платформа пункт 1 2 3",
        visual_description="Скан документа",
        tags=["it", "платформа", "договор"],
    )

    score_visual = _score_slide_asset_match(slide, visual_asset)
    score_doc = _score_slide_asset_match(slide, doc_asset)

    # Визуальное фото без текста получает более высокий приоритет для вставки на слайд
    assert score_visual > score_doc
