"""Иллюстрации слайдов моделью text-to-image (ТЗ, п. 3.1): стиль шаблона → сюжеты → картинки → вёрстка.

1. Стиль иллюстраций шаблона (skills/image_style.yaml). VLM смотрит на слайды-примеры с крупными
   картинками и описывает материал, свет, фон и цвета по-английски. Описание — часть дизайн-системы
   шаблона (tokens.image_style) и считается один раз. Без VLM стиль собирается из палитры и фона.
2. Какие картинки нужны (plan_images). Слайды «текст и изображение» трёх вариантов, которым не нашлось
   фото в материалах. Слайд плана (ref) — одна картинка на все варианты: колода одинаково
   проиллюстрирована во всех трёх, а модель не рисует лишнего. Пропорции — по рамке картинки паттерна.
3. Сюжеты (skills/image_director.yaml). Один запрос к LLM на всю колоду: картинка работает на мысль
   слайда и не повторяет соседние. Без ответа модели — описание, которое оставил автор текстов.
4. Картинки (skills/image_generator.yaml, ai/t2i.py). Параллельно, с фиксированным сидом, JPEG в
   хранилище презентации. Не получилась картинка — слайд верстается тезисами, без пустой рамки.
"""

import colorsys
import io
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from PIL import Image

from app.core.config import settings
from app.core.storage import GENERATED_DIR, storage_path
from app.pipeline.ai import t2i
from app.pipeline.ai.llm import ModelConfig, Usage, ask, in_parallel, judge_model, llm_enabled, open_client
from app.pipeline.layout.composer import relayout_edited_slide
from app.pipeline.skills import custom_skill_context, get_skill
from app.pipeline.theme import relative_luminance
from app.schemas.slide import ImageSpec, Slide

logger = logging.getLogger(__name__)

HEX_RX = re.compile(r"#[0-9A-Fa-f]{6}")
_S = {"type": "string"}
STYLE_SCHEMA = {
    "name": "image_style",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "medium": _S,
            "style": _S,
            "background": _S,
            "subjects": _S,
            "colors": {"type": "array", "items": _S},
        },
        "required": ["medium", "style", "background", "subjects", "colors"],
        "additionalProperties": False,
    },
}
DIRECTOR_SCHEMA = {
    "name": "image_subjects",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "images": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"n": {"type": "integer"}, "subject": _S},
                    "required": ["n", "subject"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["images"],
        "additionalProperties": False,
    },
}


# --- хранилище ------------------------------------------------------------------------------------


def image_url(presentation_id: Any, name: str) -> str:
    return f"/api/presentations/{presentation_id}/images/{name}"


def save_image(data: bytes, presentation_id: Any, params: dict[str, Any] | None = None) -> str:
    """Картинку модели — в JPEG (колода .pptx не раздувается мегабайтными PNG); возвращает URL для слайда."""
    params = params or {}
    side = int(params.get("max_side", 1280))
    with Image.open(io.BytesIO(data)) as source:
        image = source.convert("RGB")
    image.thumbnail((side, side))
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=int(params.get("jpeg_quality", 88)), optimize=True)
    name = f"{uuid.uuid4().hex}.jpg"
    storage_path(GENERATED_DIR, str(presentation_id), name).write_bytes(buffer.getvalue())
    return image_url(presentation_id, name)


# --- стиль шаблона --------------------------------------------------------------------------------


def _vision_model() -> ModelConfig:
    """Модель, которая видит картинки: VLM разметки шаблонов, иначе судья аудита (AUDIT_*, LLM_*)."""
    judge = judge_model()
    own = bool(settings.vlm_base_url and settings.vlm_model)
    return ModelConfig(
        base_url=settings.vlm_base_url if own else judge.base_url,
        api_key=settings.vlm_api_key if own else judge.api_key,
        model=settings.vlm_model if own else judge.model,
        timeout=settings.vlm_timeout_seconds,
        max_tokens=settings.vlm_max_tokens,
        temperature=0.2,
        disable_reasoning=settings.vlm_disable_reasoning if own else judge.disable_reasoning,
        extra_body=settings.vlm_extra_body if own else judge.extra_body,
        concurrency=1,
        label="VLM_* (или AUDIT_*, LLM_*)",
    )


