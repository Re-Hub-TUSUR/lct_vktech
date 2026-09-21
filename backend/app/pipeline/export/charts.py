"""SVG-диаграммы для HTML-экспорта (столбцы, линии, круговая)."""

import math
from html import escape

from app.schemas.slide import ChartData

WIDTH, HEIGHT = 800, 380
PAD_LEFT, PAD_RIGHT, PAD_TOP, PAD_BOTTOM = 56, 16, 28, 48


def _fmt(value: float) -> str:
    return f"{value:g}".replace(".", ",")


def chart_svg(chart: ChartData, accents: list[str], text_color: str, muted: str) -> str:
    if chart.type == "pie":
        return _pie(chart, accents, text_color)
    values = [v for series in chart.series for v in series.values] or [0]
    top = max(max(values), 0) or 1
    plot_w = WIDTH - PAD_LEFT - PAD_RIGHT
    plot_h = HEIGHT - PAD_TOP - PAD_BOTTOM
    base_y = PAD_TOP + plot_h
    parts = [
        f'<svg viewBox="0 0 {WIDTH} {HEIGHT}" class="chart" role="img">',
        f'<line x1="{PAD_LEFT}" y1="{base_y}" x2="{WIDTH - PAD_RIGHT}" y2="{base_y}" stroke="{muted}" />',
    ]
    if chart.unit:
        parts.append(f'<text x="4" y="16" fill="{muted}" font-size="14">{escape(chart.unit)}</text>')
    count = max(len(chart.categories), 1)
    group_w = plot_w / count

    for ci, category in enumerate(chart.categories):
        cx = PAD_LEFT + group_w * (ci + 0.5)
        parts.append(
            f'<text x="{cx:.1f}" y="{base_y + 26}" text-anchor="middle" fill="{text_color}" '
            f'font-size="15">{escape(category)}</text>'
        )

    if chart.type == "line":
        for si, series in enumerate(chart.series):
            color = accents[si % len(accents)]
            points = [
                (PAD_LEFT + group_w * (i + 0.5), base_y - plot_h * v / top) for i, v in enumerate(series.values)
            ]
            path = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
            parts.append(f'<polyline points="{path}" fill="none" stroke="{color}" stroke-width="4" />')
            for (x, y), v in zip(points, series.values):
                parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="6" fill="{color}" />')
                parts.append(
                    f'<text x="{x:.1f}" y="{y - 12:.1f}" text-anchor="middle" fill="{text_color}" '
                    f'font-size="14">{_fmt(v)}</text>'
                )
    else:
        n_series = max(len(chart.series), 1)
        bar_w = group_w * 0.7 / n_series
        for si, series in enumerate(chart.series):
            color = accents[si % len(accents)]
            for ci, v in enumerate(series.values):
                h = plot_h * max(v, 0) / top
                x = PAD_LEFT + group_w * ci + group_w * 0.15 + bar_w * si
                parts.append(
                    f'<rect x="{x:.1f}" y="{base_y - h:.1f}" width="{bar_w:.1f}" height="{h:.1f}" '
                    f'rx="4" fill="{color}" />'
                )
                parts.append(
                    f'<text x="{x + bar_w / 2:.1f}" y="{base_y - h - 8:.1f}" text-anchor="middle" '
                    f'fill="{text_color}" font-size="15">{_fmt(v)}</text>'
                )
    parts.append("</svg>")
    return "".join(parts)


def _pie(chart: ChartData, accents: list[str], text_color: str) -> str:
    values = chart.series[0].values if chart.series else []
    total = sum(v for v in values if v > 0) or 1
    cx, cy, r = HEIGHT / 2, HEIGHT / 2, HEIGHT / 2 - 16
    parts = [f'<svg viewBox="0 0 {WIDTH} {HEIGHT}" class="chart" role="img">']
    angle = -math.pi / 2
    for i, v in enumerate(values):
        sweep = 2 * math.pi * max(v, 0) / total
        x1, y1 = cx + r * math.cos(angle), cy + r * math.sin(angle)
        angle += sweep
        x2, y2 = cx + r * math.cos(angle), cy + r * math.sin(angle)
        large = 1 if sweep > math.pi else 0
        color = accents[i % len(accents)]
        parts.append(
            f'<path d="M{cx},{cy} L{x1:.1f},{y1:.1f} A{r},{r} 0 {large} 1 {x2:.1f},{y2:.1f} Z" fill="{color}" />'
        )
        label = chart.categories[i] if i < len(chart.categories) else ""
        parts.append(f'<rect x="{HEIGHT + 20}" y="{40 + i * 34}" width="18" height="18" rx="4" fill="{color}" />')
        parts.append(
            f'<text x="{HEIGHT + 48}" y="{54 + i * 34}" fill="{text_color}" font-size="16">'
            f"{escape(label)} — {_fmt(v)}</text>"
        )
    parts.append("</svg>")
    return "".join(parts)
