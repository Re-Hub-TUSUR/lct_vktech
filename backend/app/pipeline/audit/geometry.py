"""Проверки по рендеру: собранный .pptx и строки текста его PDF.

Факты каждого слайда собирает рендер (services/renders.py, export/facts.py): рамки заполненных
блоков (targets, доли слайда [x, y, w, h]), строки текста PDF ([x0, y0, x1, y1], кегль), гарнитуры,
цвета и кегли, заданные в самом слайде, картинки с пропорциями, логотипы и колонтитулы.
Слайд без фактов ещё не отрендерен в нынешнем виде — его проверки ждут рендера.
Пороги — в skills/auditor.yaml (params.render).
"""

import re
from collections.abc import Iterator
from typing import Any

from app.pipeline.audit.catalog import AuditContext, Finding, render_params
from app.pipeline.audit.checks import check, text_overflow_estimate, user_styled
from app.schemas.slide import INVERSE_KINDS, Slide

Box = tuple[float, float, float, float]  # x0, y0, x1, y1

TEXT_TARGETS = {"title", "subtitle", "bullets", "quote", "columns", "kpis", "timeline"}
OBJECT_TARGETS = {"chart", "table", "image"}
ITEM_LABELS = {"columns": "карточка", "kpis": "показатель", "timeline": "этап"}
TARGET_LABELS = {
    "title": "заголовок",
    "subtitle": "подзаголовок",
    "bullets": "текст",
    "quote": "цитата",
    "columns": "колонки",
    "kpis": "показатели",
    "timeline": "этапы",
    "chart": "диаграмма",
    "table": "таблица",
    "image": "картинка",
}
CHROME_LABELS = {"logo": "Логотип", "slide_number": "Номер слайда", "footer": "Колонтитул", "date": "Дата"}
SIDE_LABELS = {"left": "левому", "right": "правому", "top": "верхнему", "bottom": "нижнему"}
SYMBOL_FONTS = {"wingdings", "wingdings 2", "wingdings 3", "webdings", "symbol", "marlett"}
STYLE_WORDS = {
    "regular", "bold", "semibold", "demibold", "extrabold", "ultrabold", "black", "heavy", "medium", "light",
    "extralight", "ultralight", "thin", "book", "italic", "oblique", "condensed", "narrow", "display", "text",
}  # fmt: skip
RENDER_WIDTH_PX = 1280


# --- геометрия ----------------------------------------------------------------------


def xyxy(rect: list[float]) -> Box:
    x, y, w, h = rect
    return x, y, x + w, y + h


def area(box: Box) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def intersection(a: Box, b: Box) -> float:
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def center(box: Box) -> tuple[float, float]:
    return (box[0] + box[2]) / 2, (box[1] + box[3]) / 2


def inside(point: tuple[float, float], box: Box, pad: float = 0.0) -> bool:
    return box[0] - pad <= point[0] <= box[2] + pad and box[1] - pad <= point[1] <= box[3] + pad


def base_name(target: str) -> str:
    return target.split(".", 1)[0]


def label(target: str) -> str:
    base, _, index = target.partition(".")
    if index.isdigit() and base in ITEM_LABELS:
        return f"{ITEM_LABELS[base]} {int(index) + 1}"
    return TARGET_LABELS.get(base, target)


def core(box: Box) -> Box:
    """Тело строки без запаса на выносные элементы и интерлиньяж: у кегля 200 pt этот запас — треть слайда."""
    height = box[3] - box[1]
    return box[0], box[1] + 0.25 * height, box[2], box[3] - 0.2 * height


def quote_text(text: str, limit: int = 40) -> str:
    text = " ".join(text.split())
    return f"«{text[:limit]}…»" if len(text) > limit else f"«{text}»"


