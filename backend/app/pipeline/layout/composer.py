"""Сборка трёх вариантов вёрстки из плана.

Варианты различаются по оси, выбранной пользователем (профили — в
skills/layout_composer.yaml). Каждый слайд получает паттерн шаблона — слайд-пример,
который при экспорте клонируется и заполняется (layout/matcher.py), а если подходящего
нет — макет шаблона по роли. Поэтому один и тот же код работает с любым шаблоном.
"""

import copy
import math
import random
from dataclasses import dataclass
from typing import Any

from app.pipeline.layout.matcher import assign_patterns
from app.pipeline.skills import get_skill
from app.schemas.slide import (
    ChartData,
    ChartSeries,
    Column,
    ImageSpec,
    Kpi,
    Quote,
    Slide,
    TableData,
    TimelineItem,
)

DEFAULT_PROFILE: dict[str, Any] = {
    "max_bullets": 5,
    "titles": "insight",
    "data_view": "chart",
    "layout_style": "bullets",
    "order": "linear",
}
ROLE_BY_KIND = {
    "title": "title",
    "section": "section",
    "agenda": "agenda",
    "closing": "closing",
    "two_columns": "two_columns",
    "image_text": "image",
}
NO_INSIGHT_TITLE = {"title", "section", "agenda", "closing"}
# Разделитель ставится перед блоком хотя бы из стольких слайдов: раздел из одного слайда — пустой слайд.
SECTION_MIN_SLIDES = 2


@dataclass
class VariantDraft:
    position: int
    letter: str
    name: str
    description: str
    axis: str
    profile: dict[str, Any]
    slides: list[Slide]


def axis_config(axis_key: str) -> tuple[str, dict[str, Any]]:
    params = get_skill("layout_composer").params
    axes = params.get("axes") or {}
    if axis_key not in axes:
        axis_key = params.get("default_axis") or next(iter(axes))
    return axis_key, axes[axis_key]


def fit_specs(specs: list[dict[str, Any]], target: int) -> list[dict[str, Any]]:
    """Убирает необязательные слайды (priority 3, затем 2) с конца, пока не влезем в target."""
    result = list(specs)
    target = max(target, 3)
    for priority in (3, 2):
        while len(result) > target:
            index = next(
                (i for i in range(len(result) - 1, -1, -1) if result[i].get("priority", 2) == priority),
                None,
            )
            if index is None:
                break
            result.pop(index)
    return result


def compose_single_variant(
    specs: list[dict[str, Any]],
    *,
    axis_key: str,
    position: int,
    slides_count: int,
    speaker_notes: bool,
    layouts: list[dict[str, Any]],
    roles: dict[str, Any],
    groups: dict[str, str],
    seed: int | None = None,
    patterns: list[dict[str, Any]] | None = None,
    images_available: bool = True,
) -> VariantDraft:
    """images_available=False — картинок для слайдов нет (материалы без фото, text-to-image не подключена):
    вариант «текст и изображение» уступает место своему запасному профилю (without_images в YAML),
    а слайды «тезисы с иллюстрацией» верстаются без пустой рамки под картинку."""
    axis_key, axis = axis_config(axis_key)
    layout_names = {layout["key"]: layout["name"] for layout in layouts}
    variants_cfg = (axis.get("variants") or [])[:3]
    cfg = variants_cfg[position] if 0 <= position < len(variants_cfg) else {}
    profile = {**DEFAULT_PROFILE, **(cfg.get("profile") or {})}
    if not images_available and profile["layout_style"] == "image":
        fallback = cfg.get("without_images") or {}
        cfg = {**cfg, **{key: value for key, value in fallback.items() if key != "profile"}}
        profile = {**profile, "layout_style": "columns", **(fallback.get("profile") or {})}

    # Разделители в варианте «по разделам» тоже занимают место в колоде.
    dividers = len(_section_groups(specs)) if profile["order"] == "sections" else 0
    fitted = fit_specs(specs, slides_count - dividers)

    # При реролле (когда seed задан или при вариативности) можно варьировать представление данных или порядок тезисов
    if seed is not None:
        local_random = random.Random(seed)
        modified_specs = []
        for s in fitted:
            sc = copy.deepcopy(s)
            bullets = sc.get("bullets")
            if bullets and isinstance(bullets, list) and len(bullets) > 2:
                # Мягкое вращение списка тезисов или перемешивание для свежести
                rotate_by = local_random.randint(0, len(bullets) - 1)
                sc["bullets"] = bullets[rotate_by:] + bullets[:rotate_by]
            modified_specs.append(sc)
        fitted = modified_specs

    slides = [_to_slide(spec, profile, speaker_notes, images_available) for spec in fitted]
    _fill_agenda(slides, groups)
    slides = _apply_order(slides, profile["order"], groups)
    assign_layouts(slides, roles, layout_names)
    # Рерол (seed задан) берёт другой паттерн из равноценных — вёрстка меняется, а не только порядок тезисов.
    assign_patterns(slides, patterns, position=position, layout_names=layout_names, seed=seed)

    return VariantDraft(
        position=position,
        letter=cfg.get("letter", "ABC"[position] if position < 3 else str(position + 1)),
        name=cfg.get("name", f"Вариант {position + 1}"),
        description=cfg.get("description", ""),
        axis=axis_key,
        profile=profile,
        slides=slides,
    )


