"""Контекстный подбор и привязка изображений контент-пакета к слайдам презентации.

Анализирует метаданные загруженных пользователем файлов (извлечённые image_analyzer)
и сопоставляет их со смысловым содержанием слайдов (заголовок, тезисы, промпт иллюстрации).

Если изображение не несёт в себе текста или является визуальной иллюстрацией/фотографией,
оно используется напрямую на подходящем слайде вместо генерации (заменяет пустую заглушку).
Логотипы и обложки автоматически привязываются к титульному слайду.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from app.models import ContentFile
from app.pipeline.content.image_analyzer import parse_image_meta
from app.schemas.slide import ImageSpec, Slide

logger = logging.getLogger(__name__)

_STOP_WORDS = {
    "это", "как", "так", "для", "или", "при", "что", "все", "его", "они", "том",
    "быть", "свой", "если", "один", "тот", "наш", "сам", "еще", "чем", "под", "над",
    "the", "and", "for", "with", "this", "that", "from", "are", "was",
}


@dataclass
class ImageAsset:
    id: str
    filename: str
    url: str
    has_text: bool = False
    ocr_text: str = ""
    visual_description: str = ""
    is_visual: bool = True
    category: str = "photo"
    tags: list[str] = field(default_factory=list)
    recommended_placement: str = "slide_illustration"


def extract_image_assets(files: list[ContentFile], presentation_id: UUID | str) -> list[ImageAsset]:
    """Извлекает и нормализует список графических ассетов из файлов контент-пакета."""
    assets: list[ImageAsset] = []
    pres_id_str = str(presentation_id)

    image_exts = {".png", ".jpg", ".jpeg", ".webp", ".svg"}

    for file in files:
        dot_idx = file.filename.rfind(".")
        ext = file.filename[dot_idx:].lower() if dot_idx != -1 else ""
        mime = (file.content_type or "").lower()
        if ext not in image_exts and not mime.startswith("image/"):
            continue

        meta = parse_image_meta(file.extracted_text) or {}
        cat = meta.get("category")
        if not cat:
            fn_l = file.filename.lower()
            if any(k in fn_l for k in ("logo", "лого")):
                cat = "logo"
            elif any(k in fn_l for k in ("diagram", "scheme", "схема")):
                cat = "diagram"
            else:
                cat = "photo"

        asset = ImageAsset(
            id=str(file.id),
            filename=file.filename,
            url=f"/api/presentations/{pres_id_str}/files/{file.id}/content",
            has_text=bool(meta.get("has_text", False)),
            ocr_text=meta.get("ocr_text", ""),
            visual_description=meta.get("visual_description", file.filename),
            is_visual=bool(meta.get("is_visual", True)),
            category=cat,
            tags=list(meta.get("tags") or []),
            recommended_placement=meta.get("recommended_placement", "slide_illustration"),
        )
        assets.append(asset)

    return assets


def _tokenize(text: str) -> set[str]:
    """Токенизация текста с удалением стоп-слов и пунктуации."""
    words = re.findall(r"[a-zA-Zа-яА-Я0-9]{3,}", text.lower())
    return {w for w in words if w not in _STOP_WORDS}


def _score_slide_asset_match(slide: Slide, asset: ImageAsset) -> float:
    """Оценивает семантическую релевантность изображения к слайду.
    
    Больше — лучше. 0 — нет смысловой связи.
    """
    slide_text = " ".join([
        slide.title or "",
        slide.subtitle or "",
        slide.summary or "",
        " ".join(slide.bullets or []),
        slide.image.prompt if slide.image else "",
    ]).lower()

    slide_tokens = _tokenize(slide_text)
    if not slide_tokens:
        return 0.0

    score = 0.0

    # 1. Совпадение с тегами изображения (высокий вес)
    for tag in asset.tags:
        tag_tokens = _tokenize(tag)
        if tag_tokens and tag_tokens.issubset(slide_tokens):
            score += 3.5
        elif any(t in slide_tokens for t in tag_tokens):
            score += 1.5

    # 2. Совпадение с визуальным описанием
    desc_tokens = _tokenize(asset.visual_description)
    overlap = slide_tokens.intersection(desc_tokens)
    score += len(overlap) * 1.2

    # 3. Совпадение с именем файла (очищенным от расширения)
    name_tokens = _tokenize(re.sub(r"\.[a-zA-Z0-9]+$", "", asset.filename))
    score += len(slide_tokens.intersection(name_tokens)) * 2.0

    # 4. Бонус за визуальность (если нет тяжелого текста, фото идеально для слайда)
    if asset.is_visual:
        score += 2.0
    if not asset.has_text:
        score += 1.0

    # 5. Тематические категории
    if asset.category == "screenshot" and any(k in slide_tokens for k in ("интерфейс", "продукт", "приложение", "экран")):
        score += 3.0
    elif asset.category == "diagram" and any(k in slide_tokens for k in ("архитектура", "схема", "структура", "процесс")):
        score += 3.0
    elif asset.category == "photo" and any(k in slide_tokens for k in ("команда", "люди", "клиенты", "партнеры")):
        score += 3.0

    return score


def match_images_to_slides(slides: list[Slide], assets: list[ImageAsset]) -> int:
    """Сопоставляет и привязывает изображения контент-пакета к слайдам презентации.
    
    Возвращает количество успешно привязанных изображений.
    """
    if not slides or not assets:
        return 0

    matched_count = 0
    used_asset_ids: set[str] = set()

    # 1. Привязка логотипа / обложки к титульному слайду (slides[0])
    title_slide = next((s for s in slides if s.kind == "title"), slides[0] if slides else None)
    if title_slide is not None:
        logo_candidate = next(
            (a for a in assets if (a.category == "logo" or a.recommended_placement == "logo") and a.id not in used_asset_ids),
            None,
        )
        if not logo_candidate:
            logo_candidate = next(
                (a for a in assets if a.recommended_placement == "cover" and a.id not in used_asset_ids),
                None,
            )
        if logo_candidate and (not title_slide.image or not title_slide.image.url):
            title_slide.image = ImageSpec(
                url=logo_candidate.url,
                prompt=logo_candidate.visual_description or logo_candidate.filename,
                status="generated",
            )
            used_asset_ids.add(logo_candidate.id)
            matched_count += 1
            logger.info("Логотип/обложка «%s» привязана к титульному слайду", logo_candidate.filename)

    # 2. Привязка к слайдам, где явно требуется изображение (image_text или есть image.prompt)
    target_slides = [s for s in slides if s.kind == "image_text" or (s.image is not None and not s.image.url)]

    for slide in target_slides:
        available = [a for a in assets if a.id not in used_asset_ids and a.category != "logo"]
        if not available:
            # Если все ассеты уже распределены, но есть единственный визуальный ассет, допускаем использование
            available = [a for a in assets if a.category != "logo"]

        if not available:
            continue

        scored = [(a, _score_slide_asset_match(slide, a)) for a in available]
        scored.sort(key=lambda pair: pair[1], reverse=True)
        best_asset, best_score = scored[0]

        # Если есть хотя бы минимальная релевантность (или это единственный слайд с картинкой)
        if best_score >= 1.5 or (len(target_slides) == 1 and best_asset.is_visual):
            slide.image = ImageSpec(
                url=best_asset.url,
                prompt=best_asset.visual_description or best_asset.filename,
                status="generated",
            )
            used_asset_ids.add(best_asset.id)
            matched_count += 1
            logger.info(
                "Изображение «%s» (оценка %.1f) привязано к слайду «%s»",
                best_asset.filename,
                best_score,
                slide.title,
            )

    # 3. Дополнительно: если остались неиспользованные качественные фото (is_visual=True),
    # а в колоде есть тезисные слайды с высокой релевантностью — превращаем в image_text
    remaining_visuals = [
        a for a in assets
        if a.id not in used_asset_ids and a.is_visual and a.category in ("photo", "screenshot", "illustration")
    ]
    if remaining_visuals:
        eligible_bullet_slides = [
            s for s in slides
            if s.kind == "bullets" and not s.image and 1 <= len(s.bullets or []) <= 4
        ]
        for slide in eligible_bullet_slides:
            if not remaining_visuals:
                break
            scored = [(a, _score_slide_asset_match(slide, a)) for a in remaining_visuals]
            scored.sort(key=lambda pair: pair[1], reverse=True)
            best_asset, best_score = scored[0]

            # Высокий порог соответствия для смены типа макета на image_text
            if best_score >= 4.0:
                slide.kind = "image_text"
                slide.image = ImageSpec(
                    url=best_asset.url,
                    prompt=best_asset.visual_description or best_asset.filename,
                    status="generated",
                )
                used_asset_ids.add(best_asset.id)
                remaining_visuals.remove(best_asset)
                matched_count += 1
                logger.info(
                    "Слайд «%s» преобразован в image_text с фото «%s» (оценка %.1f)",
                    slide.title,
                    best_asset.filename,
                    best_score,
                )

    return matched_count


def assign_content_images_to_drafts(drafts: list[Any], files: list[ContentFile], presentation_id: UUID | str) -> dict[str, int]:
    """Применяет контекстный подбор ко всем вариантам вёрстки презентации."""
    assets = extract_image_assets(files, presentation_id)
    if not assets:
        return {"matched": 0, "total_assets": 0}

    total_matched = 0
    for draft in drafts:
        slides = getattr(draft, "slides", draft) if not isinstance(draft, list) else draft
        matched = match_images_to_slides(slides, assets)
        total_matched += matched

    return {"matched": total_matched, "total_assets": len(assets)}
