"""Экспорт в .pptx нативными объектами на основе исходного шаблона.

Берём сам файл шаблона (мастера, макеты, тема, шрифты) и собираем новые слайды.
Слайд с паттерном — клон слайда-примера шаблона с заполненными слотами
(pattern_fill.py): карточки, KPI, таймлайны и таблицы выглядят как в шаблоне.
Остальные — на макете шаблона: заголовки и тезисы в плейсхолдеры или текстовые
поля, данные в нативные диаграммы, таблицы и фигуры. В конце слайды-примеры
удаляются. Растровых слайдов нет.

Токены дизайн-системы шаблона (theme["design"], см. parsing/design_tokens.py): новые
таблицы берут стиль таблиц шаблона, диаграммы — цвета его рядов, текст на макетах —
кегли из типографики; номер слайда и колонтитул переносятся, если их ставит шаблон.
"""

import copy
import logging
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

from app.core.storage import storage_path
from app.pipeline.export.pattern_fill import clone_slide, fill_pattern, remove, set_body
from app.pipeline.geometry import content_frame
from app.pipeline.parsing.layout_patterns import PH_BASE
from app.pipeline.parsing.template_parser import extract_theme, layout_background
from app.pipeline.theme import mix, text_on
from app.schemas.slide import Slide

logger = logging.getLogger(__name__)

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
    font_family: str | None = None

    @property
    def scale(self) -> float:
        return self.width / REFERENCE_WIDTH

    def pt(self, size: float) -> Pt:
        return Pt(round(size * self.scale, 1))

    @property
    def design(self) -> dict:
        return self.theme.get("design") or {}

    def absolute(self, size_pt: float | None, fallback: float) -> float:
        """Кегль шаблона (в пунктах его слайда) в масштабе _run/pt; без токена — запасной кегль."""
        return size_pt / self.scale if size_pt else fallback

    def role_size(self, role: str, fallback: float) -> float:
        """Кегль роли текста из типографики шаблона (title, body, body_2, caption…)."""
        typography = self.design.get("typography") or {}
        return self.absolute((typography.get(role) or {}).get("size_pt"), fallback)

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
    by_id = {pattern["id"]: pattern for pattern in patterns or []}
    layouts = {
        f"{mi}:{li}": layout
        for mi, master in enumerate(prs.slide_masters)
        for li, layout in enumerate(master.slide_layouts)
    }
    fallback_key = roles.get("content") if roles.get("content") in layouts else next(iter(layouts))
    theme_colors = extract_theme(prs)["colors"]
    ctx = _Ctx(width=int(prs.slide_width), height=int(prs.slide_height), theme=theme)

    chrome = ctx.design.get("chrome") or {}
    # Ряды диаграмм — цветами диаграмм шаблона, если они есть, иначе акцентами темы.
    chart_colors = (ctx.design.get("chart_style") or {}).get("series_colors") or theme["accents"]
    targets: list[Targets] = []
    for spec in slides:
        key = spec.layout_key if spec.layout_key in layouts else fallback_key
        layout = layouts[key]
        background = layout_background(layout, theme_colors) or theme["background"]
        fg = text_on(background, theme["text"])
        slide_ctx = replace(
            ctx,
            fg=fg,
            muted=mix(fg, background, 0.45),
            surface=mix(theme["accent"], background, 0.88),
            font_family=spec.font_family,
        )
        pattern = by_id.get(spec.pattern_id or "")
        if pattern is not None:
            count_before = len(prs.slides)
            try:
                targets.append(_pattern_slide(prs, pattern, spec, sources, layouts, slide_ctx, chart_colors, chrome))
                continue
            except Exception:  # noqa: BLE001 — сборка по паттерну не удалась: слайд собирается на макете
                logger.exception("Паттерн %s не собрался для слайда %s", pattern.get("id"), spec.id)
                _drop_slides_after(prs, count_before)
        slide = prs.slides.add_slide(layout)
        targets.append(_render(slide, spec, slide_ctx))
        _add_chrome(slide, layout, chrome)
    clear_slides(prs, len(sources))

    buffer = BytesIO()
    prs.save(buffer)
    data = buffer.getvalue()
    _verify(data, expected=len(slides))
    return DeckBuild(data=data, targets=targets)