def brand_colors(tokens: dict[str, Any] | None, limit: int = 3) -> list[str]:
    """Цвета бренда из палитры шаблона: насыщенные, без белого, чёрного и серых."""
    result = []
    for entry in (tokens or {}).get("palette") or []:
        color = str(entry.get("hex") or "")
        if not HEX_RX.fullmatch(color):
            continue
        r, g, b = (int(color[i : i + 2], 16) / 255 for i in (1, 3, 5))
        _, lightness, saturation = colorsys.rgb_to_hls(r, g, b)
        if saturation >= 0.35 and 0.15 <= lightness <= 0.85 and color.upper() not in result:
            result.append(color.upper())
        if len(result) >= limit:
            break
    return result


def content_background(tokens: dict[str, Any] | None) -> str:
    """Фон слайдов с текстом — на нём стоят картинки."""
    tokens = tokens or {}
    color = str((tokens.get("backgrounds") or {}).get("content") or "")
    if not HEX_RX.fullmatch(color):
        color = str(((tokens.get("theme") or {}).get("colors") or {}).get("lt1") or "#FFFFFF")
    return color.upper() if HEX_RX.fullmatch(color) else "#FFFFFF"


def _background_phrase(color: str) -> str:
    tone = "plain light" if relative_luminance(color) > 0.45 else "deep dark"
    return f"{tone} background close to {color}"


def fallback_style(tokens: dict[str, Any] | None) -> dict[str, Any]:
    """Стиль без VLM: из палитры и фона шаблона (skills/image_style.yaml → params.fallback)."""
    skill = get_skill("image_style")
    base = (skill.params or {}).get("fallback") or {}
    colors = brand_colors(tokens) or ["#0077FF"]
    return {
        "source": "fallback",
        "skill_version": skill.version,
        "medium": str(base.get("medium") or "3d render"),
        "style": " ".join(str(base.get("style") or "Minimal corporate 3D illustration.").split()),
        "background": _background_phrase(content_background(tokens)),
        "subjects": str(base.get("subjects") or "abstract geometric objects"),
        "colors": colors,
    }


def _style_samples(patterns: list[dict[str, Any]] | None, renders_dir: Path, count: int, side: int) -> list[bytes]:
    """Рендеры слайдов-примеров для VLM: обложка и слайды с самыми крупными картинками."""

    def area(pattern: dict[str, Any]) -> float:
        return sum(image["bbox"][2] * image["bbox"][3] for image in pattern.get("images") or [])

    with_render = [pattern for pattern in patterns or [] if pattern.get("render")]
    cover = [pattern for pattern in with_render if pattern.get("category") == "cover"][:1]
    pictured = sorted(
        (pattern for pattern in with_render if area(pattern) > 0 and pattern.get("category") != "library"),
        key=area,
        reverse=True,
    )
    chosen = cover + [pattern for pattern in pictured if pattern not in cover][: max(0, count - len(cover))]
    samples = []
    for pattern in chosen:
        path = renders_dir / str(pattern["render"])
        try:
            with Image.open(path) as source:
                image = source.convert("RGB")
            image.thumbnail((side, side))
            buffer = io.BytesIO()
            image.save(buffer, "JPEG", quality=85)
            samples.append(buffer.getvalue())
        except OSError:
            continue
    return samples


def _clean(text: Any, limit: int) -> str:
    return " ".join(str(text or "").split())[:limit].strip()


def style_is_current(style: dict[str, Any] | None) -> bool:
    """Сохранённый стиль годится, если его писал тот же промпт, а VLM не появилась после расчёта по палитре."""
    if not style or style.get("skill_version") != get_skill("image_style").version:
        return False
    return style.get("source") == "vlm" or not _vision_model().enabled


def template_style(name: str, tokens: dict[str, Any] | None, patterns: list[dict[str, Any]] | None, renders_dir: Path) -> dict[str, Any]:
    """Стиль иллюстраций шаблона (вызывать в потоке). Без VLM или рендеров — стиль из палитры."""
    fallback = fallback_style(tokens)
    skill = get_skill("image_style")
    params = skill.params or {}
    cfg = _vision_model()
    samples = _style_samples(patterns, renders_dir, int(params.get("max_images", 4)), int(params.get("image_side", 768)))
    if not cfg.enabled or not samples:
        return fallback
    prompt = skill.prompt or {}
    values = {
        "name": name or "шаблон",
        "palette": ", ".join(fallback["colors"]),
        "background": content_background(tokens),
    }
    system, user = prompt.get("system") or "", prompt.get("user") or ""
    for key, value in values.items():
        system, user = system.replace("{" + key + "}", value), user.replace("{" + key + "}", value)
    with open_client(cfg) as http:
        answer = ask(
            http,
            system=system,
            user=user,
            schema=STYLE_SCHEMA,
            usage=Usage(model=cfg.model),
            label="стиль иллюстраций шаблона",
            max_tokens=int(params.get("max_tokens", 700)),
            cfg=cfg,
            images=samples,
        )
    if not answer or not _clean(answer.get("style"), 400):
        return fallback
    # Цвета бренда — насыщенные: тёмный фон обложки или белый в акцентах картинке не нужны.
    colors = brand_colors({"palette": [{"hex": str(color)} for color in answer.get("colors") or []]}, limit=4)
    return {
        "source": "vlm",
        "skill_version": skill.version,
        "model": cfg.model,
        "medium": _clean(answer.get("medium"), 40) or fallback["medium"],
        "style": _clean(answer.get("style"), 400),
        # Картинки стоят на слайдах с текстом: фон — их фон, а не обложки (VLM видит оба).
        "background": fallback["background"],
        "background_note": _clean(answer.get("background"), 160),
        "subjects": _clean(answer.get("subjects"), 200) or fallback["subjects"],
        "colors": colors or fallback["colors"],
    }