class Page:
    """Факты одного слайда с разметкой: какой блок владеет какой строкой текста."""

    def __init__(self, entry: dict[str, Any]):
        self.facts: dict[str, Any] = entry.get("facts") or {}
        self.targets: dict[str, Box] = {name: xyxy(rect) for name, rect in (entry.get("targets") or {}).items()}
        self.lines: list[dict[str, Any]] = [
            {**line, "box": tuple(line["bbox"])} for line in self.facts.get("lines") or [] if len(line.get("bbox") or []) == 4
        ]
        text_targets = {name: box for name, box in self.targets.items() if base_name(name) in TEXT_TARGETS}
        # Строка принадлежит самому тесному текстовому блоку, в рамке которого её середина.
        self.owners: list[str | None] = []
        for line in self.lines:
            point = center(line["box"])
            holders = [name for name, box in text_targets.items() if inside(point, box, pad=0.01)]
            self.owners.append(min(holders, key=lambda name: area(text_targets[name])) if holders else None)

    def owned(self, target: str) -> list[dict[str, Any]]:
        return [line for line, owner in zip(self.lines, self.owners) if owner == target]

    def content_lines(self) -> list[dict[str, Any]]:
        return [line for line, owner in zip(self.lines, self.owners) if owner is not None]

    def objects(self) -> dict[str, Box]:
        """Нетекстовые блоки: диаграмма, таблица, картинка — и картинки пользователя."""
        boxes = {name: box for name, box in self.targets.items() if base_name(name) in OBJECT_TARGETS}
        for index, picture in enumerate(self.facts.get("pictures") or []):
            if picture.get("user"):
                boxes.setdefault("image" if "image" not in boxes else f"image.{index}", xyxy(picture["bbox"]))
        return boxes


def user_placed(slide: Slide, name: str) -> bool:
    """Положение элемента задала сборка на макете или пользователь, а не слайд-пример шаблона.

    Слайд по паттерну — клон примера: где стоят его картинки, текст и декор, решил дизайнер шаблона
    (картинка «в обрез», логотип под фото, крупные поля). Проверки положения критикуют только то,
    что пользователь сдвинул сам или добавил (плавающие фото — image.N)."""
    if not slide.pattern_id:
        return True
    if name.startswith("image."):
        return True
    boxes = slide.element_boxes or {}
    base = base_name(name)
    if any(key == name or key == base or name.startswith(key + ".") for key in boxes):
        return True
    # Сдвинутый блок контента несёт с собой текст тела слайда.
    return "content" in boxes and base not in {"title", "subtitle", "image"}


def pages(slides: list[Slide], ctx: AuditContext) -> Iterator[tuple[Slide, Page]]:
    for slide in slides:
        entry = ctx.renders.get(slide.id)
        if entry is not None:
            yield slide, Page(entry)


# --- Вёрстка -----------------------------------------------------------------------


