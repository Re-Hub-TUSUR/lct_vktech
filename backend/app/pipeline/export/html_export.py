"""Экспорт в автономный .html: слайды 16:9, навигация стрелками, печать в PDF из браузера."""

from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

from app.pipeline.export.charts import chart_svg
from app.pipeline.theme import colors_for
from app.schemas.slide import Slide

_env = Environment(
    loader=FileSystemLoader(Path(__file__).parent / "templates"),
    autoescape=select_autoescape(["html", "j2"]),
    trim_blocks=True,
    lstrip_blocks=True,
)


def build_html(slides: list[Slide], theme: dict, *, title: str) -> str:
    def chart(slide: Slide) -> Markup:
        return Markup(chart_svg(slide.chart, theme["accents"], theme["text"], theme["muted"]))

    def colors(slide: Slide) -> str:
        background, text = colors_for(theme, slide.kind)
        return f"background: {background}; color: {text};"

    return _env.get_template("deck.html.j2").render(
        title=title,
        slides=slides,
        theme=theme,
        chart=chart,
        colors=colors,
    )