# --- какие картинки нужны -------------------------------------------------------------------------


def needs_image(slide: Slide) -> bool:
    return slide.kind == "image_text" and not (slide.image and slide.image.url)


def slide_aspect(tokens: dict[str, Any] | None) -> float:
    size = (tokens or {}).get("slide_size") or {}
    return size["width_emu"] / size["height_emu"] if size.get("height_emu") else 16 / 9


def frame_ratio(slide: Slide, patterns: dict[str, dict[str, Any]], aspect: float, layout_ratio: str) -> str:
    """Пропорции рамки картинки: по картинке паттерна шаблона, у слайда на макете — рамка справа от текста."""
    pattern = patterns.get(slide.pattern_id or "")
    images = (pattern or {}).get("images") or []
    if images:
        _, _, width, height = images[0]["bbox"]
        if width > 0 and height > 0:
            return t2i.nearest_ratio(width / height * aspect)
    return layout_ratio


@dataclass
class ImageJob:
    ref: str
    ratio: str
    seed: int
    # Снимок текста слайда для арт-директора: вёрстка тем временем может править тексты.
    title: str
    summary: str
    bullets: list[str]
    idea: str
    subject: str = ""
    prompt: str = ""
    url: str | None = None
    error: str | None = None


@dataclass
class ImagePlan:
    jobs: list[ImageJob] = field(default_factory=list)
    # Слайдов с иллюстрацией больше лимита T2I_MAX_IMAGES — эти слайды пойдут без картинки.
    over_limit: int = 0


def _idea(slide: Slide) -> str:
    prompt = (slide.image.prompt if slide.image else "") or ""
    # Заглушку композитора («Иллюстрация к слайду …») идеей автора не считаем.
    return "" if prompt.startswith("Иллюстрация к слайду") else _clean(prompt, 300)


def plan_images(
    drafts: list[Any],
    patterns: list[dict[str, Any]] | None,
    *,
    aspect: float,
    max_images: int | None = None,
    seed: int | None = None,
) -> ImagePlan:
    """Задания на картинки для вариантов: одна картинка на слайд плана, вторая — только если рамка
    в другом варианте другой формы (например, узкая вертикальная вместо широкой)."""
    params = get_skill("image_generator").params or {}
    layout_ratio = str(params.get("layout_ratio") or "1:1")
    limit = settings.t2i_max_images if max_images is None else max_images
    base_seed = settings.t2i_seed if seed is None else seed
    by_id = {pattern["id"]: pattern for pattern in patterns or []}
    first: dict[str, ImageJob] = {}
    extra: list[ImageJob] = []
    for draft in drafts:
        for slide in getattr(draft, "slides", draft):
            if not needs_image(slide):
                continue
            ref = slide.ref or slide.id
            ratio = frame_ratio(slide, by_id, aspect, layout_ratio)
            job = first.get(ref)
            if job is None:
                first[ref] = ImageJob(
                    ref=ref,
                    ratio=ratio,
                    seed=base_seed + len(first),
                    title=_clean(slide.title, 200),
                    summary=_clean(slide.summary, 240),
                    bullets=[_clean(item, 160) for item in slide.bullets[:4]],
                    idea=_idea(slide),
                )
            elif ratio != job.ratio and not any(item.ref == ref and item.ratio == ratio for item in extra):
                extra.append(ImageJob(**{**job.__dict__, "ratio": ratio}))
    kept = list(first.values())[: max(0, limit)]
    refs = {job.ref for job in kept}
    kept += [job for job in extra if job.ref in refs][: max(0, limit - len(kept))]
    return ImagePlan(jobs=kept, over_limit=max(0, len(first) - len(refs)))


