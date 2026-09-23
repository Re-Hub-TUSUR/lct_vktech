"""Базовые типы проекта (папки), без зависимостей от других schemas-модулей.

Вынесены отдельно, чтобы app.schemas.presentation и app.schemas.project могли оба
ссылаться на ProjectColor/ProjectIcon, не импортируя друг друга.
"""

from typing import Literal

# Фиксированная палитра цветов папок в стиле macOS.
ProjectColor = Literal[
    "blue",
    "purple",
    "pink",
    "red",
    "orange",
    "yellow",
    "green",
    "mint",
    "indigo",
    "gray",
]

PROJECT_COLORS: tuple[ProjectColor, ...] = (
    "blue",
    "purple",
    "pink",
    "red",
    "orange",
    "yellow",
    "green",
    "mint",
    "indigo",
    "gray",
)

# Набор иконок папки (соответствуют lucide-react на фронтенде).
ProjectIcon = Literal[
    "folder",
    "graduation-cap",
    "book-open",
    "cpu",
    "brain",
    "layers",
    "rocket",
    "briefcase",
    "code",
    "star",
    "target",
    "lightbulb",
    "flame",
    "users",
    "megaphone",
    "palette",
    "flask-conical",
]

PROJECT_ICONS: tuple[ProjectIcon, ...] = (
    "folder",
    "graduation-cap",
    "book-open",
    "cpu",
    "brain",
    "layers",
    "rocket",
    "briefcase",
    "code",
    "star",
    "target",
    "lightbulb",
    "flame",
    "users",
    "megaphone",
    "palette",
    "flask-conical",
)

ProjectAccessRole = Literal["owner", "editor", "viewer"]
ProjectShareRole = Literal["viewer", "editor"]
