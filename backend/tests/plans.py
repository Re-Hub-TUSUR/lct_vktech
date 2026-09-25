"""План колоды для тестов вёрстки — в том виде, в каком его отдают модель и автор текстов
(planning/planner.py и writer.py): тезисы, карточки, колонки, числа, этапы."""

import copy

CARDS = [
    {"title": "Восемь часов", "text": "Столько уходит на одну колоду"},
    {"title": "Круги правок", "text": "Правки текста и вёрстки идут по очереди"},
    {"title": "Мимо бренда", "text": "Слайды расходятся с шаблоном"},
]
COLUMNS = [
    {"title": "Как сейчас", "bullets": ["Верстают руками", "Правят по кругу"]},
    {"title": "С сервисом", "bullets": ["Колода по шаблону", "Аудит до показа"]},
]
# План колоды в том виде, в каком его отдают модель и автор текстов (planning/planner.py и writer.py).
PLAN = [
    {"ref": "cover", "kind": "title", "plan_kind": "title", "priority": 1, "topic": "Цифровой дизайнер презентаций",
     "subtitle": "Презентации в фирменном стиле за минуты"},
    {"ref": "problem", "kind": "bullets", "flexible": True, "plan_kind": "cards", "group": "problem", "priority": 1,
     "topic": "Проблема", "insight": "Ручная вёрстка съедает часы команды",
     "bullets": ["Колода готовится восемь часов", "Правки идут по кругу", "Слайды расходятся с брендбуком"],
     "cards": CARDS, "columns": COLUMNS},
    {"ref": "solution", "kind": "bullets", "flexible": True, "plan_kind": "text", "group": "solution", "priority": 1,
     "topic": "Решение", "insight": "Сервис собирает колоду по шаблону компании",
     "bullets": ["Шаблон разбирается автоматически", "Модель пишет тексты слайдов", "Аудит проверяет 34 параметра"],
     "cards": CARDS, "columns": COLUMNS},
    {"ref": "effect", "kind": "data", "plan_kind": "data", "group": "results", "priority": 1,
     "topic": "Эффект", "insight": "Подготовка колоды ускоряется в десятки раз",
     "data": {"caption": "Время подготовки колоды", "unit": "мин", "chart_type": "bar",
              "categories": ["Вручную", "С сервисом"], "key": "С сервисом",
              "series": [{"name": "Минуты", "values": [480.0, 5.0]}],
              "kpis": [{"value": "×96", "label": "быстрее"}, {"value": "5 мин", "label": "на колоду"}],
              "table": {"columns": ["Показатель", "Минуты"], "rows": [["Вручную", "480"], ["С сервисом", "5"]]}}},
    {"ref": "plan", "kind": "timeline", "plan_kind": "timeline", "group": "plan", "priority": 2,
     "topic": "План", "insight": "Пилот займёт квартал",
     "timeline": [{"date": "Q1 2026", "title": "Пилот", "text": "Две команды"},
                  {"date": "Q2 2026", "title": "Запуск", "text": "Все отделы"}]},
    {"ref": "closing", "kind": "closing", "plan_kind": "closing", "priority": 1, "topic": "Спасибо",
     "subtitle": "Запустим пилот"},
]


def plan() -> list[dict]:
    return copy.deepcopy(PLAN)
