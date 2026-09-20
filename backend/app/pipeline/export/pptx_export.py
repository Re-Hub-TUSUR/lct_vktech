"""Экспорт в .pptx нативными объектами на основе исходного шаблона.

Берём сам файл шаблона (мастера, макеты, тема, шрифты) и собираем новые слайды.
Слайд с паттерном — клон слайда-примера шаблона с заполненными слотами
(pattern_fill.py): карточки, KPI, таймлайны и таблицы выглядят как в шаблоне.
Остальные — на макете шаблона: заголовки и тезисы в плейсхолдеры или текстовые
поля, данные в нативные диаграммы, таблицы и фигуры. В конце слайды-примеры
удаляются. Растровых слайдов нет.
"""

import math
from dataclasses import dataclass, field, replace
from io import BytesIO
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE, MSO_SHAPE_TYPE, PP_PLACEHOLDER
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

from app.pipeline.export.pattern_fill import clone_slide, fill_pattern
from app.pipeline.geometry import content_frame
from app.pipeline.layout.matcher import fits
from app.pipeline.parsing.template_parser import extract_theme, layout_background
from app.pipeline.theme import mix, text_on
from app.schemas.slide import Slide

TITLE_TYPES = {PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE}
BODY_TYPES = {PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT, PP_PLACEHOLDER.SUBTITLE}
REFERENCE_WIDTH = 12192000  # 13,333" — ширина, под которую подобраны кегли
CHART_TYPES = {
    "bar": XL_CHART_TYPE.COLUMN_CLUSTERED,
    "horizontal_bar": XL_CHART_TYPE.BAR_CLUSTERED,
    "line": XL_CHART_TYPE.LINE_MARKERS,
    "pie": XL_CHART_TYPE.PIE,
    "donut": XL_CHART_TYPE.DOUGHNUT,
}


# Рамка элемента в долях слайда: [x, y, w, h]; адреса — как target в проверках аудита.
Targets = dict[str, list[float]]
# Где на слайде стоит содержимое каждого типа (для подсветки аудита на макетном пути).
CONTENT_TARGET = {
    "bullets": "bullets",
    "agenda": "bullets",
    "two_columns": "columns",
    "cards": "columns",
    "chart": "chart",
    "table": "table",
    "kpi": "kpis",
    "timeline": "timeline",
    "quote": "quote",
    "image_text": "bullets",
}


class ExportError(RuntimeError):
    pass


@dataclass
class DeckBuild:
    data: bytes
    # Рамки элементов каждого слайда — для подсветки проблем аудита на рендере.
    targets: list[Targets] = field(default_factory=list)


@dataclass
class _Ctx:
    width: int
    height: int
    theme: dict
    # Цвета текущего слайда: зависят от фона его макета (в тёмных шаблонах текст светлый).
    fg: str = "#000000"
    muted: str = "#737373"
    surface: str = "#E6F1FF"

    @property
    def scale(self) -> float:
        return self.width / REFERENCE_WIDTH

    def pt(self, size: float) -> Pt:
        return Pt(round(size * self.scale, 1))

    def rgb(self, color: str) -> RGBColor:
        return RGBColor.from_string(color.lstrip("#"))


def build_pptx(
    template_path: str | Path, slides: list[Slide], *, roles: dict, theme: dict, patterns: list[dict] | None = None
) -> bytes:
    return build_deck(template_path, slides, roles=roles, theme=theme, patterns=patterns).data