def _user_image(spec: Slide) -> Path | None:
    if not spec.image or not spec.image.url:
        return None
    path = storage_path("user_images", Path(spec.image.url).name)
    return path if path.exists() else None


def _place_image(slide, pattern: dict, spec: Slide, ctx: _Ctx) -> None:
    """Картинка слайда: в плейсхолдер картинки макета или на место картинки слайда-примера."""
    path = _user_image(spec) if spec.kind == "image_text" else None
    placeholders = [image for image in pattern.get("images") or [] if image.get("placeholder")]
    if placeholders:
        idx = placeholders[0]["id"] - PH_BASE
        holder = next((ph for ph in slide.placeholders if ph.placeholder_format.idx == idx), None)
        if holder is not None:
            if path is not None and hasattr(holder, "insert_picture"):
                holder.insert_picture(str(path))
            else:
                remove(holder._element)
        return
    if path is None:
        return
    x, y, w, h = pattern["images"][0]["bbox"] if pattern.get("images") else [0.55, 0.25, 0.38, 0.55]
    slide.shapes.add_picture(str(path), int(x * ctx.width), int(y * ctx.height), int(w * ctx.width), int(h * ctx.height))


def _pattern_slide(prs, pattern: dict, spec: Slide, sources, layouts, ctx: _Ctx, chart_colors, chrome) -> Targets:
    """Слайд по паттерну: клон слайда-примера или новый слайд на макете паттерна (origin=layout)."""
    if pattern.get("origin") == "layout":
        layout = layouts.get(pattern.get("layout_key") or "")
        if layout is None:
            raise ExportError(f"Макет паттерна {pattern['id']} не найден")
        slide = prs.slides.add_slide(layout)
        slide_targets = fill_pattern(slide, pattern, spec, accents=chart_colors)
        _add_chrome(slide, layout, chrome)
    else:
        index = pattern.get("slide_index", -1)
        if not 0 <= index < len(sources):
            raise ExportError(f"Слайд-пример паттерна {pattern['id']} не найден")
        slide = clone_slide(prs, sources[index])
        slide_targets = fill_pattern(slide, pattern, spec, accents=chart_colors)
    _place_image(slide, pattern, spec, ctx)
    _shapes(slide, spec.shapes, ctx, pattern_shapes=pattern.get("shapes"))
    return slide_targets


def _drop_slides_after(prs, count: int) -> None:
    """Убирает недособранные слайды (добавленные после count), чтобы не было дублей."""
    slide_ids = prs.slides._sldIdLst
    for slide_id in list(slide_ids)[count:]:
        prs.part.drop_rel(slide_id.rId)
        slide_ids.remove(slide_id)


