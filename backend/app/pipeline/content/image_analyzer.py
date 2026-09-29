"""Мультимодальный анализ изображений контент-пакета.

Определяет:
1. Наличие текста на изображении и выполняет OCR (считывание текста с диаграмм, скриншотов, схем).
2. Визуальный сюжет и объекты (что изображено, люди, оборудование, интерфейс).
3. Пригодность для использования в качестве иллюстрации на слайде (is_visual: True для фотографий,
   иллюстраций, логотипов; False для плотных сканов документов или сплошного текста).
4. Категорию: photo, illustration, logo, screenshot, diagram, document.
5. Ключевые слова (теги) для контекстного сопоставления с темами и слайдами презентации.

При настроенной VLM (или LLM с поддержкой vision) отправляет запрос с картинкой к модели.
При отсутствии или ошибке VLM работает надёжный детерминированный fallback (SVG-текст,
метаданные Pillow, анализ пропорций и семантики имени файла).
"""

import base64
import json
import logging
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import httpx

from app.core.config import settings
from app.pipeline.ai import client as api
from app.pipeline.ai.keys import auth_headers, split_keys
from app.pipeline.ai.vlm import vlm_enabled

logger = logging.getLogger(__name__)

META_PREFIX = "<!--IMAGE_META:"
META_SUFFIX = "-->"

IMAGE_CATEGORIES = {"photo", "illustration", "logo", "screenshot", "diagram", "document"}


@dataclass
class ImageAnalysis:
    has_text: bool = False
    ocr_text: str = ""
    visual_description: str = ""
    is_visual: bool = True
    category: str = "photo"
    tags: list[str] = field(default_factory=list)
    recommended_placement: str = "slide_illustration"
    source: str = "vlm"

    def to_meta_dict(self) -> dict[str, Any]:
        return asdict(self)


def parse_image_meta(text: str | None) -> dict[str, Any] | None:
    """Извлекает структурированный мета-блок из extracted_text файла."""
    if not text:
        return None
    start = text.find(META_PREFIX)
    if start == -1:
        return None
    end = text.find(META_SUFFIX, start + len(META_PREFIX))
    if end == -1:
        return None
    payload = text[start + len(META_PREFIX) : end].strip()
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return None


def format_extracted_text(analysis: ImageAnalysis, filename: str) -> str:
    """Форматирует результат анализа для сохранения в ContentFile.extracted_text.
    
    Включает компактный мета-блок для парсинга и человекочитаемый текст
    для включения в дайджест источников (sources_digest) для LLM.
    """
    meta_json = json.dumps(analysis.to_meta_dict(), ensure_ascii=False)
    lines = [f"{META_PREFIX}{meta_json}{META_SUFFIX}"]

    cat_labels = {
        "photo": "Фотография",
        "illustration": "Иллюстрация",
        "logo": "Логотип / Бренд-элемент",
        "screenshot": "Скриншот интерфейса",
        "diagram": "Схема / Диаграмма",
        "document": "Документ / Текстовый скан",
    }
    cat_label = cat_labels.get(analysis.category, "Изображение")
    lines.append(f"[Визуальный ассет: {cat_label}]")
    if analysis.visual_description:
        lines.append(f"Сюжет: {analysis.visual_description}")
    if analysis.tags:
        lines.append(f"Теги: {', '.join(analysis.tags)}")
    if analysis.is_visual:
        lines.append("Назначение: подходит для вставки на слайд вместо генерации")
    if analysis.has_text and analysis.ocr_text.strip():
        lines.append(f"Текст с изображения (OCR):\n{analysis.ocr_text.strip()}")

    return "\n".join(lines)


def _image_to_jpeg_bytes(path: Path) -> bytes | None:
    """Читает изображение и при необходимости конвертирует в JPEG/PNG для отправки в Vision API."""
    ext = path.suffix.lower()
    try:
        if ext == ".svg":
            import pymupdf
            with pymupdf.open(stream=path.read_bytes(), filetype="svg") as doc:
                if len(doc) > 0:
                    pix = doc[0].get_pixmap(dpi=150)
                    return pix.tobytes("jpeg")
            return None
        
        # Для растровых: если файл в пределах 4МБ, читаем как есть или ресайзим при огромных размерах
        from PIL import Image
        with Image.open(path) as img:
            w, h = img.size
            if max(w, h) > 1536:
                ratio = 1536 / max(w, h)
                img = img.resize((int(w * ratio), int(h * ratio)), Image.Resampling.LANCZOS)
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            import io
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=85)
            return buf.getvalue()
    except Exception as exc:
        logger.warning("Не удалось подготовить изображение %s для VLM: %s", path, exc)
        return None


