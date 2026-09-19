"""Вёрстка по паттернам: клон слайда-примера шаблона + заполнение слотов.

Слайд-пример копируется со всеми фигурами, картинками и фоном, затем текст-заглушка
в слотах заменяется содержимым с сохранением форматирования шаблона (шрифт, кегль,
цвет, маркеры — из абзацев самого слота). Лишние карточки удаляются целиком, а текст
примера, которому не нашлось содержимого, убирается — в готовом слайде остаются только
сгенерированные тексты и оформление шаблона.
"""

import copy
import re
from dataclasses import dataclass, field
from typing import Any

from lxml import etree
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn

from app.schemas.slide import Slide, TableData

R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
COPYABLE_RELTYPES = {
    RT.IMAGE,
    RT.MEDIA,
    RT.VIDEO,
    RT.AUDIO,
    RT.HYPERLINK,
    "http://schemas.microsoft.com/office/2007/relationships/hdphoto",
    "http://schemas.microsoft.com/office/2007/relationships/media",
}
LINK_TAGS = {qn("a:hlinkClick"), qn("a:hlinkHover")}
TREE_HEADER = {qn("p:nvGrpSpPr"), qn("p:grpSpPr")}
AUTOFIT_TAGS = {qn("a:noAutofit"), qn("a:normAutofit"), qn("a:spAutoFit")}
NUMBERING_RX = re.compile(r"^0?\d{1,2}[.)]?$")
# Адрес элемента для подсветки аудита: совпадает с target в проверках (bullets.2, columns.0, kpis.1…).
ITEM_TARGETS = {"two_columns": "columns", "cards": "columns", "kpi": "kpis", "timeline": "timeline", "agenda": "bullets"}


@dataclass
class ItemContent:
    title: str = ""
    lines: list[str] = field(default_factory=list)
    value: str = ""
    date: str = ""


@dataclass
class PatternContent:
    title: str
    subtitle: str | None = None
    body: list[str] = field(default_factory=list)
    items: list[ItemContent] = field(default_factory=list)


def content_for(slide: Slide) -> PatternContent:
    """Содержимое слайда в терминах слотов паттерна (общее для подбора и заполнения)."""
    content = PatternContent(title=slide.title, subtitle=slide.subtitle)
    kind = slide.kind
    if kind in {"two_columns", "cards"}:
        content.items = [ItemContent(title=column.title, lines=list(column.bullets)) for column in slide.columns]
    elif kind == "kpi":
        content.items = [ItemContent(value=kpi.value, lines=[kpi.label] if kpi.label else []) for kpi in slide.kpis]
    elif kind == "timeline":
        content.items = [
            ItemContent(title=item.title, date=item.date, lines=[item.text] if item.text else []) for item in slide.timeline
        ]
    elif kind == "agenda":
        content.items = [ItemContent(title=bullet) for bullet in slide.bullets]
        content.body = list(slide.bullets)
    elif kind == "quote" and slide.quote:
        content.body = [f"«{slide.quote.text}»"] + ([f"— {slide.quote.author}"] if slide.quote.author else [])
    else:
        content.body = list(slide.bullets)
    return content