@check("layout.out_of_bounds")
def out_of_bounds(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    """Диаграмма, таблица, картинка за краем слайда. Рамки текста шаблона нередко шире слайда, а сам текст
    виден целиком, — текст за краем ловит layout.text_clipped по строкам рендера."""
    tolerance = float(render_params().get("bounds_tolerance", 0.01))
    for slide, page in pages(slides, ctx):
        for name, box in page.objects().items():
            if not user_placed(slide, name):
                continue  # картинка «в обрез» — замысел слайда-примера
            over = max(-box[0], -box[1], box[2] - 1, box[3] - 1)
            if over > tolerance:
                yield Finding(
                    "layout.out_of_bounds",
                    slide.id,
                    base_name(name) if name.startswith("image.") else name,
                    f"Блок «{label(name)}» выходит за край слайда на {over * 100:.0f}%",
                )


@check("layout.overlap")
def overlap(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    share = float(render_params().get("overlap_share", 0.3))
    for slide, page in pages(slides, ctx):
        found = 0
        lines = [(line, owner) for line, owner in zip(page.lines, page.owners) if len(line["text"]) >= 2]
        for i, (a, owner_a) in enumerate(lines):
            for b, owner_b in lines[i + 1 :]:
                common = intersection(core(a["box"]), core(b["box"]))
                smaller = min(area(core(a["box"])), area(core(b["box"])))
                if not smaller or common < share * smaller:
                    continue
                if a["text"] == b["text"] and common > 0.9 * smaller:
                    continue  # тень или обводка текста рисуется второй копией строки
                found += 1
                yield Finding(
                    "layout.overlap",
                    slide.id,
                    owner_a or owner_b or "slide",
                    f"Текст {quote_text(a['text'])} наложился на {quote_text(b['text'])}",
                    f"{a['text'][:60]} | {b['text'][:60]}",
                )
                if found >= 2:
                    break
            if found >= 2:
                break
        # Текст заходит на картинку пользователя. Картинки шаблона под текстом — его замысел
        # (число в кольце диаграммы, подпись на иллюстрации), их по рамкам не судим.
        for name, box in page.objects().items():
            if base_name(name) != "image" or name in page.targets:
                continue
            for line, owner in lines:
                if owner and intersection(line["box"], box) >= share * max(area(line["box"]), 1e-9):
                    yield Finding(
                        "layout.overlap",
                        slide.id,
                        owner,
                        f"Текст {quote_text(line['text'])} заходит на картинку",
                        line["text"][:60],
                    )
                    break


@check("layout.text_overflow")
def text_overflow(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    tolerance = float(render_params().get("overflow_tolerance", 0.015))
    rendered = set()
    for slide, page in pages(slides, ctx):
        rendered.add(slide.id)
        for name, box in page.targets.items():
            if base_name(name) not in TEXT_TARGETS:
                continue
            own = sorted(page.owned(name), key=lambda line: line["box"][1])
            if not own:
                continue
            bottom = max(line["box"][3] for line in own)
            # Продолжение текста под рамкой: строки той же колонки, не принадлежащие другим блокам.
            below = sorted(
                (
                    line
                    for line, owner in zip(page.lines, page.owners)
                    if owner is None
                    and box[0] - 0.01 <= center(line["box"])[0] <= box[2] + 0.01
                    and line["box"][1] >= box[3] - 0.005
                ),
                key=lambda line: line["box"][1],
            )
            for line in below:
                height = max(line["box"][3] - line["box"][1], 0.01)
                if line["box"][1] - bottom > 1.2 * height:
                    break
                bottom = max(bottom, line["box"][3])
            overflow = bottom - box[3]
            if overflow > tolerance:
                yield Finding(
                    "layout.text_overflow",
                    slide.id,
                    name,
                    f"Текст выходит за рамку «{label(name)}» на {overflow * 100:.0f}% высоты слайда",
                )
    # Слайды без рендера — оценка по ёмкости рамки (запасное правило).
    yield from text_overflow_estimate([slide for slide in slides if slide.id not in rendered], ctx)


@check("layout.text_clipped")
def text_clipped(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    tolerance = float(render_params().get("clip_tolerance", 0.005))
    for slide, page in pages(slides, ctx):
        for line, owner in zip(page.lines, page.owners):
            box = line["box"]
            if max(-box[0], -box[1], box[2] - 1, box[3] - 1) > tolerance:
                yield Finding(
                    "layout.text_clipped",
                    slide.id,
                    owner or "slide",
                    f"Текст {quote_text(line['text'])} обрезан краем слайда",
                    line["text"][:60],
                )
                break


@check("layout.alignment")
def alignment(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    low, high = (render_params().get("align_near") or [0.006, 0.015])[:2]
    for slide, page in pages(slides, ctx):
        if slide.kind in INVERSE_KINDS:
            continue
        title = page.owned("title")
        body_name = next(
            (name for name in ("bullets", "columns.0", "kpis.0", "timeline.0", "quote", "columns") if page.owned(name)),
            None,
        )
        # Отступы слайда-примера — замысел шаблона; сравниваем, только если пользователь что-то сдвинул.
        if title and body_name and (user_placed(slide, "title") or user_placed(slide, body_name)):
            # Текст карточки отступает от её края на поле карточки — с заголовком выравнивается сама карточка.
            body_left = (
                page.targets[body_name][0]
                if "." in body_name
                else min(line["box"][0] for line in page.owned(body_name))
            )
            gap = abs(min(line["box"][0] for line in title) - body_left)
            if low < gap < high:
                yield Finding(
                    "layout.alignment",
                    slide.id,
                    "title",
                    f"Левые края заголовка и блока «{label(body_name)}» разошлись на {gap * RENDER_WIDTH_PX:.0f} px — "
                    "почти, но не ровно",
                )
        for prefix in ("columns", "kpis", "timeline"):
            tops = [
                min(line["box"][1] for line in own)
                for index in range(12)
                if (own := page.owned(f"{prefix}.{index}"))
            ]
            moved = any(user_placed(slide, f"{prefix}.{index}") for index in range(len(tops)))
            if len(tops) >= 2 and moved and low < max(tops) - min(tops) < high:
                yield Finding(
                    "layout.alignment",
                    slide.id,
                    prefix,
                    f"Элементы «{TARGET_LABELS[prefix]}» начинаются на разной высоте: разброс "
                    f"{(max(tops) - min(tops)) * RENDER_WIDTH_PX * 9 / 16:.0f} px",
                )


@check("layout.margins")
def margins(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    params = render_params()
    default, floor = float(params.get("margin_default", 0.04)), float(params.get("margin_floor", 0.012))
    template_margins = ((ctx.tokens.get("grid") or {}).get("margins")) or {}
    allowed = {
        side: max(floor, min(float(template_margins.get(side) or default), default) - 0.01)
        for side in ("left", "right", "top", "bottom")
    }
    for slide, page in pages(slides, ctx):
        boxes = [(owner, line["box"]) for line, owner in zip(page.lines, page.owners) if owner and user_placed(slide, owner)]
        boxes += [(name, box) for name, box in page.objects().items() if user_placed(slide, name)]
        worst: tuple[float, str, str, float] | None = None
        for owner, box in boxes:
            distances = {"left": box[0], "top": box[1], "right": 1 - box[2], "bottom": 1 - box[3]}
            for side, distance in distances.items():
                if distance < 0:
                    continue  # за краем — это уже layout.out_of_bounds и layout.text_clipped
                intrusion = allowed[side] - distance
                if intrusion > 0 and (worst is None or intrusion > worst[0]):
                    worst = (intrusion, side, owner, distance)
        if worst:
            _, side, owner, distance = worst
            yield Finding(
                "layout.margins",
                slide.id,
                base_name(owner) if owner.startswith("image.") else owner,
                f"Контент ближе к {SIDE_LABELS[side]} краю, чем поле шаблона: {distance * 100:.1f}% "
                f"при поле {allowed[side] * 100 + 1:.1f}%",
            )


@check("layout.image_aspect")
def image_aspect(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    tolerance = float(render_params().get("stretch_tolerance", 0.03))
    for slide, page in pages(slides, ctx):
        for picture in page.facts.get("pictures") or []:
            stretch = float(picture.get("stretch") or 1)
            if picture.get("user") and abs(stretch - 1) > tolerance:
                direction = "по горизонтали" if stretch > 1 else "по вертикали"
                yield Finding(
                    "layout.image_aspect",
                    slide.id,
                    "image",
                    f"Картинка растянута {direction}: пропорции искажены на {abs(stretch - 1) * 100:.0f}%",
                )


# --- Шаблон ------------------------------------------------------------------------


def family(name: str) -> str:
    """Гарнитура без начертания: «Montserrat SemiBold» → «montserrat»."""
    words = name.replace("-", " ").split()
    while len(words) > 1 and words[-1].lower() in STYLE_WORDS:
        words.pop()
    return " ".join(words).lower()


def _theme_fonts(ctx: AuditContext) -> list[str]:
    fonts = ((ctx.tokens.get("theme") or {}).get("fonts")) or {}
    return [name for name in (fonts.get("major"), fonts.get("minor")) if name]


def main_fonts(ctx: AuditContext) -> list[str]:
    """Основная пара шрифтов шаблона: самые частые на его слайдах, без них — шрифты темы."""
    used = [font["name"] for font in ctx.tokens.get("fonts") or [] if font.get("name")]
    return used[:2] or _theme_fonts(ctx)


@check("template.fonts")
def fonts(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    known = {family(name) for name in [*(ctx.inventory.get("fonts") or []), *_theme_fonts(ctx)]}
    known |= {family(font["name"]) for font in ctx.tokens.get("fonts") or [] if font.get("name")}
    # Шрифт темы, не заданный ни одному тексту, на слайдах не виден — считаются основная пара шаблона
    # и гарнитуры, которые реально стоят у текста колоды.
    families = {family(name) for name in main_fonts(ctx)}
    for slide, page in pages(slides, ctx):
        if user_styled(slide, "font"):
            continue  # шрифт выбран в редакторе
        used = [name for name in page.facts.get("fonts") or [] if family(name) not in SYMBOL_FONTS]
        foreign = sorted({name for name in used if family(name) not in known})
        if foreign:
            yield Finding(
                "template.fonts", slide.id, "slide", "Шрифт не из шаблона: " + ", ".join(foreign), ", ".join(foreign)
            )
        before = len(families)
        families |= {family(name) for name in used}
        if len(families) > 2 and before <= 2:
            names = sorted(families)
            source = " (пришла из слайда-примера шаблона)" if not foreign else ""
            yield Finding(
                "template.fonts",
                slide.id,
                "slide",
                f"С этого слайда в колоде {len(names)} гарнитуры: {', '.join(names)} — больше двух{source}",
                ", ".join(names),
            )


@check("template.font_sizes")
def font_sizes(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    tolerance = float(render_params().get("size_tolerance_pt", 0.6))
    share = float(render_params().get("size_tolerance_share", 0.06))
    scale = {item["size_pt"] for item in ctx.tokens.get("type_scale") or [] if item.get("size_pt")}
    for role in (ctx.tokens.get("typography") or {}).values():
        if isinstance(role, dict) and role.get("size_pt"):
            scale.add(role["size_pt"])
    allowed = scale | set(ctx.inventory.get("sizes") or [])
    if not allowed:
        return
    # Мельче самой мелкой ступени шкалы — текст ужат, чтобы влезть в рамку, даже если такой кегль где-то в файле шаблона есть.
    smallest = min(scale) if scale else None
    for slide, page in pages(slides, ctx):
        if user_styled(slide, "size"):
            continue  # кегль изменён в редакторе
        sizes = page.facts.get("sizes") or []
        tiny = [size for size in sizes if smallest is not None and size < smallest - tolerance]
        # На слайде из шаблона кегли — это кегли слотов примера после автоподбора сборки (длинный текст
        # ужимается, числа KPI масштабируются всей серией): «не из шкалы» там не ошибка, «мельче шкалы» — да.
        off = [
            size
            for size in sizes
            if size not in tiny
            and not slide.pattern_id
            and all(abs(size - step) > max(tolerance, share * step) for step in allowed)
        ]
        if tiny:
            shown = ", ".join(f"{size:g} pt" for size in tiny[:5])
            yield Finding(
                "template.font_sizes",
                slide.id,
                "slide",
                f"Кегль {shown} мельче шкалы шаблона (от {smallest:g} pt): текст ужат, чтобы поместиться в рамку",
                shown,
            )
        if off:
            shown = ", ".join(f"{size:g} pt" for size in off[:5])
            yield Finding("template.font_sizes", slide.id, "slide", f"Кегли не из шкалы шаблона: {shown}", shown)


HEX_RX = re.compile(r"^#[0-9A-F]{6}$")


def _rgb(color: str) -> tuple[int, int, int]:
    return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)


def derived(color: tuple[int, int, int], base: list[tuple[int, int, int]], tolerance: float) -> bool:
    """Цвет из палитры или её оттенок: лежит на отрезке между двумя цветами палитры (смесь)."""
    for a in base:
        if max(abs(c - x) for c, x in zip(color, a)) <= tolerance:
            return True
    for i, a in enumerate(base):
        for b in base[i + 1 :]:
            direction = [y - x for x, y in zip(a, b)]
            length = sum(d * d for d in direction)
            if not length:
                continue
            t = max(0.0, min(1.0, sum((c - x) * d for c, x, d in zip(color, a, direction)) / length))
            if max(abs(c - (x + t * d)) for c, x, d in zip(color, a, direction)) <= tolerance:
                return True
    return False


@check("template.palette")
def palette(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    tolerance = float(render_params().get("color_tolerance", 10))
    colors = {*(ctx.inventory.get("colors") or []), "#FFFFFF", "#000000"}
    colors |= {str(value).upper() for value in ((ctx.tokens.get("theme") or {}).get("colors") or {}).values()}
    colors |= {str(item.get("hex", "")).upper() for item in ctx.tokens.get("palette") or []}
    base = [_rgb(color) for color in sorted(colors) if HEX_RX.match(color)]
    cache: dict[str, bool] = {}
    for slide, page in pages(slides, ctx):
        if user_styled(slide, "color"):
            continue  # цвет выбран в редакторе
        foreign = []
        for color in page.facts.get("colors") or []:
            if not HEX_RX.match(color):
                continue
            if color not in cache:
                cache[color] = derived(_rgb(color), base, tolerance)
            if not cache[color]:
                foreign.append(color)
        if foreign:
            shown = ", ".join(foreign[:5])
            yield Finding("template.palette", slide.id, "slide", f"Цвета не из палитры шаблона: {shown}", shown)


@check("template.logo_position")
def logo_position(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    share = float(render_params().get("chrome_overlap", 0.15))
    for slide, page in pages(slides, ctx):
        # Перекрытие, заложенное в слайде-примере (фото под логотипом), — не ошибка сборки.
        content = [
            line["box"] for line, owner in zip(page.lines, page.owners) if owner is not None and user_placed(slide, owner)
        ] + [box for name, box in page.objects().items() if user_placed(slide, name)]
        for chrome in page.facts.get("chrome") or []:
            box = xyxy(chrome["bbox"])
            size = area(box)
            if not size:
                continue
            # Собственный текст колонтитула и номера лежит внутри их рамки — это не перекрытие.
            covered = sum(
                intersection(item, box) for item in content if intersection(item, box) < 0.8 * max(area(item), 1e-9)
            )
            if covered / size > share:
                yield Finding(
                    "template.logo_position",
                    slide.id,
                    "slide",
                    f"{CHROME_LABELS.get(chrome['kind'], 'Колонтитул')} перекрыт контентом на {min(covered / size, 1) * 100:.0f}%",
                    chrome["kind"],
                )


# --- Плотность ---------------------------------------------------------------------


def _mark(cells: set[tuple[int, int]], box: Box, grid: tuple[int, int]) -> None:
    columns, rows = grid
    x0, y0 = max(0, int(box[0] * columns)), max(0, int(box[1] * rows))
    x1, y1 = min(columns, int(box[2] * columns + 0.999)), min(rows, int(box[3] * rows + 0.999))
    for x in range(x0, x1):
        for y in range(y0, y1):
            cells.add((x, y))


@check("density.fill_ratio")
def fill_ratio(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    params = render_params()
    low, high = float(params.get("fill_min", 0.25)), float(params.get("fill_max", 0.75))
    grid = tuple(params.get("fill_grid") or (160, 90))
    for slide, page in pages(slides, ctx):
        if slide.kind in INVERSE_KINDS or slide.kind in {"quote", "agenda"}:
            continue
        if slide.pattern_id:
            continue  # заполненность слайда-примера — пропорции самого шаблона
        cells: set[tuple[int, int]] = set()
        owners = {owner for owner in page.owners if owner}
        for owner in owners:
            own = page.owned(owner)
            # Текстовый блок занимает площадь от первой до последней строки, с интервалами.
            _mark(cells, (min(l["box"][0] for l in own), min(l["box"][1] for l in own),
                          max(l["box"][2] for l in own), max(l["box"][3] for l in own)), grid)  # fmt: skip
        for line, owner in zip(page.lines, page.owners):
            if owner is None:
                _mark(cells, line["box"], grid)
        for name, box in page.targets.items():
            if base_name(name) in OBJECT_TARGETS or ("." in name and base_name(name) in ITEM_LABELS):
                _mark(cells, box, grid)
        for box in page.objects().values():
            _mark(cells, box, grid)
        ratio = len(cells) / (grid[0] * grid[1])
        if ratio < low:
            yield Finding("density.fill_ratio", slide.id, "slide", f"Слайд заполнен на {ratio:.0%} — много пустого места")
        elif ratio > high:
            yield Finding("density.fill_ratio", slide.id, "slide", f"Слайд заполнен на {ratio:.0%} — перегружен")


# --- Целостность -------------------------------------------------------------------


@check("integrity.file_opens")
def file_opens(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    if ctx.render_status == "failed" and ctx.render_error_kind == "build":
        yield Finding("integrity.file_opens", None, None, f"Собранный .pptx не открывается: {ctx.render_error}")


@check("integrity.raster_slide")
def raster_slide(slides: list[Slide], ctx: AuditContext) -> Iterator[Finding]:
    for slide, page in pages(slides, ctx):
        if page.facts.get("only_pictures"):
            yield Finding(
                "integrity.raster_slide", slide.id, "slide", "Слайд состоит только из картинок — текст на нём не редактируется"
            )