# --- сюжеты и картинки ----------------------------------------------------------------------------


@dataclass
class IllustrationResult:
    requested: int = 0
    generated: int = 0
    failed: int = 0
    over_limit: int = 0
    seconds: float = 0.0
    model: str | None = None
    medium: str = ""
    style_source: str = ""
    director: str = "skip"  # llm | fallback
    usage: Usage | None = None
    errors: list[str] = field(default_factory=list)

    def detail(self) -> str:
        if not self.requested:
            return "В вариантах нет слайдов, которым нужна иллюстрация"
        parts = [f"{self.model}: иллюстраций {self.generated} из {self.requested} за {self.seconds:.0f} с"]
        if self.medium:
            parts.append(f"стиль шаблона: {self.medium}" + (" (по палитре)" if self.style_source == "fallback" else ""))
        if self.director == "llm":
            parts.append("сюжеты — арт-директор")
        if self.failed:
            parts.append(f"не получились: {self.failed}")
        if self.over_limit:
            parts.append(f"сверх лимита T2I_MAX_IMAGES: {self.over_limit}")
        return " · ".join(parts)


def _subjects(
    jobs: list[ImageJob],
    *,
    title: str,
    purpose: str,
    style: dict[str, Any],
    custom_skills: list[dict[str, Any]] | None,
    result: IllustrationResult,
) -> dict[str, str]:
    """Сюжеты картинок одним запросом к LLM: ref → subject. Пусто — модели нет или она не ответила."""
    unique: dict[str, ImageJob] = {}
    for job in jobs:
        unique.setdefault(job.ref, job)
    if not unique or not llm_enabled():
        return {}
    skill = get_skill("image_director")
    params = skill.params or {}
    prompt = skill.prompt or {}
    lines = []
    for number, job in enumerate(unique.values(), start=1):
        lines.append(f"{number}. Заголовок: {job.title}")
        if job.summary and job.summary != job.title:
            lines.append(f"   Мысль слайда: {job.summary}")
        if job.bullets:
            lines.append("   Тезисы: " + "; ".join(job.bullets))
        if job.idea:
            lines.append(f"   Идея автора текстов: {job.idea}")
    values = {
        "title": title,
        "purpose": purpose,
        "style": style.get("style") or "",
        "subjects": style.get("subjects") or "",
        "slides": "\n".join(lines),
    }
    system, user = prompt.get("system") or "", prompt.get("user") or ""
    for key, value in values.items():
        system, user = system.replace("{" + key + "}", value), user.replace("{" + key + "}", value)
    if extra := custom_skill_context(custom_skills, {"all", "design"}):
        system += "\n\nПользовательские правила оформления колоды:\n" + extra
    result.usage = Usage()
    with open_client() as http:
        answer = ask(
            http,
            system=system,
            user=user,
            schema=DIRECTOR_SCHEMA,
            usage=result.usage,
            label="сюжеты иллюстраций",
            max_tokens=int(params.get("max_tokens", 1500)),
            temperature=float(params.get("temperature", 0.5)),
        )
    refs = list(unique)
    subjects = {}
    for item in (answer or {}).get("images") or []:
        number, subject = item.get("n"), _clean(item.get("subject"), 400).rstrip(".")
        if isinstance(number, int) and 1 <= number <= len(refs) and subject:
            subjects[refs[number - 1]] = subject
    return subjects


def compose_prompt(subject: str, style: dict[str, Any]) -> str:
    template = str((get_skill("image_generator").prompt or {}).get("template") or "{subject}. {style}")
    values = {
        "subject": subject.rstrip("."),
        "style": (style.get("style") or "").strip(),
        "background": style.get("background") or "plain light background",
        "colors": ", ".join(style.get("colors") or []) or "#0077FF",
    }
    for key, value in values.items():
        template = template.replace("{" + key + "}", value)
    return " ".join(template.split())