def _vlm_schema() -> dict[str, Any]:
    return {
        "name": "image_content_analysis",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "has_text": {"type": "boolean"},
                "ocr_text": {"type": "string"},
                "visual_description": {"type": "string"},
                "is_visual": {"type": "boolean"},
                "category": {
                    "type": "string",
                    "enum": ["photo", "illustration", "logo", "screenshot", "diagram", "document"],
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "recommended_placement": {
                    "type": "string",
                    "enum": ["cover", "logo", "slide_illustration", "data_reference", "none"],
                },
            },
            "required": [
                "has_text",
                "ocr_text",
                "visual_description",
                "is_visual",
                "category",
                "tags",
                "recommended_placement",
            ],
            "additionalProperties": False,
        },
    }


def _analyze_with_vlm(image_bytes: bytes, filename: str) -> ImageAnalysis | None:
    """Анализирует изображение с помощью VLM (Qwen3.8-27b / OpenAI-совместимый Vision API)."""
    base_url = settings.vlm_base_url or settings.llm_base_url
    api_key = settings.vlm_api_key or settings.llm_api_key
    model = settings.vlm_model or settings.llm_model

    if not base_url or not model:
        return None

    b64 = base64.b64encode(image_bytes).decode("ascii")
    image_url = f"data:image/jpeg;base64,{b64}"

    system_prompt = (
        "Ты — мультимодальный аналитик контента для презентаций. "
        "Твоя задача — проанализировать загруженное пользователем изображение для слайдов.\n"
        "1. Проверь наличие текста на изображении: если это документ, схема, график или скриншот с важным текстом, "
        "считай текст (OCR) в поле 'ocr_text' и установи has_text: true. Если текста нет или он декоративный/минимальный, "
        "установи has_text: false и ocr_text: ''.\n"
        "2. В 'visual_description' кратко опиши, что изображено (сюжет, объекты, обстановка, люди, цвета).\n"
        "3. В 'is_visual' укажи true, если фото/изображение подходит для визуальной вставки на слайд вместо генерации "
        "(фото людей, техники, офиса, продукта, процесса, красивая иллюстрация, логотип). Укажи false только если это "
        "скан текстовой страницы или таблица без иллюстративного смысла.\n"
        "4. В 'category' выбери строго одно: 'photo', 'illustration', 'logo', 'screenshot', 'diagram', 'document'.\n"
        "5. В 'tags' укажи 3–7 ключевых слов на русском языке, к каким темам/слайдам подходит изображение "
        "(например, ['команда', 'разработка', 'IT', 'офис', 'совещание']).\n"
        "6. В 'recommended_placement' укажи: 'cover' (обложка), 'logo' (логотип), 'slide_illustration' (иллюстрация к тезисам), "
        "'data_reference' (схема данных) или 'none'."
    )

    user_text = f"Проанализируй файл «{filename}»."
    payload = {
        "model": model,
        "temperature": 0.1,
        "max_tokens": 1200,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            },
        ],
    }

    headers = auth_headers(api_key)
    options = api.attempts(
        extra=api.extra_body(settings.vlm_extra_body or settings.llm_extra_body, "VLM_EXTRA_BODY"),
        disable_reasoning=settings.vlm_disable_reasoning,
        schema=_vlm_schema(),
    )

    vlm_delays = [1.5, 3.0, 5.0]
    for attempt_idx, delay in enumerate(vlm_delays):
        try:
            with httpx.Client(base_url=base_url, headers=headers, timeout=settings.vlm_timeout_seconds) as client:
                answer = api.ask_json(client, payload, options, label=f"vlm_image_{filename}", keys=split_keys(api_key))
                if answer.data:
                    data = answer.data
                    fn_lower = filename.lower()
                    cat = data.get("category", "photo")
                    if any(k in fn_lower for k in ("logo", "лого", "brand", "эмблема")):
                        cat = "logo"
                    elif any(k in fn_lower for k in ("diagram", "scheme", "схема", "архитектур", "arch")):
                        cat = "diagram"
                    elif cat not in IMAGE_CATEGORIES:
                        cat = "photo"

                    rec_placement = str(data.get("recommended_placement", "slide_illustration"))
                    if cat == "logo":
                        rec_placement = "logo"

                    return ImageAnalysis(
                        has_text=bool(data.get("has_text")),
                        ocr_text=str(data.get("ocr_text", "")),
                        visual_description=str(data.get("visual_description", "")),
                        is_visual=bool(data.get("is_visual", True)),
                        category=cat,
                        tags=[str(t) for t in data.get("tags", []) if str(t).strip()],
                        recommended_placement=rec_placement,
                        source="vlm",
                    )
        except Exception as exc:
            if attempt_idx < len(vlm_delays) - 1:
                logger.warning(
                    "VLM-анализ изображения %s (попытка %d/%d) прервался: %s — повторяю через %.1fс",
                    filename, attempt_idx + 1, len(vlm_delays), exc, delay
                )
                time.sleep(delay)
                continue
            logger.warning("VLM-анализ изображения %s не удался: %s — использую fallback", filename, exc)

    return None