def build_deck(
    template_path: str | Path, slides: list[Slide], *, roles: dict, theme: dict, patterns: list[dict] | None = None
) -> DeckBuild:
    prs = Presentation(str(template_path))
    # Слайды-примеры нужны как источники паттернов до конца сборки, потом удаляются.
    sources = list(prs.slides)
    by_id = {pattern["id"]: pattern for pattern in patterns or [] if pattern.get("usable")}
    layouts = {
        f"{mi}:{li}": layout
        for mi, master in enumerate(prs.slide_masters)
        for li, layout in enumerate(master.slide_layouts)
    }
    fallback_key = roles.get("content") if roles.get("content") in layouts else next(iter(layouts))
    theme_colors = extract_theme(prs)["colors"]
    ctx = _Ctx(width=int(prs.slide_width), height=int(prs.slide_height), theme=theme)

    targets: list[Targets] = []
    for spec in slides:
        key = spec.layout_key if spec.layout_key in layouts else fallback_key
        layout = layouts[key]
        background = layout_background(layout, theme_colors) or theme["background"]
        fg = text_on(background, theme["text"])
        slide_ctx = replace(
            ctx, fg=fg, muted=mix(fg, background, 0.45), surface=mix(theme["accent"], background, 0.88)
        )
        pattern = by_id.get(spec.pattern_id or "")
        if pattern is not None and pattern["slide_index"] < len(sources) and fits(spec, pattern):
            slide = clone_slide(prs, sources[pattern["slide_index"]])
            targets.append(fill_pattern(slide, pattern, spec))
            _shapes(slide, spec.shapes, slide_ctx, pattern_shapes=pattern.get("shapes"))
            continue
        targets.append(_render(prs.slides.add_slide(layout), spec, slide_ctx))
    clear_slides(prs, len(sources))

    buffer = BytesIO()
    prs.save(buffer)
    data = buffer.getvalue()
    _verify(data, expected=len(slides))
    return DeckBuild(data=data, targets=targets)


def clear_slides(prs, count: int | None = None) -> None:
    """Удаляет слайды шаблона (первые count, по умолчанию все), оставляя мастера, макеты и тему."""
    slide_ids = prs.slides._sldIdLst
    for slide_id in list(slide_ids)[:count]:
        prs.part.drop_rel(slide_id.rId)
        slide_ids.remove(slide_id)
    # Разделы (p14:sectionLst) ссылаются на удалённые слайды — PowerPoint предложит «восстановить» файл.
    for section_list in prs.part._element.xpath(".//*[local-name()='sectionLst']"):
        ext = section_list.getparent()
        ext.getparent().remove(ext)


def _verify(data: bytes, *, expected: int) -> None:
    """integrity.file_opens и integrity.raster_slide: файл открывается, слайды не картинки."""
    try:
        prs = Presentation(BytesIO(data))
    except Exception as exc:  # noqa: BLE001
        raise ExportError(f"Собранный .pptx не открывается: {exc}") from exc
    if len(prs.slides) != expected:
        raise ExportError(f"В файле {len(prs.slides)} слайдов вместо {expected}")
    for number, slide in enumerate(prs.slides, start=1):
        shapes = list(slide.shapes)
        if shapes and all(shape.shape_type == MSO_SHAPE_TYPE.PICTURE for shape in shapes):
            raise ExportError(f"Слайд {number} состоит только из картинки")


# --- отрисовка слайда ------------------------------------------------------------


def _fraction(rect: tuple[int, int, int, int], ctx: _Ctx) -> list[float]:
    x, y, w, h = rect
    return [round(x / ctx.width, 4), round(y / ctx.height, 4), round(w / ctx.width, 4), round(h / ctx.height, 4)]


