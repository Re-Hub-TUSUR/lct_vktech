"""Шаблонные скиллы из backend/skills/presets: загружаются и не ломают детерминированные правила аудита."""

from typing import get_args

from app.pipeline.audit.fixes import apply_custom_style_rules
from app.pipeline.skills import PRESET_PREFIX, custom_skill_context, load_skill_presets, skills_snapshot
from app.schemas.custom_skill import SkillKind
from app.schemas.slide import Slide


def _as_custom(preset) -> dict:
    return {"id": preset.id, "title": preset.title, "kind": preset.kind, "instruction": preset.instruction,
            "version": preset.version, "enabled": True}


def test_presets_load_with_unique_ids_and_valid_kinds():
    presets = load_skill_presets()
    assert len(presets) >= 6
    ids = [preset.id for preset in presets]
    assert len(ids) == len(set(ids))
    for preset in presets:
        assert preset.id.startswith(PRESET_PREFIX)
        assert preset.kind in get_args(SkillKind)
        assert preset.title and preset.instruction


def test_presets_do_not_turn_titles_into_questions():
    slides = [Slide(kind="bullets", title="Выручка выросла на 34%")]
    applied = apply_custom_style_rules(slides, [_as_custom(preset) for preset in load_skill_presets()])
    assert applied == []
    assert slides[0].title == "Выручка выросла на 34%"


def test_disabled_preset_is_skipped():
    preset = load_skill_presets()[0]
    custom = [{**_as_custom(preset), "enabled": False}]
    assert custom_skill_context(custom) == ""
    assert all(item.get("source") != "custom" for item in skills_snapshot(custom))
