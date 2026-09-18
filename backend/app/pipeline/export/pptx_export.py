"""Экспорт в .pptx нативными объектами на макетах исходного шаблона.

Берём сам файл шаблона (мастера, макеты, тема, шрифты), удаляем его слайды
и собираем новые: заголовки и тезисы — в плейсхолдеры макета или текстовые
поля, данные — в нативные диаграммы, таблицы и фигуры. Растровых слайдов нет.

Геометрия пока простая: область контента под заголовком макета. Точную
раскладку по сетке шаблона сделает слой вёрстки.
"""

from dataclasses import dataclass, replace
from io import BytesIO
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE, MSO_SHAPE_TYPE, PP_PLACEHOLDER
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

from app.pipeline.parsing.template_parser import extract_theme, layout_background
from app.pipeline.theme import mix, text_on
from app.schemas.slide import Slide

TITLE_TYPES = {PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE}
BODY_TYPES = {PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT, PP_PLACEHOLDER.SUBTITLE}
REFERENCE_WIDTH = 12192000  # 13,333" — ширина, под которую подобраны кегли
CHART_TYPES = {
    "bar": XL_CHART_TYPE.COLUMN_CLUSTERED,
    "line": XL_CHART_TYPE.LINE_MARKERS,
    "pie": XL_CHART_TYPE.PIE,
}


class ExportError(RuntimeError):
    pass


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


def build_pptx(template_path: str | Path, slides: list[Slide], *, roles: dict, theme: dict) -> bytes:
    prs = Presentation(str(template_path))
    _drop_slides(prs)
    layouts = {
        f"{mi}:{li}": layout
        for mi, master in enumerate(prs.slide_masters)
        for li, layout in enumerate(master.slide_layouts)
    }
    fallback_key = roles.get("content") if roles.get("content") in layouts else next(iter(layouts))
    theme_colors = extract_theme(prs)["colors"]
    ctx = _Ctx(width=int(prs.slide_width), height=int(prs.slide_height), theme=theme)

    for spec in slides:
        key = spec.layout_key if spec.layout_key in layouts else fallback_key
        layout = layouts[key]
        background = layout_background(layout, theme_colors) or theme["background"]
        fg = text_on(background, theme["text"])
        slide_ctx = replace(
            ctx, fg=fg, muted=mix(fg, background, 0.45), surface=mix(theme["accent"], background, 0.88)
        )
        _render(prs.slides.add_slide(layout), spec, slide_ctx)

    buffer = BytesIO()
    prs.save(buffer)
    data = buffer.getvalue()
    _verify(data, expected=len(slides))
    return data


def _drop_slides(prs) -> None:
    slide_ids = prs.slides._sldIdLst
    for slide_id in list(slide_ids):
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


def _render(slide, spec: Slide, ctx: _Ctx) -> None:
    placeholders = list(slide.placeholders)
    title_ph = next((p for p in placeholders if p.placeholder_format.type in TITLE_TYPES), None)
    bodies = sorted(
        (p for p in placeholders if p.placeholder_format.type in BODY_TYPES),
        key=lambda p: p.placeholder_format.idx,
    )
    used: set[int] = set()

    if title_ph is not None:
        title_ph.text_frame.text = spec.title
        used.add(title_ph.shape_id)
    else:
        box = slide.shapes.add_textbox(
            int(ctx.width * 0.06), int(ctx.height * 0.07), int(ctx.width * 0.88), int(ctx.height * 0.14)
        )
        _write(box.text_frame, [spec.title], ctx, size=30, bold=True)

    area = _content_area(title_ph, ctx)
    kind = spec.kind

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

    # Пустые плейсхолдеры макета показывают подсказки «Введите текст» — убираем их.
    for placeholder in list(slide.placeholders):
        if placeholder.shape_id not in used:
            placeholder._element.getparent().remove(placeholder._element)


def _content_area(title_ph, ctx: _Ctx) -> tuple[int, int, int, int]:
    width, height = ctx.width, ctx.height
    margin = int(width * 0.06)
    top = int(height * 0.24)
    if title_ph is not None and None not in (title_ph.left, title_ph.top, title_ph.height):
        margin = max(int(title_ph.left), int(width * 0.03))
        top = int(title_ph.top + title_ph.height + height * 0.06)
        if top > height * 0.5:
            top = int(height * 0.26)
    bottom = int(height * 0.9)
    return margin, top, width - 2 * margin, max(bottom - top, int(height * 0.3))


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
    chart.has_legend = len(chart_spec.series) > 1 or chart_spec.type == "pie"
    if chart.has_legend:
        chart.legend.position = XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False

    plot = chart.plots[0]
    plot.has_data_labels = True
    plot.data_labels.font.size = ctx.pt(12)
    accents = ctx.theme["accents"]
    if chart_spec.type == "pie":
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
