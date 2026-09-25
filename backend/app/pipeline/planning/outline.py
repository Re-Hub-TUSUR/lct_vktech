"""Структура колоды без модели — запасной путь, когда LLM не подключена или не ответила.

Колода собирается только из того, что дал пользователь: название, назначение и тезисы брифа.
Ничего не придумывается — ни фактов, ни цифр: тезисы раскладываются по слайдам как есть
(первый тезис группы становится заголовком, остальные — пунктами), обложка и финал служебные.
Контракт тот же, что у плана от модели (planning/planner.py): список «спецификаций слайдов».
"""

from typing import Any

from app.pipeline.content.ingest import split_sentences
from app.pipeline.skills import get_skill

# Столько тезисов брифа ложится на один слайд: заголовок и до трёх пунктов.
THESES_PER_SLIDE = 4
TITLE_WORDS = 10


def _shorten(text: str, max_words: int) -> str:
    words = text.split()
    return text if len(words) <= max_words else " ".join(words[:max_words]) + "…"


def purpose_label(purpose: str) -> str:
    purposes = get_skill("outline_planner").params.get("purposes") or {}
    return (purposes.get(purpose) or {}).get("label", purpose)


def group_labels() -> dict[str, str]:
    return dict(get_skill("outline_planner").params.get("groups") or {})


def build_outline(*, title: str, purpose: str, brief: str) -> list[dict[str, Any]]:
    purpose_cfg = (get_skill("outline_planner").params.get("purposes") or {}).get(purpose) or {}
    theses = split_sentences(brief)
    specs: list[dict[str, Any]] = [
        {
            "ref": "cover",
            "kind": "title",
            "priority": 1,
            "topic": title.strip() or "Новая презентация",
            "subtitle": _shorten(theses[0], 16) if theses else purpose_cfg.get("subtitle", ""),
        }
    ]
    body = theses[1:] if len(theses) > 1 else theses
    for number, start in enumerate(range(0, len(body), THESES_PER_SLIDE), start=1):
        chunk = body[start : start + THESES_PER_SLIDE]
        specs.append(
            {
                "ref": f"brief_{number}",
                "kind": "bullets",
                "priority": 1 if number == 1 else 2,
                "topic": _shorten(chunk[0], TITLE_WORDS),
                "insight": _shorten(chunk[0], TITLE_WORDS),
                # Тезис-заголовок не повторяется пунктом, если есть другие тезисы.
                "bullets": chunk[1:] or chunk,
            }
        )
    specs.append({"ref": "closing", "kind": "closing", "priority": 1, "topic": "Спасибо", "subtitle": "Вопросы и обсуждение"})
    return specs