def compose_variants(
    specs: list[dict[str, Any]],
    *,
    axis_key: str,
    slides_count: int,
    speaker_notes: bool,
    layouts: list[dict[str, Any]],
    roles: dict[str, Any],
    groups: dict[str, str],
    patterns: list[dict[str, Any]] | None = None,
    images_available: bool = True,
) -> list[VariantDraft]:
    axis_key, axis = axis_config(axis_key)
    drafts: list[VariantDraft] = []
    variants_cfg = (axis.get("variants") or [])[:3]
    for position in range(len(variants_cfg)):
        drafts.append(
            compose_single_variant(
                specs,
                axis_key=axis_key,
                position=position,
                slides_count=slides_count,
                speaker_notes=speaker_notes,
                layouts=layouts,
                roles=roles,
                groups=groups,
                patterns=patterns,
                images_available=images_available,
            )
        )
    return drafts


def _section_groups(items) -> set[str]:
    """Блоки, которым нужен слайд-разделитель: в блоке не меньше SECTION_MIN_SLIDES слайдов. Если таких
    нет (все блоки по слайду), разделители у всех блоков — иначе вариант «по разделам» совпал бы с линейным."""
    groups = [item.get("group") if isinstance(item, dict) else item.group for item in items]
    return {group for group in groups if group and groups.count(group) >= SECTION_MIN_SLIDES} or {
        group for group in groups if group
    }


def _strs(items: list[Any] | None) -> list[str]:
    return [str(item) for item in items or []]


def _to_slide(spec: dict[str, Any], profile: dict[str, Any], speaker_notes: bool, images_available: bool = True) -> Slide:
    kind = spec["kind"]
    flexible = bool(spec.get("flexible"))
    if kind == "image_text" and not images_available:
        # Картинки нет — пустая рамка хуже, чем тезисы: слайд верстается как гибкие тезисы.
        kind, flexible = "bullets", True
    topic = spec.get("topic") or ""
    insight = spec.get("insight")
    use_insight = profile["titles"] == "insight" and insight and kind not in NO_INSIGHT_TITLE
    slide = Slide(
        kind="bullets" if kind == "data" else kind,
        ref=spec.get("ref"),
        group=spec.get("group"),
        title=insight if use_insight else topic,
        subtitle=spec.get("subtitle"),
        summary=insight,
    )
    max_bullets = int(profile["max_bullets"])
    bullets = _strs(spec.get("bullets"))

    if kind == "data":
        _fill_data(slide, spec.get("data") or {}, profile["data_view"])
    elif kind == "bullets":
        style = profile["layout_style"] if flexible else "bullets"
        if style == "image" and not images_available:
            style = "bullets"
        if style == "cards" and spec.get("cards"):
            slide.kind = "cards"
            slide.columns = _cards(spec["cards"], max_bullets)
        elif style in {"cards", "columns"} and spec.get("columns"):
            slide.kind = "two_columns"
            slide.columns = _columns(spec["columns"], max_bullets)
        elif style == "image":
            slide.kind = "image_text"
            slide.bullets = bullets[: min(max_bullets, 4)]
            slide.image = ImageSpec(prompt=spec.get("image_prompt") or f"Иллюстрация к слайду «{topic}»")
        else:
            slide.bullets = bullets[:max_bullets]
    elif kind == "two_columns":
        slide.columns = _columns(spec.get("columns") or [], max_bullets)
    elif kind == "timeline":
        slide.timeline = [TimelineItem(**{k: str(v) for k, v in item.items()}) for item in spec.get("timeline") or []]
    elif kind == "table":
        slide.table = _table(spec.get("table") or {})
    elif kind == "quote" and spec.get("quote"):
        slide.quote = Quote(**spec["quote"])
    elif kind == "image_text":
        slide.bullets = bullets[:max_bullets]
        slide.image = ImageSpec(prompt=spec.get("image_prompt") or f"Иллюстрация к слайду «{topic}»")

    if speaker_notes:
        # Заметку мог написать автор текстов (LLM); иначе — дежурная подсказка по типу слайда.
        slide.notes = spec.get("notes") or _notes(kind, topic, insight)
    return slide


