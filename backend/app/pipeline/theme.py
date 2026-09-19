"""Цвета и шрифты для отрисовки слайдов из дизайн-токенов шаблона + расчёт контраста (WCAG 2.1)."""

import re
from collections.abc import Callable
from typing import Any

HEX_RX = re.compile(r"^#[0-9A-Fa-f]{6}$")
FALLBACK_ACCENT = "#0077FF"
WHITE = "#FFFFFF"

# Слайды на «обложечном» фоне: обложка, разделитель, финал.
COVER_ROLE_BY_KIND = {"title": "cover", "section": "section", "closing": "closing"}


def _valid(color: Any) -> str | None:
    return color.upper() if isinstance(color, str) and HEX_RX.match(color) else None


def _rgb(color: str) -> tuple[int, int, int]:
    value = color.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def relative_luminance(color: str) -> float:
    def channel(c: int) -> float:
        s = c / 255
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(c) for c in _rgb(color))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(a: str, b: str) -> float:
    la, lb = relative_luminance(a), relative_luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def mix(a: str, b: str, t: float) -> str:
    """Смешивает цвета: t=0 → a, t=1 → b."""
    ra, ga, ba = _rgb(a)
    rb, gb, bb = _rgb(b)
    return "#{:02X}{:02X}{:02X}".format(
        round(ra + (rb - ra) * t), round(ga + (gb - ga) * t), round(ba + (bb - ba) * t)
    )


def text_on(background: str, dark: str, light: str = WHITE, minimum: float = 4.5) -> str:
    """Цвет текста для фона: тёмный из темы, если хватает контраста, иначе светлый."""
    if contrast_ratio(dark, background) >= minimum:
        return dark
    if contrast_ratio(light, background) >= minimum:
        return light
    return max((dark, light), key=lambda color: contrast_ratio(color, background))


def slide_theme(
    tokens: dict[str, Any] | None,
    layouts: list[dict[str, Any]] | None = None,
    roles: dict[str, Any] | None = None,
    image_url: Callable[[dict[str, Any]], str] | None = None,
    extra_keys: set[str] | None = None,
) -> dict[str, Any]:
    """Тема отрисовки слайдов. С макетами и ролями добавляет «скины» макетов, на которых верстаются слайды:
    фон (цвет и картинка-рендер), цвета текста, области заголовка и контента, стиль заголовка.
    extra_keys — макеты слайдов-примеров, по которым верстаются паттерны."""
    tokens = tokens or {}
    theme = tokens.get("theme") or {}
    colors = theme.get("colors") or {}
    backgrounds = tokens.get("backgrounds") or {}

    light = _valid(colors.get("lt1")) or WHITE
    dark = _valid(colors.get("dk1")) or "#1F2328"
    if relative_luminance(light) < relative_luminance(dark):
        light, dark = dark, light

    background = _valid(backgrounds.get("content")) or light
    light_text = light if relative_luminance(light) > 0.7 else WHITE
    text = text_on(background, dark, light_text)

    accents: list[str] = []
    for key in ("accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "dk2"):
        color = _valid(colors.get(key))
        # Отбрасываем «акценты», неотличимые от фона (например, белый accent2 на белом слайде).
        if color and color not in accents and contrast_ratio(color, background) >= 1.35:
            accents.append(color)
    if not accents:
        accents = [FALLBACK_ACCENT]
    accent = accents[0]

    def cover(role: str, fallback: str) -> dict[str, str]:
        # На обложках только крупный текст: по WCAG ему достаточно 3:1, белый предпочтительнее.
        bg = _valid(backgrounds.get(role)) or fallback
        fg = WHITE if contrast_ratio(WHITE, bg) >= 3.0 else text_on(bg, dark, minimum=3.0)
        return {"background": bg, "text": fg}

    title_cover = cover("title", accent)
    used_fonts = [f["name"] for f in tokens.get("fonts") or [] if f.get("name")]
    theme_fonts = theme.get("fonts") or {}
    heading_font = used_fonts[0] if used_fonts else theme_fonts.get("major") or "Arial"
    body_font = theme_fonts.get("minor") or heading_font

    size = tokens.get("slide_size") or {}
    aspect = size["width_emu"] / size["height_emu"] if size.get("height_emu") else 16 / 9

    skins: dict[str, Any] = {}
    roles = roles or {}
    role_keys = {key for key in roles.values() if key} | (extra_keys or set())
    # Макеты обложки, разделителя и финала, которые не служат контентными: на них только крупный текст.
    cover_keys = {roles.get(role) for role in ("title", "section", "closing")} - {roles.get("content")}
    width_pt = (size.get("width_emu") or 12192000) / 12700
    for layout in layouts or []:
        if layout.get("key") not in role_keys:
            continue
        bg = _valid(layout.get("background")) or background
        if layout["key"] in cover_keys:
            fg = WHITE if contrast_ratio(WHITE, bg) >= 3.0 else text_on(bg, dark, minimum=3.0)
        else:
            fg = text_on(bg, dark, light_text)
        style = layout.get("title_style") or {}
        title_color = _valid(style.get("color"))
        if title_color is None or contrast_ratio(title_color, bg) < 3.0:
            title_color = fg
        size_pt = style.get("size_pt")
        skins[layout["key"]] = {
            "background": bg,
            "text": fg,
            "muted": mix(fg, bg, 0.45),
            "surface": mix(accent, bg, 0.88),
            "image": image_url(layout) if image_url and layout.get("image") else None,
            "frames": layout.get("frames"),
            "title": {
                "color": title_color,
                # Кегль в % ширины слайда — так он масштабируется вместе с превью (единицы cqw).
                "size": round(size_pt / width_pt * 100, 2) if size_pt else None,
                "anchor": style.get("anchor"),
                "align": style.get("align"),
                "bold": style.get("bold"),
            },
        }

    return {
        "background": background,
        "text": text,
        "muted": mix(text, background, 0.45),
        "surface": mix(accent, background, 0.88),
        "accent": accent,
        "accents": accents[:6],
        "cover": title_cover,
        "section": cover("section", title_cover["background"]),
        "closing": cover("closing", title_cover["background"]),
        "heading_font": heading_font,
        "body_font": body_font,
        "aspect": round(aspect, 4),
        "layouts": skins,
        "roles": dict(roles),
    }


def colors_for(theme: dict[str, Any], kind: str, layout_key: str | None = None) -> tuple[str, str]:
    """Фон и цвет текста слайда: по макету шаблона, если он известен, иначе по типу слайда."""
    skin = (theme.get("layouts") or {}).get(layout_key or "")
    if skin:
        return skin["background"], skin["text"]
    role = COVER_ROLE_BY_KIND.get(kind)
    if role:
        return theme[role]["background"], theme[role]["text"]
    return theme["background"], theme["text"]
