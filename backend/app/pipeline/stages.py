"""Стадии пайплайна генерации — порядок, названия и скиллы."""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class StageDef:
    key: str
    title: str
    skill: str | None


STAGES: tuple[StageDef, ...] = (
    StageDef("template", "Декомпозиция шаблона", "template_parser"),
    StageDef("content", "Анализ контент-пакета", "content_analyzer"),
    StageDef("outline", "Генерация структуры", "outline_planner"),
    StageDef("copy", "Тексты слайдов", "slide_writer"),
    StageDef("layout", "Вёрстка трёх вариантов", "layout_composer"),
    StageDef("visuals", "Графики, таблицы и инфографика", "visualizer"),
    StageDef("images", "Генерация изображений", "image_generator"),
    StageDef("motion", "Анимации и переходы", None),
    StageDef("render", "Сборка слайдов по шаблону", None),
    StageDef("audit", "Аудит слайдов", "auditor"),
)
STAGE_BY_KEY = {stage.key: stage for stage in STAGES}


def initial_stages(*, generate_images: bool, animations: str = "subtle") -> list[dict[str, Any]]:
    stages = []
    for stage in STAGES:
        skipped = (stage.key == "images" and not generate_images) or (stage.key == "motion" and animations == "none")
        stages.append(
            {
                "key": stage.key,
                "title": stage.title,
                "skill": stage.skill,
                "status": "skipped" if skipped else "pending",
                "detail": "Отключено в настройках генерации" if skipped else None,
                "started_at": None,
                "finished_at": None,
            }
        )
    return stages
