"""Подгонка текста под слоты выбранного паттерна — моделью, а не уменьшением кегля.

Автор текстов пишет до вёрстки и знает только типичную ёмкость шаблона. После подбора паттернов
у каждого слайда известны точные лимиты слотов (pattern.schema). Слайд, чей текст заметно длиннее
(planning/budgets.overflow_ratio), сокращает редактор слайда (planning/editor.py) — те же элементы,
те же числа, короче формулировки. Паттерн слайда затем перепроверяется: сокращённый текст мог
подойти другому слайду-примеру лучше. Без модели остаётся автоподбор кегля при сборке.
"""

import logging
from dataclasses import dataclass, field
from typing import Any

from app.pipeline.ai.llm import in_parallel, llm_enabled
from app.pipeline.layout.matcher import assign_patterns
from app.pipeline.planning.budgets import overflow_ratio
from app.pipeline.planning.editor import EditError, edit_slide
from app.pipeline.planning.typography import polish_slide
from app.schemas.slide import Slide

logger = logging.getLogger(__name__)

# Во сколько раз текст может превышать ёмкость слотов, прежде чем его сократят (остальное ужмёт кегль).
FIT_THRESHOLD = 1.2
INSTRUCTION = (
    "Текст не помещается в слоты макета шаблона (длиннее примерно в {ratio:.1f} раза). Сократи формулировки "
    "до ограничений вёрстки, сохранив смысл, все числа и число элементов. Заголовок — вывод."
)


@dataclass
class FitResult:
    checked: int = 0
    shortened: int = 0
    failed: int = 0
    slides: list[str] = field(default_factory=list)

    def detail(self) -> str:
        if not self.shortened and not self.failed:
            return ""
        parts = [f"текст сокращён под слоты шаблона: {self.shortened} сл."]
        if self.failed:
            parts.append(f"не удалось: {self.failed}")
        return ", ".join(parts)


def fit_drafts(
    drafts: list[Any],
    patterns: list[dict[str, Any]] | None,
    *,
    layout_names: dict[str, str],
    title: str,
    purpose: str,
    brief: str,
    sources: str,
    language: str = "ru",
    tone: str = "business",
    audience: str = "",
    custom_skills: list[dict[str, Any]] | None = None,
    threshold: float = FIT_THRESHOLD,
) -> FitResult:
    """Сокращает переполненные слайды всех вариантов (на месте). Вызывать в потоке."""
    result = FitResult()
    if not llm_enabled() or not patterns:
        return result
    by_id = {pattern["id"]: pattern for pattern in patterns if pattern.get("usable") or pattern.get("service")}
    jobs: list[tuple[Any, int, float]] = []
    for draft in drafts:
        for index, slide in enumerate(draft.slides):
            pattern = by_id.get(slide.pattern_id or "")
            if pattern is None or slide.kind in {"title", "section", "closing"}:
                continue
            result.checked += 1
            ratio = overflow_ratio(slide, pattern)
            if ratio > threshold:
                jobs.append((draft, index, ratio))
    if not jobs:
        return result

    def work(job: tuple[Any, int, float]) -> Slide | None:
        draft, index, ratio = job
        slide = draft.slides[index]
        try:
            edited = edit_slide(
                slide,
                INSTRUCTION.format(ratio=ratio),
                deck=draft.slides,
                title=title,
                purpose=purpose,
                brief=brief,
                sources=sources,
                language=language,
                tone=tone,
                audience=audience,
                custom_skills=custom_skills,
                pattern=by_id.get(slide.pattern_id or ""),
            ).slide
        except EditError as exc:
            logger.warning("Слайд «%s» не сокращён: %s", slide.title, exc)
            return None
        return polish_slide(edited, language)

    for (draft, index, _), edited in zip(jobs, in_parallel(jobs, work)):
        if edited is None:
            result.failed += 1
            continue
        draft.slides[index] = edited
        result.shortened += 1
        result.slides.append(edited.id)
    # Сокращённый текст мог подойти другому слайду-примеру лучше — паттерны перепроверяются.
    for draft in drafts:
        changed = [slide for slide in draft.slides if slide.id in result.slides]
        if changed:
            assign_patterns(changed, patterns, position=draft.position, layout_names=layout_names, keep=True)
    return result