def run_images(
    plan: ImagePlan,
    *,
    presentation_id: Any,
    title: str,
    purpose: str,
    style: dict[str, Any],
    custom_skills: list[dict[str, Any]] | None = None,
) -> IllustrationResult:
    """Сюжеты и картинки по плану (вызывать в потоке): задания получают subject, prompt и url либо error."""
    cfg = t2i.t2i_config()
    result = IllustrationResult(
        requested=len({job.ref for job in plan.jobs}),
        over_limit=plan.over_limit,
        model=cfg.model,
        medium=str(style.get("medium") or ""),
        style_source=str(style.get("source") or ""),
    )
    if not plan.jobs or not cfg.enabled:
        return result
    started = time.monotonic()
    subjects = _subjects(plan.jobs, title=title, purpose=purpose, style=style, custom_skills=custom_skills, result=result)
    result.director = "llm" if subjects else "fallback"
    for job in plan.jobs:
        job.subject = subjects.get(job.ref) or job.idea or f"A simple symbolic composition that illustrates the idea: {job.title}"
        job.prompt = compose_prompt(job.subject, style)

    params = get_skill("image_generator").params or {}
    with t2i.open_client(cfg) as http:

        def work(job: ImageJob) -> None:
            try:
                job.url = save_image(t2i.generate_image(http, job.prompt, ratio=job.ratio, seed=job.seed, cfg=cfg), presentation_id, params)
            except Exception as exc:  # noqa: BLE001 — одна картинка не должна ронять генерацию колоды
                job.error = str(exc)[:300]
                logger.warning("Картинка для слайда %s не получилась: %s", job.ref, job.error)

        in_parallel(plan.jobs, work, limit=cfg.concurrency)
    done = {job.ref for job in plan.jobs if job.url}
    result.generated = len(done)
    result.failed = result.requested - result.generated
    result.errors = [job.error for job in plan.jobs if job.error][:3]
    result.seconds = time.monotonic() - started
    logger.info("Иллюстрации: %s", result.detail())
    return result


# --- вёрстка --------------------------------------------------------------------------------------


def without_image(slide: Slide, patterns, roles: dict[str, Any], layouts: list[dict[str, Any]], *, position: int = 0) -> None:
    """Картинки нет — слайд становится тезисами: пустая рамка «здесь будет изображение» хуже, чем без неё."""
    slide.kind = "bullets"
    slide.image = None
    relayout_edited_slide(slide, patterns, roles, layouts, position=position)


def apply_images(
    drafts: list[Any],
    plan: ImagePlan | None,
    *,
    patterns: list[dict[str, Any]] | None,
    roles: dict[str, Any],
    layouts: list[dict[str, Any]],
    aspect: float,
    drop_missing: bool = True,
) -> int:
    """Картинки — в слайды вариантов; слайды «текст и изображение» без картинки верстаются тезисами
    (drop_missing=False — остаются с рамкой под картинку). Возвращает, сколько слайдов свёрстано без
    картинки. Слайд с картинкой на паттерне без места под неё (фото из материалов подставлено в слайд
    карточек) перевёрстывается."""
    params = get_skill("image_generator").params or {}
    layout_ratio = str(params.get("layout_ratio") or "1:1")
    by_id = {pattern["id"]: pattern for pattern in patterns or []}
    exact: dict[tuple[str, str], ImageJob] = {}
    by_ref: dict[str, ImageJob] = {}
    for job in (plan.jobs if plan else []):
        if job.url:
            exact.setdefault((job.ref, job.ratio), job)
            by_ref.setdefault(job.ref, job)
    dropped = 0
    for draft in drafts:
        position = getattr(draft, "position", 0)
        for slide in getattr(draft, "slides", draft):
            if slide.kind != "image_text":
                continue
            if needs_image(slide):
                ref = slide.ref or slide.id
                ratio = frame_ratio(slide, by_id, aspect, layout_ratio)
                job = exact.get((ref, ratio)) or by_ref.get(ref)
                if job is None:
                    if drop_missing:
                        without_image(slide, patterns, roles, layouts, position=position)
                        dropped += 1
                    continue
                slide.image = ImageSpec(prompt=job.subject, url=job.url, status="generated")
            pattern = by_id.get(slide.pattern_id or "")
            if pattern is not None and pattern.get("type") != "image_text":
                relayout_edited_slide(slide, patterns, roles, layouts, position=position)
    return dropped


def remember_images(specs: list[dict[str, Any]], drafts: list[Any]) -> None:
    """Картинки — часть плана прогона: рерол варианта берёт их, а не рисует заново."""
    found: dict[str, dict[str, str]] = {}
    for draft in drafts:
        for slide in getattr(draft, "slides", draft):
            if slide.ref and slide.image and slide.image.url and slide.kind == "image_text":
                found.setdefault(slide.ref, {"url": slide.image.url, "prompt": slide.image.prompt})
    for spec in specs:
        if spec.get("ref") in found:
            spec["image"] = found[spec["ref"]]