def _columns(columns: list[dict[str, Any]], max_bullets: int) -> list[Column]:
    per_column = max(2, math.ceil(max_bullets / 2))
    return [
        Column(title=str(column.get("title", "")), bullets=_strs(column.get("bullets"))[:per_column])
        for column in columns[:2]
    ]


def _cards(cards: list[dict[str, Any]], max_bullets: int) -> list[Column]:
    """Карточки: заголовок и короткий текст. Карточек не меньше трёх — иначе это колонки."""
    return [
        Column(title=str(card.get("title", "")), bullets=[str(card["text"])] if card.get("text") else [])
        for card in cards[: max(3, max_bullets)]
    ]


def _table(data: dict[str, Any]) -> TableData:
    return TableData(columns=_strs(data.get("columns")), rows=[_strs(row) for row in data.get("rows") or []])


def _fill_data(slide: Slide, data: dict[str, Any], view: str) -> None:
    categories = _strs(data.get("categories"))
    series = [
        ChartSeries(name=str(s.get("name", "")), values=[float(v) for v in s.get("values") or []])
        for s in data.get("series") or []
    ]
    if view == "kpi" and data.get("kpis"):
        slide.kind = "kpi"
        slide.kpis = [Kpi(value=str(k["value"]), label=str(k.get("label", ""))) for k in data["kpis"]]
    elif view == "table" and data.get("table"):
        slide.kind = "table"
        slide.table = _table(data["table"])
    else:
        slide.kind = "chart"
        key = data.get("key")
        slide.chart = ChartData(
            type=data.get("chart_type", "bar"),
            caption=data.get("caption"),
            unit=data.get("unit"),
            categories=categories,
            series=series,
            # Ключевую категорию называет автор текстов: она доказывает вывод слайда.
            highlight=categories.index(key) if key in categories else None,
        )


def _notes(kind: str, topic: str, insight: str | None) -> str:
    if kind == "title":
        return "Представьтесь и за одну фразу скажите, зачем эта встреча."
    if kind == "closing":
        return "Подведите итог в одном предложении и предложите следующий шаг."
    if insight:
        return f"Главная мысль: {insight}. Подкрепите её примером из материалов."
    return f"Раскройте тему «{topic}» своими словами."


def _fill_agenda(slides: list[Slide], groups: dict[str, str]) -> None:
    labels: list[str] = []
    for slide in slides:
        if slide.group and groups.get(slide.group) and groups[slide.group] not in labels:
            labels.append(groups[slide.group])
    for slide in slides:
        if slide.kind == "agenda":
            slide.bullets = labels


def _apply_order(slides: list[Slide], order: str, groups: dict[str, str]) -> list[Slide]:
    if order == "summary_first":
        # Итоги — слайд summary, иначе блок «Результаты» из плана модели, иначе последний
        # содержательный слайд перед финалом: они встают сразу после обложки.
        content = [s for s in slides if s.kind not in {"title", "closing", "section", "agenda"}]
        summary = (
            [s for s in slides if s.ref == "summary"]
            or [s for s in content if s.group == "results"]
            or content[-1:]
        )
        if summary and len(slides) > 2 and len(content) > len(summary):
            rest = [s for s in slides if all(s is not item for item in summary)]
            slides = rest[:1] + summary + rest[1:]
    elif order == "sections":
        result: list[Slide] = []
        seen: list[str] = []
        sectioned = _section_groups([slide for slide in slides if slide.kind != "agenda"])
        for slide in slides:
            if slide.group in sectioned and slide.group not in seen and slide.kind != "agenda":
                seen.append(slide.group)
                result.append(
                    Slide(
                        kind="section",
                        ref=f"section:{slide.group}",
                        group=slide.group,
                        title=groups.get(slide.group, slide.group),
                        subtitle=f"{len(seen):02d}",
                    )
                )
            result.append(slide)
        slides = result
    return slides


def assign_layouts(slides: list[Slide], roles: dict[str, Any], layout_names: dict[str, str]) -> None:
    for slide in slides:
        role = ROLE_BY_KIND.get(slide.kind, "content")
        key = roles.get(role) or roles.get("content") or roles.get("title")
        slide.layout_key = key
        slide.layout_name = layout_names.get(key) if key else None


def relayout_edited_slide(slide: Slide, patterns, roles: dict, layouts: list, *, position: int = 0) -> None:
    """После правки моделью новый текст мог перестать помещаться в паттерн — тогда слайду подбирается другой.
    Остальные слайды колоды не менялись, их вёрстку не трогаем. Не вызывается, если паттерн выбрал пользователь."""
    names = {layout["key"]: layout["name"] for layout in layouts}
    assign_layouts([slide], roles, names)
    assign_patterns([slide], patterns, position=position, layout_names=names, keep=True)
