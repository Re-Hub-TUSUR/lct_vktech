"""Студия: оформление участников, версии скиллов и примеры стандартных скиллов."""

import uuid

from app.pipeline.skills import load_skill_presets
from app.schemas.slide import GenerateSlideRequest, Slide, SlideAnimation
from app.services.collab import COLORS, initials, user_color


def test_initials_and_colors_are_stable():
    assert initials("Анна Ковалёва") == "АК"
    assert initials("Илья") == "И"
    assert initials("") == "?"
    user = uuid.uuid4()
    assert user_color(user) == user_color(str(user))
    assert user_color(user) in COLORS


def test_presets_have_before_after_examples():
    presets = load_skill_presets()
    assert presets
    assert all(preset.example_before and preset.example_after for preset in presets)


def test_next_version_is_minor_bump():
    from app.api.routes.skills import next_version

    assert next_version("1.2.0") == "1.3.0"
    assert next_version("1.0.7") == "1.1.0"
    assert next_version("broken") == "1.1.0"


def test_slide_accepts_studio_fields():
    slide = Slide(
        kind="bullets",
        title="T",
        animations=[SlideAnimation(target="title", type="zoom", trigger="after")],
        transition={"type": "wipe", "duration_ms": 400},
        hidden_elements=["subtitle"],
        locked_elements=["shape:x"],
    )
    dumped = slide.model_dump(mode="json")
    assert dumped["animations"][0]["type"] == "zoom"
    assert dumped["transition"]["type"] == "wipe"
    assert Slide.model_validate(dumped) == slide
    assert GenerateSlideRequest(prompt="Итоги пилота").pattern == "auto"
