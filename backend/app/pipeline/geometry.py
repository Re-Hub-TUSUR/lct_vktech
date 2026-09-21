"""Общая геометрия вёрстки: где на слайде макета располагается контент.

Одни и те же правила использует экспорт в .pptx и превью (фронтенд и HTML),
поэтому превью совпадает с тем, что пользователь получит в файле.
"""

Rect = tuple[int, int, int, int]  # left, top, width, height в EMU


def content_frame(title: Rect | None, width: int, height: int) -> Rect:
    """Область контента под заголовком макета, с полями по краям."""
    margin = int(width * 0.06)
    top = int(height * 0.24)
    if title is not None:
        left, title_top, _, title_height = title
        margin = max(int(left), int(width * 0.03))
        top = int(title_top + title_height + height * 0.06)
        if top > height * 0.5:
            top = int(height * 0.26)
    bottom = int(height * 0.9)
    return margin, top, width - 2 * margin, max(bottom - top, int(height * 0.3))


def to_fractions(rect: Rect | None, width: int, height: int) -> list[float] | None:
    if rect is None:
        return None
    left, top, w, h = rect
    return [round(left / width, 4), round(top / height, 4), round(w / width, 4), round(h / height, 4)]


def _wrapped_lines(words: list[str], line_chars: float) -> int:
    lines, current = 1, 0
    for word in words:
        need = len(word) + (1 if current else 0)
        if current and current + need > line_chars:
            lines, current = lines + 1, len(word)
        else:
            current += need
    return lines


def fit_font_size(text: str, size: float, rect: list[float], aspect: float, minimum: float = 1.6) -> float:
    """Уменьшает кегль (в % ширины слайда), пока текст не влезет в рамку — как автоподбор в PowerPoint.

    Оценка по средней ширине символа 0,55 кегля и межстрочному интервалу 1,15.
    """
    width = rect[2] * 100
    height = rect[3] * 100 / aspect
    words = text.split() or [""]
    while size > minimum:
        if _wrapped_lines(words, width / (size * 0.55)) * size * 1.15 <= height:
            return round(size, 2)
        size *= 0.92
    return minimum
