"""Оформление текста из редактора: шрифт, масштаб кегля, цвет, жирность и выравнивание по адресу поля.

Адрес поля — как в редакторе и аудите: title, subtitle, bullets.2, columns.1.title, columns.1.bullets.0,
kpis.0.value, kpis.0.label, timeline.2.date|title|text, quote.text, quote.author, table.columns.1,
table.rows.0.2, chart.caption. Оформление применяется к абзацу OOXML (<a:p>) поверх стиля шаблона, поэтому
одна функция работает и для клонов слайдов-примеров (pattern_fill), и для слайдов на макете (pptx_export).
"""

from dataclasses import dataclass

from lxml import etree
from pptx.oxml.ns import qn

from app.schemas.slide import Slide

ALIGN = {"left": "l", "center": "ctr", "right": "r", "justify": "just"}
MIN_SZ = 600  # 6 pt в сотых долях пункта
FILL_TAGS = {qn("a:noFill"), qn("a:solidFill"), qn("a:gradFill"), qn("a:blipFill"), qn("a:pattFill"), qn("a:grpFill")}
# Элементы a:rPr, которые по схеме идут после шрифта: latin вставляется перед ними.
AFTER_LATIN = [qn("a:ea"), qn("a:cs"), qn("a:sym"), qn("a:hlinkClick"), qn("a:hlinkMouseOver"), qn("a:rtl"), qn("a:extLst")]
# ...и после заливки: заливка вставляется перед ними.
AFTER_FILL = [qn("a:effectLst"), qn("a:effectDag"), qn("a:highlight"), qn("a:uLnTx"), qn("a:uLn"), qn("a:uFillTx"), qn("a:uFill"), qn("a:latin"), *AFTER_LATIN]


@dataclass(frozen=True)
class TextStyle:
    font: str | None = None
    scale: float = 1.0
    color: str | None = None
    bold: bool | None = None
    align: str | None = None  # left | center | right | justify

    @property
    def empty(self) -> bool:
        return not self.font and self.scale == 1.0 and not self.color and self.bold is None and not self.align


def style_for(spec: Slide, field: str, *, slide_defaults: bool = True) -> TextStyle:
    """Оформление поля: своё значение поля, иначе — шрифт и цвет всего слайда (slide_defaults)."""
    fonts = spec.element_fonts or {}
    colors = spec.element_colors or {}
    bolds = spec.element_bolds or {}
    aligns = getattr(spec, "element_aligns", None) or {}
    scale = (spec.element_scales or {}).get(field) or 1.0
    return TextStyle(
        font=fonts.get(field) or (spec.font_family if slide_defaults else None),
        scale=float(scale),
        color=colors.get(field) or (spec.text_color if slide_defaults else None),
        bold=bolds.get(field),
        align=aligns.get(field),
    )


def _insert_before(parent, element, followers: list[str]) -> None:
    anchor = next((child for child in parent if child.tag in followers), None)
    if anchor is not None:
        anchor.addprevious(element)
    else:
        parent.append(element)


def _run_props(run):
    props = run.find(qn("a:rPr"))
    if props is None:
        props = etree.Element(qn("a:rPr"))
        run.insert(0, props)
    return props


def style_paragraph(paragraph, style: TextStyle, *, base_size_pt: float | None = None, scale: bool = True) -> None:
    """Применяет оформление к абзацу <a:p>. base_size_pt — кегль слота, если у прогона свой не задан;
    scale=False — кегль уже посчитан вызывающим (кегль × масштаб)."""
    if style.empty:
        return
    if style.align in ALIGN:
        props = paragraph.find(qn("a:pPr"))
        if props is None:
            props = etree.Element(qn("a:pPr"))
            paragraph.insert(0, props)
        props.set("algn", ALIGN[style.align])
    for run in paragraph.findall(qn("a:r")):
        props = _run_props(run)
        if scale and style.scale != 1.0:
            size = props.get("sz")
            base = int(size) if size and size.isdigit() else int(base_size_pt * 100) if base_size_pt else None
            if base:
                props.set("sz", str(max(int(base * style.scale), MIN_SZ)))
        if style.bold is not None:
            props.set("b", "1" if style.bold else "0")
        if style.color:
            for child in list(props):
                if child.tag in FILL_TAGS:
                    props.remove(child)
            fill = etree.Element(qn("a:solidFill"))
            etree.SubElement(fill, qn("a:srgbClr")).set("val", style.color.lstrip("#").upper()[:6])
            _insert_before(props, fill, AFTER_FILL)
        if style.font:
            for tag in ("a:latin", "a:cs"):
                old = props.find(qn(tag))
                if old is not None:
                    props.remove(old)
            latin = etree.Element(qn("a:latin"))
            latin.set("typeface", style.font)
            _insert_before(props, latin, AFTER_LATIN)
            cs = etree.Element(qn("a:cs"))
            cs.set("typeface", style.font)
            _insert_before(props, cs, [qn("a:sym"), qn("a:hlinkClick"), qn("a:hlinkMouseOver"), qn("a:rtl"), qn("a:extLst")])


def style_body(body, styles: list[TextStyle | None], *, base_size_pt: float | None = None, scale: bool = True) -> None:
    """Оформление абзацев txBody по порядку: styles[i] — для i-го абзаца (None — не трогать)."""
    if body is None:
        return
    for paragraph, style in zip(body.findall(qn("a:p")), styles):
        if style is not None:
            style_paragraph(paragraph, style, base_size_pt=base_size_pt, scale=scale)