def _render(slide, spec: Slide, ctx: _Ctx) -> Targets:
    placeholders = list(slide.placeholders)
    title_ph = next((p for p in placeholders if p.placeholder_format.type in TITLE_TYPES), None)
    bodies = sorted(
        (p for p in placeholders if p.placeholder_format.type in BODY_TYPES),
        key=lambda p: p.placeholder_format.idx,
    )
    used: set[int] = set()

    targets: Targets = {}
    if title_ph is not None:
        title_ph.text_frame.text = spec.title
        # Длинный заголовок ужимается в рамку макета, а не наезжает на декор (как автоподбор в PowerPoint).
        title_ph.text_frame.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
        used.add(title_ph.shape_id)
        if None not in (title_ph.left, title_ph.top, title_ph.width, title_ph.height):
            targets["title"] = _fraction((title_ph.left, title_ph.top, title_ph.width, title_ph.height), ctx)
    else:
        rect = (int(ctx.width * 0.06), int(ctx.height * 0.07), int(ctx.width * 0.88), int(ctx.height * 0.14))
        box = slide.shapes.add_textbox(*rect)
        _write(box.text_frame, [spec.title], ctx, size=30, bold=True)
        targets["title"] = _fraction(rect, ctx)

    area = _content_area(title_ph, ctx)
    kind = spec.kind
    if kind in CONTENT_TARGET:
        targets[CONTENT_TARGET[kind]] = _fraction(area, ctx)

    if kind in {"title", "section", "closing"}:
        if spec.subtitle:
            if bodies:
                bodies[0].text_frame.text = spec.subtitle
                used.add(bodies[0].shape_id)
            else:
                x, y, w, _ = area
                box = slide.shapes.add_textbox(x, y, w, int(ctx.height * 0.12))
                _write(box.text_frame, [spec.subtitle], ctx, size=20)
    elif kind in {"bullets", "agenda"}:
        items = spec.bullets
        if kind == "agenda":
            items = [f"{i:02d}   {item}" for i, item in enumerate(items, start=1)]
        _bullets_box(slide, area, items, ctx, bullets=kind == "bullets")
    elif kind == "two_columns":
        _two_columns(slide, spec, area, ctx)
    elif kind == "cards":
        _cards(slide, spec, area, ctx)
    elif kind == "image_text":
        _image_text(slide, spec, area, ctx)
    elif kind == "chart" and spec.chart:
        _chart(slide, spec, area, ctx)
    elif kind == "table" and spec.table:
        _table(slide, spec, area, ctx)
    elif kind == "kpi":
        _kpis(slide, spec, area, ctx)
    elif kind == "timeline":
        _timeline(slide, spec, area, ctx)
    elif kind == "quote" and spec.quote:
        x, y, w, h = area
        box = slide.shapes.add_textbox(x, y, w, h)
        _write(box.text_frame, [f"«{spec.quote.text}»"], ctx, size=30, italic=True)
        if spec.quote.author:
            paragraph = box.text_frame.add_paragraph()
            _run(paragraph, f"— {spec.quote.author}", ctx, size=16, color=ctx.muted)

    if spec.notes:
        slide.notes_slide.notes_text_frame.text = spec.notes

    if spec.shapes:
        _shapes(slide, spec.shapes, ctx)

    # Пустые плейсхолдеры макета показывают подсказки «Введите текст» — убираем их.
    for placeholder in list(slide.placeholders):
        if placeholder.shape_id not in used:
            placeholder._element.getparent().remove(placeholder._element)
    return targets


def _content_area(title_ph, ctx: _Ctx) -> tuple[int, int, int, int]:
    title = None
    if title_ph is not None and None not in (title_ph.left, title_ph.top, title_ph.width, title_ph.height):
        title = (int(title_ph.left), int(title_ph.top), int(title_ph.width), int(title_ph.height))
    return content_frame(title, ctx.width, ctx.height)


def _run(
    paragraph,
    text: str,
    ctx: _Ctx,
    *,
    size: float,
    bold=False,
    italic=False,
    color: str | None = None,
    styled: bool = False,
):
    """styled=True — цвет текста задаёт стиль объекта (таблицы), а не фон слайда."""
    run = paragraph.add_run()
    run.text = text
    run.font.size = ctx.pt(size)
    run.font.bold = bold
    run.font.italic = italic
    if not styled:
        run.font.color.rgb = ctx.rgb(color or ctx.fg)
    return run


def _write(text_frame, lines: list[str], ctx: _Ctx, *, size: float, bold=False, italic=False, color=None):
    text_frame.word_wrap = True
    for i, line in enumerate(lines):
        paragraph = text_frame.paragraphs[0] if i == 0 else text_frame.add_paragraph()
        _run(paragraph, line, ctx, size=size, bold=bold, italic=italic, color=color)


def _set_bullet(paragraph, ctx: _Ctx) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    indent = int(Pt(18 * ctx.scale))
    p_pr.set("marL", str(indent))
    p_pr.set("indent", str(-indent))
    # Порядок дочерних элементов a:pPr задан схемой: spcBef → buClr → buChar.
    spacing = etree.SubElement(p_pr, qn("a:spcBef"))
    etree.SubElement(spacing, qn("a:spcPts")).set("val", str(int(900 * ctx.scale)))
    bullet_color = etree.SubElement(p_pr, qn("a:buClr"))
    etree.SubElement(bullet_color, qn("a:srgbClr")).set("val", ctx.theme["accent"].lstrip("#"))
    etree.SubElement(p_pr, qn("a:buChar")).set("char", "•")