def units(pattern: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    """Повторяющиеся элементы паттерна. Для KPI к карточкам добавляются одиночные показатели с подписью."""
    result = [dict(item, single=False) for item in pattern["items"]]
    if kind != "kpi":
        return result
    slots = pattern["slots"]
    for index, slot in enumerate(slots):
        if slot["role"] != "value":
            continue
        unit_slots = [slot]
        label = slots[index + 1] if index + 1 < len(slots) and slots[index + 1]["role"] == "value_label" else None
        if label is not None:
            unit_slots.append(dict(label, role="text"))
        result.append(
            {
                "bbox": slot["bbox"],
                "group": None,
                "shapes": [s["id"] for s in unit_slots],
                "slots": unit_slots,
                "image": None,
                "single": True,
            }
        )
    return result


# --- клонирование ------------------------------------------------------------------


def clone_slide(prs, source):
    """Копия слайда-примера в конце презентации: фигуры, картинки, ссылки и фон."""
    slide = prs.slides.add_slide(source.slide_layout)
    tree = slide.shapes._spTree
    for element in list(tree):
        if element.tag not in TREE_HEADER:
            tree.remove(element)

    rid_map: dict[str, str] = {}
    for rel in source.part.rels.values():
        if rel.reltype in COPYABLE_RELTYPES:
            target = rel.target_ref if rel.is_external else rel.target_part
            rid_map[rel.rId] = slide.part.relate_to(target, rel.reltype, is_external=rel.is_external)

    def remap(element) -> bool:
        for node in list(element.iter()):
            for attr, value in list(node.attrib.items()):
                if not attr.startswith(R_NS):
                    continue
                if value in rid_map:
                    node.set(attr, rid_map[value])
                elif node.tag in LINK_TAGS:
                    # Переход на другой слайд шаблона — в новой колоде его нет.
                    node.getparent().remove(node)
                    break
                else:
                    return False  # диаграммы, OLE, SmartArt: без своих частей не копируются
        return True

    for element in source.shapes._spTree.iterchildren():
        if element.tag in TREE_HEADER:
            continue
        clone = copy.deepcopy(element)
        if remap(clone):
            tree.append(clone)

    c_sld = slide._element.find(qn("p:cSld"))
    background = source._element.find(f"{qn('p:cSld')}/{qn('p:bg')}")
    if background is not None:
        clone = copy.deepcopy(background)
        if remap(clone):
            c_sld.insert(0, clone)
    color_map = source._element.find(qn("p:clrMapOvr"))
    if color_map is not None:
        current = slide._element.find(qn("p:clrMapOvr"))
        if current is not None:
            slide._element.remove(current)
        c_sld.addnext(copy.deepcopy(color_map))
    return slide


# --- работа с текстом ---------------------------------------------------------------


def shape_elements(slide) -> dict[int, Any]:
    """id фигуры → её элемент (sp, pic, grpSp, graphicFrame, cxnSp)."""
    result = {}
    for c_nv_pr in slide._element.iter(qn("p:cNvPr")):
        result[int(c_nv_pr.get("id"))] = c_nv_pr.getparent().getparent()
    return result


def _paragraph_text(paragraph) -> str:
    return "".join(node.text or "" for node in paragraph.iter(qn("a:t"))).strip()


def _filled_paragraph(template, text: str):
    paragraph = copy.deepcopy(template)
    runs = paragraph.findall(qn("a:r"))
    for child in list(paragraph):
        if child.tag in {qn("a:r"), qn("a:br"), qn("a:fld")} and (not runs or child is not runs[0]):
            paragraph.remove(child)
    if runs:
        runs[0].find(qn("a:t")).text = text
        return paragraph
    run = etree.Element(qn("a:r"))
    end = paragraph.find(qn("a:endParaRPr"))
    if end is not None:
        props = copy.deepcopy(end)
        props.tag = qn("a:rPr")
        run.append(props)
    etree.SubElement(run, qn("a:t")).text = text
    if end is not None:
        end.addprevious(run)
    else:
        paragraph.append(run)
    return paragraph


def _autofit(body) -> None:
    """Сжатие текста по рамке (normAutofit): длинный текст не вылезает за карточку."""
    body_pr = body.find(qn("a:bodyPr"))
    if body_pr is None:
        return
    for child in list(body_pr):
        if child.tag in AUTOFIT_TAGS:
            body_pr.remove(child)
    autofit = etree.Element(qn("a:normAutofit"))
    warp = body_pr.find(qn("a:prstTxWarp"))
    if warp is not None:
        warp.addnext(autofit)
    else:
        body_pr.insert(0, autofit)


def set_body(body, lines: list[str], *, head: str | None = None, autofit: bool = True) -> bool:
    """Заменяет абзацы txBody. head — первый абзац в стиле первого абзаца шаблона (заголовок карточки)."""
    if body is None:
        return False
    paragraphs = body.findall(qn("a:p"))
    if not paragraphs:
        return False
    # Стиль — из абзацев самого слота: первый для первой строки (или заголовка карточки),
    # второй для следующих — у них бывают свои отступы и интервалы.
    templates = [p for p in paragraphs if _paragraph_text(p)] or paragraphs
    for paragraph in paragraphs:
        body.remove(paragraph)
    if head is not None:
        body.append(_filled_paragraph(templates[0], head))
        templates = templates[1:] or templates
    for index, line in enumerate(lines if lines or head is not None else [""]):
        body.append(_filled_paragraph(templates[min(index, len(templates) - 1, 1)], line))
    if autofit:
        _autofit(body)
    return True


def set_text(element, lines: list[str], *, head: str | None = None) -> bool:
    return set_body(element.find(qn("p:txBody")), lines, head=head)


def remove(element) -> None:
    parent = element.getparent()
    if parent is not None:
        parent.remove(element)


def drop(elements: dict[int, Any], slot: dict[str, Any]) -> None:
    """Удаляет фигуру слота вместе с оформлением, которое без неё теряет смысл: маркер строки,
    иконку, плашку-подложку (companions из парсера)."""
    for shape_id in [*slot.get("companions", []), slot["id"]]:
        if (element := elements.get(shape_id)) is not None:
            remove(element)


# --- заполнение паттерна ------------------------------------------------------------


def _fill_item(elements: dict[int, Any], unit: dict[str, Any], content: ItemContent, number: int) -> None:
    slots: dict[str, list[tuple[dict[str, Any], Any]]] = {}
    for slot in unit["slots"]:
        if (element := elements.get(slot["id"])) is not None:
            slots.setdefault(slot["role"], []).append((slot, element))
    title, lines, date = content.title, list(content.lines), content.date

    for index, (slot, element) in enumerate(slots.get("value", [])):
        if index:
            drop(elements, slot)
            continue
        set_text(element, [content.value or date or f"{number:02d}"])
        date = "" if not content.value else date
    for slot, element in slots.get("date", []):
        set_text(element, [date or f"{number:02d}"])
        date = ""
    for slot, element in slots.get("number", []):
        # В кружок номера помещается «01» или «Q4», но не «Шаг 1» — такая дата уходит в заголовок.
        fits = date and len(date) <= min(slot["chars"], 3)
        set_text(element, [date if fits else f"{number:02d}"])
        date = "" if fits else date
    if date:
        # Даты некуда поставить отдельно — она становится частью заголовка шага.
        title = f"{date} · {title}" if title else date

    heads = slots.get("title_text", []) + slots.get("title", [])
    texts = sorted(slots.get("text", []), key=lambda pair: (-(pair[0]["size"] or 0), pair[0]["bbox"][1]))
    line_slots = sorted(slots.get("lines", []), key=lambda pair: pair[0]["bbox"][1])
    if not title:
        # Без заголовка (подпись KPI) слоты заголовка работают как текстовые.
        heads, texts = [], heads + texts
    elif not heads and texts:
        # Нет отдельного слота заголовка: берём самый крупный текстовый.
        heads, texts = [texts[0]], texts[1:]
    text_capable = bool(texts or line_slots)

    for index, (slot, element) in enumerate(heads):
        if index:
            drop(elements, slot)
        elif slot["role"] == "title_text" or not text_capable:
            set_text(element, lines, head=title)
            lines = []
        else:
            set_text(element, [title])
    for index, (slot, element) in enumerate(texts):
        if index == 0 and lines:
            set_text(element, lines)
            lines = []
        else:
            drop(elements, slot)
    for index, (slot, element) in enumerate(line_slots):
        if not lines:
            drop(elements, slot)
        elif index == len(line_slots) - 1:
            set_text(element, lines)
            lines = []
        else:
            set_text(element, [lines.pop(0)])


def fill_table(frame, table: TableData) -> None:
    """Таблица шаблона под данные слайда: строки и столбцы клонируются из шаблонных, стиль сохраняется."""
    tbl = frame.find(f".//{qn('a:tbl')}")
    if tbl is None:
        return
    rows_data = [list(table.columns)] + [list(row) for row in table.rows]
    n_cols = max((len(row) for row in rows_data), default=1) or 1
    grid = tbl.find(qn("a:tblGrid"))
    columns = grid.findall(qn("a:gridCol"))
    total_width = sum(int(column.get("w", "0")) for column in columns)
    for column in columns[n_cols:]:
        grid.remove(column)
    while len(grid.findall(qn("a:gridCol"))) < n_cols:
        grid.append(copy.deepcopy(columns[-1]))
    for column in grid.findall(qn("a:gridCol")):
        column.set("w", str(total_width // n_cols))

    templates = tbl.findall(qn("a:tr"))
    frame_height = sum(int(row.get("h", "0")) for row in templates)
    row_height = max(frame_height // max(len(rows_data), 1), 1)
    # Шапка — первая строка шаблона, данные — одна «типовая» строка из середины: крайние строки
    # примера часто выделены (итог, акцент), а чередование полос задаёт стиль таблицы.
    body_rows = templates[1:] or templates
    body_template = body_rows[len(body_rows) // 2]
    for row in templates:
        tbl.remove(row)
    for index, values in enumerate(rows_data):
        template = templates[0] if index == 0 else body_template
        row = copy.deepcopy(template)
        row.set("h", str(min(int(template.get("h", "0")) or row_height, row_height)))
        cells = row.findall(qn("a:tc"))
        for cell in cells[n_cols:]:
            row.remove(cell)
        while len(row.findall(qn("a:tc"))) < n_cols:
            row.append(copy.deepcopy(cells[-1]))
        for cell, text in zip(row.findall(qn("a:tc")), values + [""] * n_cols):
            for attr in ("gridSpan", "rowSpan", "hMerge", "vMerge"):
                cell.attrib.pop(attr, None)
            set_body(cell.find(qn("a:txBody")), [text], autofit=False)
        tbl.append(row)

    extent = frame.find(f"{qn('p:xfrm')}/{qn('a:ext')}")
    if extent is not None:
        extent.set("cy", str(sum(int(row.get("h", "0")) for row in tbl.findall(qn("a:tr")))))


def _union(boxes: list[list[float]]) -> list[float]:
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[0] + b[2] for b in boxes)
    y1 = max(b[1] + b[3] for b in boxes)
    return [round(x0, 4), round(y0, 4), round(x1 - x0, 4), round(y1 - y0, 4)]


def fill_pattern(slide, pattern: dict[str, Any], spec: Slide) -> dict[str, list[float]]:
    """Заполняет клон слайда-примера. Возвращает рамки элементов для подсветки аудита (адрес → [x, y, w, h])."""
    elements = shape_elements(slide)
    content = content_for(spec)
    targets: dict[str, list[float]] = {}
    handled: set[int] = set()

    title = pattern.get("title")
    if title and (element := elements.get(title["id"])) is not None:
        set_text(element, [content.title])
        targets["title"] = title["bbox"]
        handled.add(title["id"])

    prefix = ITEM_TARGETS.get(spec.kind)
    kept: list[list[float]] = []
    for index, unit in enumerate(units(pattern, spec.kind)):
        handled.update(slot["id"] for slot in unit["slots"])
        if index < len(content.items):
            _fill_item(elements, unit, content.items[index], index + 1)
            kept.append(unit["bbox"])
            if prefix:
                targets[f"{prefix}.{index}"] = unit["bbox"]
        elif unit.get("group") and (group := elements.get(unit["group"])) is not None:
            remove(group)
        else:
            for shape_id in unit["shapes"]:
                if (element := elements.get(shape_id)) is not None:
                    remove(element)
    if prefix and kept:
        targets[prefix] = _union(kept)

    table = pattern["frames"].get("table")
    if table and spec.table and (frame := elements.get(table["id"])) is not None:
        fill_table(frame, spec.table)
        targets["table"] = table["bbox"]

    filled: set[str] = set()
    use_body = bool(content.body) and not kept
    for slot in pattern["slots"]:
        element = elements.get(slot["id"])
        if element is None or slot["id"] in handled:
            continue
        role = slot["role"]
        if role == "body" and use_body and "body" not in filled:
            set_text(element, content.body)
            targets["quote" if spec.kind == "quote" else "bullets"] = slot["bbox"]
            filled.add("body")
        elif role == "subtitle" and content.subtitle and "subtitle" not in filled:
            set_text(element, [content.subtitle])
            targets["subtitle"] = slot["bbox"]
            filled.add("subtitle")
        elif role == "decor_text" and NUMBERING_RX.match(slot["sample"]):
            continue  # номера пунктов — часть оформления
        else:
            # Текст примера без содержимого (заглушки, подписи, места под картинки) — вместе с плашкой.
            drop(elements, slot)

    if pattern["images"]:
        targets["image"] = pattern["images"][0]["bbox"]
    if spec.notes:
        slide.notes_slide.notes_text_frame.text = spec.notes
    return targets
