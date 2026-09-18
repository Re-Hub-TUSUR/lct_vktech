import os
from pathlib import Path

import pytest

from app.pipeline.parsing.template_parser import ParsedTemplate, parse_template

REPO_DIR = Path(__file__).resolve().parents[2]
TEMPLATES_DIR = Path(os.environ.get("BUILTIN_TEMPLATES_DIR", REPO_DIR / "shablon"))


def template_files() -> list[Path]:
    return sorted(TEMPLATES_DIR.glob("*.pptx")) if TEMPLATES_DIR.exists() else []


@pytest.fixture(scope="session", params=template_files() or [None], ids=lambda p: p.stem if p else "no-templates")
def parsed(request) -> tuple[Path, ParsedTemplate]:
    if request.param is None:
        pytest.skip(f"Нет шаблонов в {TEMPLATES_DIR}")
    return request.param, parse_template(request.param)
