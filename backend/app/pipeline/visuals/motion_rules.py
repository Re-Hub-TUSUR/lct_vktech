"""Автоанимации колоды: правила по типу слайда, без модели.

Анимации появления и переходы расставляются одинаково на всей колоде и предсказуемо — это оформление,
а не содержание, модели тут нечего решать. Запуск автоматический (trigger «after»): слайд оживает сам,
без кликера — и в показе редактора, и в .pptx (export/motion.py пишет нативные эффекты PowerPoint).

Заголовок не анимируется: слайд открывается вместе с ним, движение даёт переход. Адреса элементов —
те, что сборка отдаёт рамками (bullets.1, columns.0, chart…), поэтому export/motion.py находит их фигуры.
"""

from __future__ import annotations

from typing import Literal

from app.schemas.slide import Slide, SlideAnimation, SlideTransition

MotionMode = Literal["none", "subtle", "lively"]
MOTION_LABELS: dict[str, str] = {"none": "Без анимаций", "subtle": "Сдержанные", "lively": "Живые"}

# Больше стольких однотипных элементов — анимируется блок целиком, иначе слайд долго «тикает».
MAX_STEPS = 6
FIRST_DELAY_MS = 200
DURATION = {"subtle": 450, "lively": 600}
# Эффект по роли элемента: (сдержанные, живые).
EFFECTS: dict[str, tuple[str, str]] = {
    "subtitle": ("fade", "up"),
    "section_number": ("fade", "zoom"),
    "image": ("fade", "zoom"),
    "bullets": ("up", "left"),
    "columns": ("fade", "up"),
    "kpis": ("fade", "zoom"),
    "timeline": ("wipe", "left"),
    "chart": ("wipe", "wipe"),
    "table": ("fade", "up"),
    "quote": ("fade", "zoom"),
}
COVER_KINDS = {"title", "closing"}


def _units(slide: Slide, key: str) -> list[str]:
    """Пункты блока по одному (bullets.0, bullets.1…) или блок целиком, если пунктов слишком много."""
    count = len(getattr(slide, key) or [])
    if count == 0:
        return []
    return [f"{key}.{index}" for index in range(count)] if count <= MAX_STEPS else [key]


def _sequence(slide: Slide) -> list[tuple[str, str, bool]]:
    """Порядок появления: (адрес, роль эффекта, вместе с предыдущим)."""
    kind = slide.kind
    steps: list[tuple[str, str, bool]] = []
    if kind in COVER_KINDS:
        if slide.subtitle:
            steps.append(("subtitle", "subtitle", False))
        if slide.image and slide.image.url:
            steps.append(("image", "image", bool(steps)))
        return steps
    if kind == "section":
        return [("subtitle", "section_number", False)] if slide.subtitle else []
    if kind == "image_text" and slide.image:
        steps.append(("image", "image", False))
    if kind in {"bullets", "agenda", "image_text"}:
        steps += [(target, "bullets", False) for target in _units(slide, "bullets")]
    elif kind in {"cards", "two_columns"}:
        steps += [(target, "columns", False) for target in _units(slide, "columns")]
    elif kind == "kpi":
        steps += [(target, "kpis", False) for target in _units(slide, "kpis")]
    elif kind == "timeline":
        steps += [(target, "timeline", False) for target in _units(slide, "timeline")]
    elif kind == "chart" and slide.chart:
        steps.append(("chart", "chart", False))
    elif kind == "table" and slide.table:
        steps.append(("table", "table", False))
    elif kind == "quote" and slide.quote:
        steps.append(("quote", "quote", False))
    return steps


def _transition(slide: Slide, mode: MotionMode) -> SlideTransition:
    if mode == "lively":
        kind = "push" if slide.kind == "section" else "zoom" if slide.kind in COVER_KINDS else "fade"
        return SlideTransition(type=kind, duration_ms=600)
    return SlideTransition(type="fade", duration_ms=500)


def animate_slide(slide: Slide, mode: MotionMode, *, overwrite: bool = False) -> Slide:
    """Слайд с анимациями по правилам. Без overwrite ручные анимации и переход пользователя не трогаются."""
    if mode == "none":
        # «Без анимаций» кнопкой редактора (overwrite) снимает всё; при генерации — ничего не ставит.
        return slide.model_copy(update={"animations": [], "transition": None}) if overwrite else slide
    update: dict = {}
    if overwrite or slide.transition is None:
        update["transition"] = _transition(slide, mode)
    if overwrite or not slide.animations:
        hidden = set(slide.hidden_elements or [])
        index = 1 if mode == "lively" else 0
        animations = []
        for target, role, together in _sequence(slide):
            if target in hidden or target.split(".")[0] in hidden:
                continue
            animations.append(
                SlideAnimation(
                    target=target,
                    type=EFFECTS[role][index],
                    duration_ms=DURATION[mode] + (200 if role == "chart" and mode == "lively" else 0),
                    delay_ms=FIRST_DELAY_MS if not animations else 0,
                    trigger="with" if together and animations else "after",
                )
            )
        update["animations"] = animations
    return slide.model_copy(update=update) if update else slide


def animate_deck(slides: list[Slide], mode: MotionMode, *, overwrite: bool = False) -> list[Slide]:
    return [animate_slide(slide, mode, overwrite=overwrite) for slide in slides]
