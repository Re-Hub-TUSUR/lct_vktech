from app.pipeline.theme import contrast_ratio, slide_theme


def test_tokens_are_extracted(parsed):
    _, result = parsed
    tokens = result.tokens
    assert result.slides_count > 0
    assert tokens["slide_size"]["aspect"] == "16:9"
    assert tokens["theme"]["colors"].get("accent1", "").startswith("#")
    assert tokens["palette"], "палитра не должна быть пустой"
    assert tokens["fonts"], "должна быть найдена хотя бы одна гарнитура"
    assert tokens["type_scale"], "типографическая шкала не должна быть пустой"


def test_layout_roles_point_to_existing_layouts(parsed):
    _, result = parsed
    keys = {layout["key"] for layout in result.layouts}
    for role in ("title", "content", "closing"):
        assert result.roles[role] in keys, f"роль {role} не назначена"
    assert result.roles["content"] != result.roles["title"]
    content = next(layout for layout in result.layouts if layout["key"] == result.roles["content"])
    assert any(p["type"] in {"TITLE", "CENTER_TITLE"} for p in content["placeholders"])


def test_slide_theme_is_readable(parsed):
    _, result = parsed
    theme = slide_theme(result.tokens)
    assert contrast_ratio(theme["text"], theme["background"]) >= 4.5
    for role in ("cover", "section", "closing"):
        assert contrast_ratio(theme[role]["text"], theme[role]["background"]) >= 3.0
    assert theme["accents"]


def test_layout_frames_and_title_style(parsed):
    _, result = parsed
    content = next(layout for layout in result.layouts if layout["key"] == result.roles["content"])
    title = content["frames"]["title"]
    body = content["frames"]["body"]
    assert title and body
    assert all(0 <= value <= 1 for value in title + body)
    assert body[1] > title[1], "контент должен начинаться ниже заголовка"
    assert set(content["title_style"]) == {"size_pt", "color", "anchor", "align", "bold"}