def _bullets_box(slide, area, items: list[str], ctx: _Ctx, *, bullets: bool = True, size: float = 20) -> None:
    if not items:
        return
    x, y, w, h = area
    box = slide.shapes.add_textbox(x, y, w, h)
    frame = box.text_frame
    frame.word_wrap = True
    for i, item in enumerate(items):
        paragraph = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        if bullets:
            _set_bullet(paragraph, ctx)
        _run(paragraph, item, ctx, size=size)


def _two_columns(slide, spec: Slide, area, ctx: _Ctx) -> None:
    x, y, w, h = area
    gap = int(w * 0.05)
    column_width = (w - gap) // 2
    for i, column in enumerate(spec.columns[:2]):
        left = x + i * (column_width + gap)
        header = slide.shapes.add_textbox(left, y, column_width, int(h * 0.16))
        _write(header.text_frame, [column.title], ctx, size=22, bold=True, color=ctx.theme["accent"])
        _bullets_box(slide, (left, y + int(h * 0.18), column_width, int(h * 0.82)), column.bullets, ctx, size=18)


def _cards(slide, spec: Slide, area, ctx: _Ctx) -> None:
    """Сетка карточек: заголовок акцентным цветом и короткий текст на подложке."""
    if not spec.columns:
        return
    x, y, w, h = area
    count = len(spec.columns)
    per_row = count if count <= 4 else math.ceil(count / 2)
    rows = math.ceil(count / per_row)
    gap = int(w * 0.025)
    card_width = (w - gap * (per_row - 1)) // per_row
    card_height = min((h - gap * (rows - 1)) // rows, int(ctx.height * 0.36))
    for i, card_spec in enumerate(spec.columns):
        row, col = divmod(i, per_row)
        card = slide.shapes.add_shape(
            MSO_SHAPE.ROUNDED_RECTANGLE,
            x + col * (card_width + gap),
            y + row * (card_height + gap),
            card_width,
            card_height,
        )
        card.adjustments[0] = 0.08
        card.fill.solid()
        card.fill.fore_color.rgb = ctx.rgb(ctx.surface)
        card.line.fill.background()
        frame = card.text_frame
        frame.word_wrap = True
        frame.vertical_anchor = MSO_ANCHOR.TOP
        _run(frame.paragraphs[0], card_spec.title, ctx, size=20, bold=True, color=ctx.theme["accent"])
        for bullet in card_spec.bullets:
            paragraph = frame.add_paragraph()
            paragraph.space_before = Pt(6 * ctx.scale)
            _run(paragraph, bullet, ctx, size=15)
        for paragraph in frame.paragraphs:
            paragraph.alignment = PP_ALIGN.LEFT


def _image_text(slide, spec: Slide, area, ctx: _Ctx) -> None:
    x, y, w, h = area
    text_width = int(w * 0.52)
    _bullets_box(slide, (x, y, text_width, h), spec.bullets, ctx, size=18)
    left = x + int(w * 0.57)
    frame = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, y, x + w - left, h)
    frame.fill.solid()
    frame.fill.fore_color.rgb = ctx.rgb(ctx.surface)
    frame.line.fill.background()
    text = frame.text_frame
    text.word_wrap = True
    text.vertical_anchor = MSO_ANCHOR.MIDDLE
    prompt = spec.image.prompt if spec.image else "Иллюстрация"
    _write(text, ["Изображение будет сгенерировано", prompt], ctx, size=12, color=ctx.muted)
    for paragraph in text.paragraphs:
        paragraph.alignment = PP_ALIGN.CENTER