def _fallback_analysis(path: Path, filename: str) -> ImageAnalysis:
    """Детерминированный эвристический анализ при недоступности VLM."""
    ext = path.suffix.lower()
    fn_lower = filename.lower()

    # 1. Извлечение текста из SVG, если это вектор
    ocr_lines: list[str] = []
    if ext == ".svg" and path.exists():
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
            # Извлекаем текст из тегов <text ...>...</text>
            texts = re.findall(r"<text[^>]*>([^<]+)</text>", content, re.IGNORECASE)
            for t in texts:
                clean = t.strip()
                if clean and clean not in ocr_lines:
                    ocr_lines.append(clean)
        except Exception:
            pass

    ocr_text = "\n".join(ocr_lines)
    has_text = len(ocr_text.strip()) > 10

    # 2. Определение категории по имени файла и метаданным
    category = "photo"
    is_visual = True
    placement = "slide_illustration"
    tags: list[str] = []

    # Анализ имени файла
    clean_name = re.sub(r"[_\-.]+", " ", Path(filename).stem).strip()
    words = [w for w in clean_name.split() if len(w) > 2]
    tags.extend(words)

    if any(k in fn_lower for k in ("logo", "лого", "brand", "эмблема")):
        category = "logo"
        placement = "logo"
        tags.extend(["логотип", "бренд", "айдентика"])
    elif any(k in fn_lower for k in ("diagram", "scheme", "схема", "архитектур", "arch", "flow", "workflow")):
        category = "diagram"
        placement = "data_reference"
        tags.extend(["схема", "архитектура", "диаграмма"])
    elif any(k in fn_lower for k in ("screen", "скрин", "ui", "interface", "app", "dashboard", "дашборд")):
        category = "screenshot"
        placement = "slide_illustration"
        tags.extend(["интерфейс", "продукт", "скриншот"])
    elif any(k in fn_lower for k in ("team", "команд", "people", "люди", "сотрудник", "founder")):
        category = "photo"
        placement = "slide_illustration"
        tags.extend(["команда", "люди", "сотрудники"])
    elif any(k in fn_lower for k in ("cover", "обложк", "main", "титул", "hero")):
        category = "photo"
        placement = "cover"
        tags.extend(["обложка", "главное", "заглавное фото"])
    elif ext == ".svg":
        category = "illustration"
        placement = "logo" if "logo" in fn_lower else "slide_illustration"
        tags.extend(["вектор", "иллюстрация"])

    # Анализ пропорций и размеров через Pillow
    dims_str = ""
    try:
        from PIL import Image
        with Image.open(path) as img:
            w, h = img.size
            dims_str = f"{w}×{h}"
            aspect = w / max(h, 1)
            # Если изображение очень узкое по горизонтали и вытянутое по вертикали — вероятно скан документа
            if aspect < 0.6 and h > 1000 and not any(k in fn_lower for k in ("photo", "people")):
                category = "document"
                is_visual = False
                placement = "none"
            elif aspect > 2.5:
                # Широкий баннер или логотип
                if "logo" not in category:
                    tags.append("баннер")
    except Exception:
        pass

    desc = f"Изображение «{clean_name}»"
    if dims_str:
        desc += f" ({dims_str})"
    if category == "logo":
        desc = f"Логотип или графический элемент «{clean_name}»"
    elif category == "diagram":
        desc = f"Схема или диаграмма «{clean_name}»"
    elif category == "screenshot":
        desc = f"Скриншот интерфейса «{clean_name}»"

    return ImageAnalysis(
        has_text=has_text,
        ocr_text=ocr_text,
        visual_description=desc,
        is_visual=is_visual,
        category=category,
        tags=list(dict.fromkeys(tags))[:7],
        recommended_placement=placement,
        source="fallback",
    )


def analyze_image_content(path: Path, filename: str) -> str:
    """Главная точка входа анализа изображения контент-пакета.
    
    Возвращает сериализованный текст с мета-информацией и текстовым дайджестом
    для сохранения в ContentFile.extracted_text.
    """
    analysis: ImageAnalysis | None = None

    # 1. Попытка анализа через VLM, если настроена
    if (vlm_enabled() or settings.llm_base_url) and path.exists():
        image_bytes = _image_to_jpeg_bytes(path)
        if image_bytes:
            analysis = _analyze_with_vlm(image_bytes, filename)

    # 2. Если VLM недоступна или дала сбой — fallback
    if analysis is None:
        analysis = _fallback_analysis(path, filename)
    elif path.suffix.lower() == ".svg" and path.exists():
        try:
            svg_content = path.read_text(encoding="utf-8", errors="replace")
            svg_texts = re.findall(r"<text[^>]*>([^<]+)</text>", svg_content, re.IGNORECASE)
            clean_texts = [t.strip() for t in svg_texts if t.strip()]
            if clean_texts:
                svg_ocr = "\n".join(clean_texts)
                if not analysis.ocr_text or len(analysis.ocr_text.strip()) < len(svg_ocr):
                    analysis.ocr_text = svg_ocr
                    analysis.has_text = True
                if analysis.category in ("document", "photo"):
                    analysis.category = "diagram" if any(k in filename.lower() for k in ("diagram", "scheme", "схема", "архитектур")) else "illustration"
        except Exception:
            pass

    return format_extracted_text(analysis, filename)