def _add_chrome(slide, layout, chrome: dict) -> None:
    """Номер слайда и колонтитул с макета: python-pptx их не копирует, а шаблон их ставит."""
    wanted = set()
    if chrome.get("slide_number"):
        wanted.add(PP_PLACEHOLDER.SLIDE_NUMBER)
    if chrome.get("footer_text"):
        wanted.add(PP_PLACEHOLDER.FOOTER)
    if not wanted:
        return
    present = {ph.placeholder_format.type for ph in slide.placeholders}
    tree = slide.shapes._spTree
    next_id = max((int(el.get("id", "0")) for el in slide._element.iter(qn("p:cNvPr"))), default=1) + 1
    for ph in layout.placeholders:
        kind = ph.placeholder_format.type
        if kind not in wanted or kind in present:
            continue
        element = copy.deepcopy(ph._element)
        c_nv_pr = element.find(f"{qn('p:nvSpPr')}/{qn('p:cNvPr')}")
        if c_nv_pr is not None:
            c_nv_pr.set("id", str(next_id))
            next_id += 1
        if kind == PP_PLACEHOLDER.FOOTER:
            set_body(element.find(qn("p:txBody")), [chrome["footer_text"]], autofit=False)
        tree.append(element)
        present.add(kind)


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
    elem_fonts = getattr(spec, "element_fonts", {}) or {}
    elem_scales = getattr(spec, "element_scales", {}) or {}
    title_font = elem_fonts.get("title") or spec.font_family
    title_scale = elem_scales.get("title", 1.0)
    if title_ph is not None:
        title_ph.text_frame.text = spec.title
        # Длинный заголовок ужимается в рамку макета, а не наезжает на декор (как автоподбор в PowerPoint).
        title_ph.text_frame.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
        used.add(title_ph.shape_id)
        if title_font:
            for p in title_ph.text_frame.paragraphs:
                for r in p.runs:
                    r.font.name = title_font
        if None not in (title_ph.left, title_ph.top, title_ph.width, title_ph.height):
            targets["title"] = _fraction((title_ph.left, title_ph.top, title_ph.width, title_ph.height), ctx)
    else:
        rect = (int(ctx.width * 0.06), int(ctx.height * 0.07), int(ctx.width * 0.88), int(ctx.height * 0.14))
        box = slide.shapes.add_textbox(*rect)
        _write(box.text_frame, [spec.title], ctx, size=30 * title_scale, bold=True, font_name=title_font)
        targets["title"] = _fraction(rect, ctx)

    area = _content_area(title_ph, ctx)
    kind = spec.kind
    if kind in CONTENT_TARGET:
        targets[CONTENT_TARGET[kind]] = _fraction(area, ctx)

    sub_font = elem_fonts.get("subtitle") or spec.font_family
    sub_scale = elem_scales.get("subtitle", 1.0)
    if kind in {"title", "section", "closing"}:
        if spec.subtitle:
            if bodies:
                bodies[0].text_frame.text = spec.subtitle
                used.add(bodies[0].shape_id)
                if sub_font:
                    for p in bodies[0].text_frame.paragraphs:
                        for r in p.runs:
                            r.font.name = sub_font
            else:
                x, y, w, _ = area
                box = slide.shapes.add_textbox(x, y, w, int(ctx.height * 0.12))
                _write(box.text_frame, [spec.subtitle], ctx, size=20 * sub_scale, font_name=sub_font)
    elif kind in {"bullets", "agenda"}:
        items = spec.bullets
        if kind == "agenda":
            items = [f"{i:02d}   {item}" for i, item in enumerate(items, start=1)]
        _bullets_box(slide, area, items, ctx, bullets=kind == "bullets", size=ctx.role_size("body", 20))
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
    font_name: str | None = None,
):
    """styled=True — цвет текста задаёт стиль объекта (таблицы), а не фон слайда."""
    run = paragraph.add_run()
    run.text = text
    run.font.size = ctx.pt(size)
    run.font.bold = bold
    run.font.italic = italic
    fn = font_name or ctx.font_family
    if fn:
        run.font.name = fn
    if not styled:
        run.font.color.rgb = ctx.rgb(color or ctx.fg)
    return run