def _chart(slide, spec: Slide, area, ctx: _Ctx) -> None:
    chart_spec = spec.chart
    x, y, w, h = area
    if chart_spec.caption:
        caption = slide.shapes.add_textbox(x, y, w, int(h * 0.1))
        _write(caption.text_frame, [chart_spec.caption], ctx, size=14, color=ctx.muted)
        y, h = y + int(h * 0.11), int(h * 0.89)

    data = CategoryChartData()
    data.categories = chart_spec.categories
    for series in chart_spec.series:
        data.add_series(series.name or "Серия", series.values)
    graphic = slide.shapes.add_chart(CHART_TYPES[chart_spec.type], x, y, w, h, data)
    chart = graphic.chart
    chart.has_title = False  # подпись диаграммы — отдельным текстом над ней
    chart.font.size = ctx.pt(14)
    chart.font.color.rgb = ctx.rgb(ctx.fg)
    if chart_spec.show_legend is not None:
        chart.has_legend = chart_spec.show_legend
    else:
        chart.has_legend = len(chart_spec.series) > 1 or chart_spec.type in ("pie", "donut")
    if chart.has_legend:
        chart.legend.position = XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False

    plot = chart.plots[0]
    plot.has_data_labels = chart_spec.show_values if chart_spec.show_values is not None else True
    plot.data_labels.font.size = ctx.pt(12)
    accents = chart_spec.colors if chart_spec.colors else ctx.theme["accents"]
    if chart_spec.type in ("pie", "donut"):
        for i, point in enumerate(plot.series[0].points):
            point.format.fill.solid()
            point.format.fill.fore_color.rgb = ctx.rgb(accents[i % len(accents)])
        return

    if chart_spec.unit:
        chart.value_axis.has_title = True
        chart.value_axis.axis_title.text_frame.text = chart_spec.unit
    for i, series in enumerate(plot.series):
        color = ctx.rgb(accents[i % len(accents)])
        if chart_spec.type == "line":
            series.format.line.color.rgb = color
            series.format.line.width = Pt(2.5)
            series.smooth = False
        else:
            series.format.fill.solid()
            series.format.fill.fore_color.rgb = color


