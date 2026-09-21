"""Запасной экспорт в .pdf: упрощённая отрисовка слайдов через PyMuPDF.

Основной путь — конвертация собранного .pptx через LibreOffice (export/render.py),
он сохраняет оформление шаблона. Этот рендер рисует только цвета темы и тексты
и используется, лишь когда LibreOffice недоступен (например, локально без Docker).
"""

from html import escape

import pymupdf

from app.pipeline.theme import colors_for
from app.schemas.slide import INVERSE_KINDS, Slide

POINTS_PER_INCH = 72


def _rgb(color: str) -> tuple[float, float, float]:
    value = color.lstrip("#")
    return tuple(int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def _css(theme: dict, fg: str) -> str:
    return f"""
      * {{ font-family: sans-serif; color: {fg}; }}
      h1 {{ font-size: 40px; margin: 0 0 16px 0; }}
      h2 {{ font-size: 28px; margin: 0 0 18px 0; }}
      h3 {{ font-size: 19px; color: {theme["accent"]}; margin: 0 0 8px 0; }}
      p, li, td, th {{ font-size: 17px; line-height: 1.35; }}
      .subtitle {{ font-size: 22px; }}
      .muted {{ color: {theme["muted"]}; font-size: 14px; }}
      .kpi {{ font-size: 40px; font-weight: bold; color: {theme["accent"]}; }}
      th {{ font-weight: bold; color: {theme["accent"]}; text-align: left; }}
      td, th {{ padding: 4px 12px 4px 0; }}
    """


def _list(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{escape(item)}</li>" for item in items) + "</ul>"


def _columns_html(slide: Slide) -> list[str]:
    """Колонки, которые раскладываются по ширине слайда отдельными блоками."""
    if slide.kind in {"two_columns", "cards"}:
        return [f"<h3>{escape(c.title)}</h3>{_list(c.bullets)}" for c in slide.columns]
    if slide.kind == "kpi":
        return [f'<div class="kpi">{escape(k.value)}</div><p>{escape(k.label)}</p>' for k in slide.kpis]
    if slide.kind == "timeline":
        return [
            f'<h3>{escape(i.date)}</h3><p><b>{escape(i.title)}</b></p><p class="muted">{escape(i.text or "")}</p>'
            for i in slide.timeline
        ]
    return []


def _body_html(slide: Slide) -> str:
    kind = slide.kind
    if kind in {"bullets", "agenda"}:
        return _list(slide.bullets)
    if kind == "image_text":
        prompt = escape(slide.image.prompt) if slide.image else ""
        return _list(slide.bullets) + f'<p class="muted">Изображение будет сгенерировано: {prompt}</p>'
    if kind == "table" and slide.table:
        head = "".join(f"<th>{escape(c)}</th>" for c in slide.table.columns)
        rows = "".join("<tr>" + "".join(f"<td>{escape(c)}</td>" for c in row) + "</tr>" for row in slide.table.rows)
        return f"<table><tr>{head}</tr>{rows}</table>"
    if kind == "quote" and slide.quote:
        author = f'<p class="muted">— {escape(slide.quote.author)}</p>' if slide.quote.author else ""
        return f'<p class="subtitle"><i>«{escape(slide.quote.text)}»</i></p>{author}'
    if kind == "chart" and slide.chart and slide.chart.caption:
        return f'<p class="muted">{escape(slide.chart.caption)}</p>'
    return ""


def _draw_bars(page, rect: pymupdf.Rect, slide: Slide, theme: dict) -> None:
    chart = slide.chart
    if chart is None or not chart.series:
        return
    values = [v for s in chart.series for v in s.values] or [0]
    top = max(max(values), 0) or 1
    count = max(len(chart.categories), 1)
    group_w = rect.width / count
    bar_w = group_w * 0.7 / len(chart.series)
    label_h = 22
    plot_h = rect.height - label_h * 2
    base_y = rect.y0 + label_h + plot_h
    for si, series in enumerate(chart.series):
        color = _rgb(theme["accents"][si % len(theme["accents"])])
        for ci, value in enumerate(series.values):
            height = plot_h * max(value, 0) / top
            x = rect.x0 + group_w * ci + group_w * 0.15 + bar_w * si
            page.draw_rect(pymupdf.Rect(x, base_y - height, x + bar_w, base_y), color=None, fill=color)
            page.insert_htmlbox(
                pymupdf.Rect(x - 20, base_y - height - label_h, x + bar_w + 20, base_y - height),
                f'<p style="text-align:center; font-size: 13px">{value:g}</p>',
                css=_css(theme, theme["text"]),
            )
    for ci, category in enumerate(chart.categories):
        x = rect.x0 + group_w * ci
        page.insert_htmlbox(
            pymupdf.Rect(x, base_y + 4, x + group_w, base_y + label_h + 8),
            f'<p style="text-align:center; font-size: 13px">{escape(category)}</p>',
            css=_css(theme, theme["text"]),
        )
    if chart.unit:
        page.insert_htmlbox(
            pymupdf.Rect(rect.x0, rect.y0 - 4, rect.x0 + 200, rect.y0 + label_h),
            f'<p class="muted">{escape(chart.unit)}</p>',
            css=_css(theme, theme["text"]),
        )


def build_simple_pdf(slides: list[Slide], theme: dict, *, width_in: float = 13.333, height_in: float = 7.5) -> bytes:
    width, height = width_in * POINTS_PER_INCH, height_in * POINTS_PER_INCH
    pad = width * 0.06
    doc = pymupdf.open()
    for number, slide in enumerate(slides, start=1):
        page = doc.new_page(width=width, height=height)
        inverse = slide.kind in INVERSE_KINDS
        background, fg = colors_for(theme, slide.kind, slide.layout_key)
        page.draw_rect(page.rect, color=None, fill=_rgb(background))
        css = _css(theme, fg)

        if inverse:
            subtitle = f'<p class="subtitle">{escape(slide.subtitle)}</p>' if slide.subtitle else ""
            page.insert_htmlbox(
                pymupdf.Rect(pad, height * 0.3, width - pad, height - pad),
                f"<h1>{escape(slide.title)}</h1>{subtitle}",
                css=css,
            )
        else:
            title_rect = pymupdf.Rect(pad, pad * 0.8, width - pad, pad * 0.8 + height * 0.16)
            page.insert_htmlbox(title_rect, f"<h2>{escape(slide.title)}</h2>", css=css)
            body_rect = pymupdf.Rect(pad, title_rect.y1 + 8, width - pad, height - pad * 0.8)
            columns = _columns_html(slide)
            if columns:
                gap = width * 0.03
                column_width = (body_rect.width - gap * (len(columns) - 1)) / len(columns)
                for i, html in enumerate(columns):
                    x0 = body_rect.x0 + i * (column_width + gap)
                    page.insert_htmlbox(pymupdf.Rect(x0, body_rect.y0, x0 + column_width, body_rect.y1), html, css=css)
            elif body := _body_html(slide):
                page.insert_htmlbox(body_rect, body, css=css)
            if slide.kind == "chart":
                offset = 28 if slide.chart and slide.chart.caption else 0
                _draw_bars(page, pymupdf.Rect(body_rect.x0, body_rect.y0 + offset + 16, body_rect.x1, body_rect.y1), slide, theme)

        page.insert_htmlbox(
            pymupdf.Rect(width - 60, height - 30, width - 12, height - 8),
            f'<p style="text-align:right; font-size: 11px">{number}</p>',
            css=css,
        )
    doc.subset_fonts()  # без этого каждый текстовый блок тянет полный шрифт
    return doc.tobytes(garbage=3, deflate=True)
