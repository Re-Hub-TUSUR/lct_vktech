"""Паттерны из макетов — для шаблонов, где мало слайдов-примеров.

Корпоративные шаблоны (особенно .potx) часто приходят почти без слайдов: дизайн задан
макетами. Макет с заголовком и несколькими областями контента — тоже паттерн: две колонки,
сравнение с подзаголовками, сетка карточек, текст с картинкой. При сборке слайд создаётся
на этом макете заново, текст ставится в его плейсхолдеры и наследует их стиль
(шрифт, кегль, маркеры), как если бы слайд верстал дизайнер вручную.

Слоты ссылаются на плейсхолдеры по idx (id фигур у нового слайда свои): id слота =
PH_BASE + idx. Подбор отдаёт предпочтение слайдам-примерам — в них дизайна больше.
"""

from typing import Any

from pptx.enum.shapes import PP_PLACEHOLDER

from app.pipeline.parsing.patterns import EMU_PER_PT, is_usable, pattern_schema

PH_BASE = 1_000_000
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
BODY_TYPES = {PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT}
SKIP_ROLES = {"title", "section", "closing", "blank"}


def slot_id(idx: int) -> int:
    return PH_BASE + idx


def _size(element, master, style: str) -> float | None:
    """Кегль первого уровня: lstStyle плейсхолдера макета → стиль мастера (titleStyle/bodyStyle)."""
    paths = [f"{{{NS_P}}}txBody/{{{NS_A}}}lstStyle/{{{NS_A}}}lvl1pPr/{{{NS_A}}}defRPr"]
    for path in paths:
        props = element.find(path)
        if props is not None and (size := props.get("sz", "")).isdigit():
            return int(size) / 100
    props = master._element.find(f"{{{NS_P}}}txStyles/{{{NS_P}}}{style}/{{{NS_A}}}lvl1pPr/{{{NS_A}}}defRPr")
    if props is not None and (size := props.get("sz", "")).isdigit():
        return int(size) / 100
    return None


def _box(ph, width: int, height: int) -> list[float] | None:
    if None in (ph.left, ph.top, ph.width, ph.height) or not ph.width or not ph.height:
        return None
    return [round(ph.left / width, 4), round(ph.top / height, 4), round(ph.width / width, 4), round(ph.height / height, 4)]


def _slot(ph, role: str, box: list[float], size: float | None, width: int, height: int) -> dict[str, Any]:
    size_emu = (size or (32 if role == "title" else 18)) * EMU_PER_PT
    area = box[2] * width * box[3] * height
    return {
        "id": slot_id(ph.placeholder_format.idx),
        "role": role,
        "bbox": box,
        "size": size,
        "chars": max(8, int(area / (size_emu * size_emu * 0.55 * 1.25))),
        "paragraphs": 1,
        "sample": "",
        "companions": [],
    }


def _similar(a: list[float], b: list[float]) -> bool:
    return abs(a[2] - b[2]) <= 0.25 * max(a[2], b[2]) and abs(a[3] - b[3]) <= 0.25 * max(a[3], b[3])


def _above(header: list[float], body: list[float]) -> bool:
    """Заголовок колонки: низкая область прямо над телом той же ширины (макет «Сравнение»)."""
    same_column = abs(header[0] - body[0]) <= 0.03 and abs(header[2] - body[2]) <= 0.25 * body[2]
    gap = body[1] - (header[1] + header[3])
    return same_column and -0.01 <= gap <= 0.08