def _table(slide, spec: Slide, area, ctx: _Ctx) -> None:
    table_spec = spec.table
    x, y, w, h = area
    columns = max(len(table_spec.columns), max((len(r) for r in table_spec.rows), default=1))
    rows = len(table_spec.rows) + 1
    row_height = min(h // rows, int(Pt(40 * ctx.scale)))
    table = slide.shapes.add_table(rows, columns, x, y, w, row_height * rows).table
    cells = [table_spec.columns, *table_spec.rows]
    for r, row in enumerate(cells):
        for c in range(columns):
            cell = table.cell(r, c)
            cell.text = ""
            text = row[c] if c < len(row) else ""
            _run(cell.text_frame.paragraphs[0], text, ctx, size=14, bold=r == 0, styled=True)


def _kpis(slide, spec: Slide, area, ctx: _Ctx) -> None:
    if not spec.kpis:
        return
    x, y, w, h = area
    count = len(spec.kpis)
    gap = int(w * 0.03)
    card_width = (w - gap * (count - 1)) // count
    card_height = min(h, int(ctx.height * 0.4))
    for i, kpi in enumerate(spec.kpis):
        card = slide.shapes.add_shape(
            MSO_SHAPE.ROUNDED_RECTANGLE, x + i * (card_width + gap), y, card_width, card_height
        )
        card.fill.solid()
        card.fill.fore_color.rgb = ctx.rgb(ctx.surface)
        card.line.fill.background()
        frame = card.text_frame
        frame.word_wrap = True
        frame.vertical_anchor = MSO_ANCHOR.MIDDLE
        _run(frame.paragraphs[0], kpi.value, ctx, size=44, bold=True, color=ctx.theme["accent"])
        label = frame.add_paragraph()
        _run(label, kpi.label, ctx, size=16, color=ctx.fg)
        for paragraph in frame.paragraphs:
            paragraph.alignment = PP_ALIGN.LEFT


def _timeline(slide, spec: Slide, area, ctx: _Ctx) -> None:
    if not spec.timeline:
        return
    x, y, w, h = area
    count = len(spec.timeline)
    line_y = y + int(h * 0.12)
    line = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, x, line_y, x + w, line_y)
    line.line.color.rgb = ctx.rgb(ctx.theme["accent"])
    line.line.width = Pt(2)
    step = w // count
    dot = int(Emu(Pt(16 * ctx.scale)))
    for i, item in enumerate(spec.timeline):
        left = x + i * step
        marker = slide.shapes.add_shape(MSO_SHAPE.OVAL, left, line_y - dot // 2, dot, dot)
        marker.fill.solid()
        marker.fill.fore_color.rgb = ctx.rgb(ctx.theme["accent"])
        marker.line.fill.background()
        box = slide.shapes.add_textbox(left, line_y + dot, step - int(w * 0.02), int(h * 0.7))
        frame = box.text_frame
        frame.word_wrap = True
        _run(frame.paragraphs[0], item.date, ctx, size=14, bold=True, color=ctx.theme["accent"])
        _run(frame.add_paragraph(), item.title, ctx, size=18, bold=True)
        if item.text:
            _run(frame.add_paragraph(), item.text, ctx, size=14, color=ctx.muted)


def _shapes(slide, shapes: list, ctx: _Ctx, pattern_shapes: list | None = None) -> None:
    existing = {s.shape_id: s for s in slide.shapes}
    pattern_shapes = pattern_shapes or []

    # Если шаблонные фигуры были удалены пользователем из spec.shapes:
    if pattern_shapes:
        kept_tpl_ids = {
            getattr(s, "template_shape_id", None) or (s.get("template_shape_id") if isinstance(s, dict) else None)
            for s in (shapes or [])
        }
        for ps in pattern_shapes:
            pid = ps.get("template_shape_id")
            if pid and pid not in kept_tpl_ids and pid in existing:
                try:
                    el = existing[pid]._element
                    if el.getparent() is not None:
                        el.getparent().remove(el)
                except Exception:
                    pass

    if not shapes:
        return

    for s in shapes:
        kind = getattr(s, "kind", "circle") if not isinstance(s, dict) else s.get("kind", "circle")
        x = getattr(s, "x", 0.5) if not isinstance(s, dict) else s.get("x", 0.5)
        y = getattr(s, "y", 0.5) if not isinstance(s, dict) else s.get("y", 0.5)
        w = getattr(s, "width", 0.15) if not isinstance(s, dict) else s.get("width", 0.15)
        h = getattr(s, "height", 0.15) if not isinstance(s, dict) else s.get("height", 0.15)
        color = getattr(s, "color", None) if not isinstance(s, dict) else s.get("color")
        text = getattr(s, "text", None) if not isinstance(s, dict) else s.get("text")
        border = getattr(s, "border", False) if not isinstance(s, dict) else s.get("border", False)
        tpl_id = getattr(s, "template_shape_id", None) if not isinstance(s, dict) else s.get("template_shape_id")

        left = int(x * ctx.width)
        top = int(y * ctx.height)
        width = int(w * ctx.width)
        height = int(h * ctx.height)

        fill_color = color or ctx.theme.get("accent", "#0077FF")

        # Если это существующая фигура шаблона на клонированном слайде:
        if tpl_id and tpl_id in existing:
            sp = existing[tpl_id]
            sp.left = left
            sp.top = top
            sp.width = width
            sp.height = height
            if color:
                try:
                    sp.fill.solid()
                    sp.fill.fore_color.rgb = ctx.rgb(fill_color)
                except Exception:
                    pass
            if text and sp.has_text_frame:
                sp.text_frame.text = text
            continue

        if kind == "circle":
            sp = slide.shapes.add_shape(MSO_SHAPE.OVAL, left, top, width, height)
        elif kind == "line":
            sp = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, left, top, left + width, top)
            sp.line.color.rgb = ctx.rgb(fill_color)
            sp.line.width = Pt(3)
            continue
        elif kind in ("badge", "pill", "rect"):
            sp = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
            if kind in ("badge", "pill"):
                sp.adjustments[0] = 0.5
            else:
                sp.adjustments[0] = 0.08
        else:
            sp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)

        sp.fill.solid()
        sp.fill.fore_color.rgb = ctx.rgb(fill_color)
        if border:
            sp.line.color.rgb = ctx.rgb(ctx.fg)
            sp.line.width = Pt(1.5)
        else:
            sp.line.fill.background()

        if text:
            tf = sp.text_frame
            tf.word_wrap = True
            tf.vertical_anchor = MSO_ANCHOR.MIDDLE
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER
            _run(
                p,
                text,
                ctx,
                size=14,
                bold=True,
                color="#FFFFFF" if text_on(fill_color, "#FFFFFF") == "#FFFFFF" else "#000000",
            )