def _write(text_frame, lines: list[str], ctx: _Ctx, *, size: float, bold=False, italic=False, color=None, font_name=None):
    text_frame.word_wrap = True
    for i, line in enumerate(lines):
        paragraph = text_frame.paragraphs[0] if i == 0 else text_frame.add_paragraph()
        _run(paragraph, line, ctx, size=size, bold=bold, italic=italic, color=color, font_name=font_name)


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
    img_width = x + w - left
    img_height = h

    if spec.image and spec.image.url:
        img_name = Path(spec.image.url).name
        try:
            local_path = storage_path("user_images", img_name)
            if local_path.exists():
                slide.shapes.add_picture(str(local_path), left, y, img_width, img_height)
                return
        except Exception:
            pass

    frame = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, y, img_width, img_height)
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
    chart_style = ctx.design.get("chart_style") or {}
    x, y, w, h = area
    if chart_spec.caption:
        caption = slide.shapes.add_textbox(x, y, w, int(h * 0.1))
        _write(caption.text_frame, [chart_spec.caption], ctx, size=ctx.role_size("caption", 14), color=ctx.muted)
        y, h = y + int(h * 0.11), int(h * 0.89)

    data = CategoryChartData()
    data.categories = chart_spec.categories
    for series in chart_spec.series:
        data.add_series(series.name or "Серия", series.values)
    graphic = slide.shapes.add_chart(CHART_TYPES[chart_spec.type], x, y, w, h, data)
    chart = graphic.chart
    chart.has_title = False  # подпись диаграммы — отдельным текстом над ней
    chart.font.size = ctx.pt(ctx.absolute(chart_style.get("font_size_pt"), 14))
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
    accents = chart_spec.colors or chart_style.get("series_colors") or ctx.theme["accents"]
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
    # Стиль таблиц шаблона (tableStyles.xml) вместо стандартного стиля python-pptx.
    style = ctx.design.get("table_style") or {}
    if style.get("style_id"):
        table_props = table._tbl.tblPr
        style_id = table_props.find(qn("a:tableStyleId"))
        if style_id is None:
            style_id = etree.SubElement(table_props, qn("a:tableStyleId"))
        style_id.text = style["style_id"]
        table_props.set("firstRow", "1" if style.get("first_row", True) else "0")
        table_props.set("bandRow", "1" if style.get("band_row", True) else "0")
    size = ctx.absolute(style.get("font_size_pt"), 14)
    cells = [table_spec.columns, *table_spec.rows]
    for r, row in enumerate(cells):
        for c in range(columns):
            cell = table.cell(r, c)
            cell.text = ""
            text = row[c] if c < len(row) else ""
            _run(cell.text_frame.paragraphs[0], text, ctx, size=size, bold=r == 0, styled=True)


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


def _changed(value, original, tolerance: float = 1e-3) -> bool:
    """Правка из редактора: координаты сравниваются с допуском (редактор округляет их до тысячных)."""
    if isinstance(value, (int, float)) and isinstance(original, (int, float)):
        return abs(value - original) > tolerance
    return (value or None) != (original or None)


def _shapes(slide, shapes: list, ctx: _Ctx, pattern_shapes: list | None = None) -> None:
    existing = {s.shape_id: s for s in slide.shapes}
    pattern_shapes = pattern_shapes or []
    # Фигуры слайда-примера в том виде, в каком их разобрал парсер: сравнивая с ними, сборка переносит
    # в клон только правки пользователя. Цвет парсер знает приблизительно (без прозрачности, оттенков
    # темы и карты цветов мастера) — перекрашивать нетронутую фигуру шаблона значит исказить её.
    originals = {ps.get("template_shape_id"): ps for ps in pattern_shapes if ps.get("template_shape_id")}

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

        # Фигура шаблона, которой нет среди фигур слайда верхнего уровня, лежит внутри группы
        # или удалена сборкой вместе с лишней карточкой — пересоздавать её нельзя: будут дубли и «сироты».
        # Фигура чужого слайда-примера (после смены паттерна или на макете) к этому слайду не относится.
        if tpl_id:
            original = originals.get(tpl_id)
            if tpl_id not in existing or original is None:
                continue
            sp = existing[tpl_id]
            if any(_changed(value, original.get(key)) for key, value in (("x", x), ("y", y), ("width", w), ("height", h))):
                sp.left = left
                sp.top = top
                sp.width = width
                sp.height = height
            if color and str(color).upper() != str(original.get("color") or "").upper():
                try:
                    sp.fill.solid()
                    sp.fill.fore_color.rgb = ctx.rgb(fill_color)
                except Exception:
                    pass
            if text and sp.has_text_frame and _changed(text, original.get("text")):
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
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER
            shape_font = getattr(s, "font_family", None) if not isinstance(s, dict) else s.get("font_family")
            _run(
                p,
                text,
                ctx,
                size=14,
                bold=True,
                color="#FFFFFF" if text_on(fill_color, "#FFFFFF") == "#FFFFFF" else "#000000",
                font_name=shape_font,
            )