def analyze_layout(layout, key: str, info: dict[str, Any], width: int, height: int) -> dict[str, Any] | None:
    master = layout.slide_master
    title_ph = None
    bodies: list[tuple[Any, list[float]]] = []
    pictures: list[tuple[Any, list[float]]] = []
    for ph in layout.placeholders:
        kind = ph.placeholder_format.type
        box = _box(ph, width, height)
        if box is None:
            continue
        if kind == PP_PLACEHOLDER.TITLE:
            title_ph = (ph, box)
        elif kind == PP_PLACEHOLDER.CENTER_TITLE:
            return None  # обложка
        elif kind in BODY_TYPES:
            bodies.append((ph, box))
        elif kind == PP_PLACEHOLDER.PICTURE:
            pictures.append((ph, box))
    if title_ph is None or not bodies:
        return None

    title_size = _size(title_ph[0]._element, master, "titleStyle")
    pattern: dict[str, Any] = {
        "id": f"l{key.replace(':', '-')}",
        "slide_index": -1,
        "origin": "layout",
        "layout_key": key,
        "layout_name": info.get("name"),
        "type": "complex",
        "category": "content",
        "usable": False,
        "service": False,
        "items_count": 0,
        "title": _slot(title_ph[0], "title", title_ph[1], title_size, width, height),
        "slots": [],
        "items": [],
        "shapes": [],
        "frames": {},
        "images": [],
        "source": "rules",
        # Тексты карточек в плейсхолдерах тела: заголовок элемента — жирным и без маркера.
        "plain_heads": True,
    }

    headers = [(ph, box) for ph, box in bodies if box[3] < 0.12]
    mains = [(ph, box) for ph, box in bodies if box[3] >= 0.12]
    pairs = []
    for body in mains:
        header = next((h for h in headers if _above(h[1], body[1])), None)
        pairs.append((header, body))
    mains_sorted = sorted(pairs, key=lambda pair: (round(pair[1][1][1] * 10), pair[1][1][0]))
    big_pictures = [(ph, box) for ph, box in pictures if box[2] * box[3] >= 0.08]

    if len(mains_sorted) >= 2 and all(_similar(mains_sorted[0][1][1], pair[1][1]) for pair in mains_sorted[1:]):
        for header, (ph, box) in mains_sorted[:8]:
            size = _size(ph._element, master, "bodyStyle")
            slots = []
            boxes = [box]
            if header is not None:
                head_size = _size(header[0]._element, master, "bodyStyle")
                slots.append(_slot(header[0], "title", header[1], head_size, width, height))
                slots.append(_slot(ph, "text", box, size, width, height))
                boxes.append(header[1])
            else:
                slots.append(_slot(ph, "title_text", box, size, width, height))
            x0 = min(b[0] for b in boxes)
            y0 = min(b[1] for b in boxes)
            x1 = max(b[0] + b[2] for b in boxes)
            y1 = max(b[1] + b[3] for b in boxes)
            pattern["items"].append(
                {
                    "bbox": [round(x0, 4), round(y0, 4), round(x1 - x0, 4), round(y1 - y0, 4)],
                    "group": None,
                    "shapes": [slot["id"] for slot in slots],
                    "slots": slots,
                    "image": None,
                }
            )
        pattern["items_count"] = len(pattern["items"])
        pattern["type"] = "two_columns" if len(pattern["items"]) == 2 else "cards"
    elif mains:
        ph, box = max(mains, key=lambda pair: pair[1][2] * pair[1][3])
        pattern["slots"].append(_slot(ph, "body", box, _size(ph._element, master, "bodyStyle"), width, height))
        if big_pictures:
            picture = max(big_pictures, key=lambda pair: pair[1][2] * pair[1][3])
            pattern["images"] = [{"id": slot_id(picture[0].placeholder_format.idx), "bbox": picture[1], "placeholder": True}]
            pattern["type"] = "image_text"
        else:
            pattern["type"] = "text"
    else:
        return None

    pattern["usable"] = is_usable(pattern)
    pattern["schema"] = pattern_schema(pattern)
    return pattern


def extract_layout_patterns(prs, layouts: list[dict[str, Any]], roles: dict[str, Any]) -> list[dict[str, Any]]:
    """Паттерны из контентных макетов (обложки, разделители и финалы не берём)."""
    width, height = int(prs.slide_width), int(prs.slide_height)
    info_by_key = {layout["key"]: layout for layout in layouts}
    service_keys = {roles.get(role) for role in ("title", "section", "closing")} - {roles.get("content")}
    patterns = []
    for mi, master in enumerate(prs.slide_masters):
        for li, layout in enumerate(master.slide_layouts):
            key = f"{mi}:{li}"
            info = info_by_key.get(key) or {}
            if key in service_keys or info.get("role") in SKIP_ROLES:
                continue
            try:
                pattern = analyze_layout(layout, key, info, width, height)
            except Exception:  # noqa: BLE001 — нестандартный макет просто не даёт паттерна
                pattern = None
            if pattern is not None and pattern["usable"]:
                patterns.append(pattern)
    return patterns
