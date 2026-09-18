"""Стадии пайплайна генерации — порядок, названия, скиллы и длительность заглушек."""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class StageDef:
    key: str
    title: str
    skill: str | None
    # Сколько секунд длится стадия-заглушка при MOCK_SPEED=1.
    mock_seconds: float


STAGES: tuple[StageDef, ...] = (
    StageDef("template", "Декомпозиция шаблона", "template_parser", 1.2),
    StageDef("content", "Анализ контент-пакета", "content_analyzer", 1.0),
    StageDef("outline", "Генерация структуры", "outline_planner", 2.0),
    StageDef("copy", "Тексты слайдов", "slide_writer", 2.0),
    StageDef("layout", "Вёрстка трёх вариантов", "layout_composer", 2.5),
    StageDef("visuals", "Графики, таблицы и инфографика", "visualizer", 1.5),
    StageDef("images", "Генерация изображений", "image_generator", 1.5),
    StageDef("audit", "Аудит слайдов", "auditor", 2.0),
)
STAGE_BY_KEY = {stage.key: stage for stage in STAGES}


def initial_stages(*, generate_images: bool) -> list[dict[str, Any]]:
    stages = []
    for stage in STAGES:
        skipped = stage.key == "images" and not generate_images
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
