"""Экспорт в автономный .html: навигация стрелками, печать из браузера.

Если есть актуальные рендеры варианта (собранный .pptx → LibreOffice), слайды — это они,
то есть HTML совпадает с .pptx один в один, а текст слайда лежит рядом скрытым блоком
для поиска и экранных дикторов. Без рендеров слайды верстаются по областям макетов
на их фонах, как раньше.
"""

import base64
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

from app.pipeline.export.charts import chart_svg
from app.pipeline.geometry import fit_font_size
from app.pipeline.theme import colors_for
from app.schemas.slide import INVERSE_KINDS, Slide

_env = Environment(
    loader=FileSystemLoader(Path(__file__).parent / "templates"),
    autoescape=select_autoescape(["html", "j2"]),
    trim_blocks=True,
    lstrip_blocks=True,
)

ALIGN = {"l": "left", "ctr": "center", "r": "right", "just": "justify"}
ANCHOR = {"t": "flex-start", "ctr": "center", "b": "flex-end"}


def _box(rect: list[float]) -> str:
    left, top, width, height = rect
    return f"left:{left * 100:.2f}%;top:{top * 100:.2f}%;width:{width * 100:.2f}%;height:{height * 100:.2f}%;"


def _css_class(key: str) -> str:
    return "bg-" + key.replace(":", "-")


def build_html(
    slides: list[Slide],
    theme: dict,
    *,
    title: str,
    images: dict[str, bytes] | None = None,
    rendered: list[bytes] | None = None,
) -> str:
    images = images or {}
    shots = (
        ["data:image/jpeg;base64," + base64.b64encode(data).decode() for data in rendered]
        if rendered and len(rendered) == len(slides)
        else None
    )
    skins = theme.get("layouts") or {}

    def chart(slide: Slide) -> Markup:
        _, text = colors_for(theme, slide.kind, slide.layout_key)
        return Markup(chart_svg(slide.chart, theme["accents"], text, theme["muted"]))

    def frame(slide: Slide) -> dict | None:
        """Раскладка слайда по областям макета или None — тогда слайд верстается потоком."""
        skin = skins.get(slide.layout_key or "")
        frames = (skin or {}).get("frames") or {}
        if not skin or not frames.get("title"):
            return None
        cover = slide.kind in INVERSE_KINDS
        title_rect = frames["title"]
        subtitle_rect = frames.get("subtitle") or [
            title_rect[0], min(title_rect[1] + title_rect[3] + 0.02, 0.8), title_rect[2], 0.16
        ]
        style = skin["title"]
        size = fit_font_size(slide.title, min(style.get("size") or (5.0 if cover else 3.1), 8), title_rect, theme["aspect"])
        return {
            "title": _box(title_rect)
            + f"font-size:{size:.2f}cqw;color:{style['color']};"
            + f"justify-content:{ANCHOR.get(style.get('anchor') or '', 'flex-start')};"
            + f"text-align:{ALIGN.get(style.get('align') or '', 'left')};"
            + ("font-weight:700;" if style.get("bold") is not False else "font-weight:400;"),
            "subtitle": _box(subtitle_rect),
            "body": _box(frames.get("body") or [0.06, 0.24, 0.88, 0.66]),
        }

    def slide_style(slide: Slide) -> str:
        background, text = colors_for(theme, slide.kind, slide.layout_key)
        skin = skins.get(slide.layout_key or "") or {}
        muted = skin.get("muted", theme["muted"])
        surface = skin.get("surface", theme["surface"])
        return f"background-color:{background};color:{text};--muted:{muted};--surface:{surface};"

    backgrounds = {
        _css_class(key): "data:image/jpeg;base64," + base64.b64encode(data).decode()
        for key, data in images.items()
        if key in skins
    }

    return _env.get_template("deck.html.j2").render(
        title=title,
        slides=slides,
        theme=theme,
        chart=chart,
        frame=frame,
        slide_style=slide_style,
        backgrounds=backgrounds,
        background_class=lambda slide: _css_class(slide.layout_key) if slide.layout_key else "",
        inverse_kinds=INVERSE_KINDS,
        shots=shots,
    )
