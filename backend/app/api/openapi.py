"""Описание API для Swagger UI: разделы, сценарий работы, авторизация.

Живая документация — /api/docs на запущенном сервисе (запросы выполняются прямо из браузера).
Спецификация и статичная страница Swagger UI для репозитория выгружаются этим же модулем:

    docker compose run --rm -T backend python -m app.api.openapi json > docs/openapi.json
    docker compose run --rm -T backend python -m app.api.openapi html > docs/swagger.html
"""

import json
import sys
from typing import Any

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi

VERSION = "1.0.0"
DESCRIPTION = """\
REST API сервиса «Цифровой дизайнер презентаций»: разбор шаблона, генерация трёх вариантов колоды по брифу
и контент-пакету, аудит слайдов, правки и экспорт в .pptx, .pdf и .html. Устройство пайплайна — в
ARCHITECTURE.md репозитория.

**Авторизация.** Сессия хранится в httpOnly-cookie: если войти в приложение в этом же браузере, запросы
отсюда пойдут от вашего имени. Для скриптов `POST /api/auth/login` или `POST /api/auth/demo` (тестовый
эксперт, без пароля) возвращают токен — его передают в заголовке `Authorization: Bearer <token>`
(кнопка **Authorize**).

**Сценарий генерации:**

1. `POST /api/presentations` — презентация: шаблон, бриф, назначение, настройки генерации;
2. `POST /api/presentations/{presentation_id}/files` — контент-пакет (необязательно);
3. `POST /api/presentations/{presentation_id}/generate` — запуск пайплайна;
4. `GET /api/presentations/{presentation_id}/generation` — ход стадий (или поток событий
   `GET /api/presentations/{presentation_id}/events`);
5. `GET /api/presentations/{presentation_id}/variants` — три варианта вёрстки;
6. `GET /api/variants/{variant_id}/audit` и `POST /api/variants/{variant_id}/audit/resolve` — замечания
   аудита и их исправление;
7. `GET /api/variants/{variant_id}/export/{fmt}` — файл .pptx, .pdf или .html.
"""
TAGS: list[dict[str, str]] = [
    {"name": "meta", "description": "Служебное: здоровье сервиса, варианты настроек генерации, каталог скиллов и агентов с версиями."},
    {"name": "auth", "description": "Регистрация, вход, демо-вход тестового эксперта, выход, текущий пользователь."},
    {"name": "templates", "description": "Шаблоны: загрузка своего файла, результат декомпозиции — макеты, паттерны слайдов, токены дизайн-системы, рендеры, пиктограммы."},
    {"name": "presentations", "description": "Презентации: бриф и настройки, контент-пакет, запуск генерации и её ход, варианты, иллюстрации модели, выбор варианта."},
    {"name": "variants", "description": "Варианты вёрстки: слайды и их правка, рерол, аудит и исправления, правка слайда из чата, слайд по описанию, автоанимации, экспорт."},
    {"name": "skills", "description": "Пользовательские скиллы: библиотека с версиями и стандартные скиллы."},
    {"name": "collaboration", "description": "Студия: комментарии к слайдам и присутствие участников."},
    {"name": "sharing", "description": "Общий доступ к презентации: участники, роли, ссылки-приглашения."},
    {"name": "projects", "description": "Папки проектов и совместный доступ к ним."},
    {"name": "notifications", "description": "Уведомления пользователя."},
    {"name": "fonts", "description": "Шрифты шаблонов для превью в браузере — те же файлы, которыми LibreOffice рендерит слайды."},
]
SECURITY_SCHEME = {
    "type": "http",
    "scheme": "bearer",
    "description": "Токен сессии из POST /api/auth/login или /api/auth/demo. В браузере вместо него работает cookie сессии.",
}


def install_openapi(app: FastAPI) -> None:
    """Схема OpenAPI с разделами, сценарием и схемой авторизации (кнопка Authorize в Swagger UI)."""

    def schema() -> dict[str, Any]:
        if app.openapi_schema is None:
            document = get_openapi(
                title=app.title,
                version=VERSION,
                description=DESCRIPTION,
                routes=app.routes,
                tags=TAGS,
            )
            document.setdefault("components", {}).setdefault("securitySchemes", {})["session"] = SECURITY_SCHEME
            document["security"] = [{"session": []}]
            app.openapi_schema = document
        return app.openapi_schema

    app.openapi = schema


def static_spec(app: FastAPI) -> dict[str, Any]:
    """Спецификация для файла в репозитории: запросы из статичной страницы идут на локальный запуск."""
    document = json.loads(json.dumps(app.openapi()))
    document["servers"] = [{"url": "http://localhost:8080", "description": "локальный запуск: docker compose up"}]
    return document


SWAGGER_PAGE = """<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API · Цифровой дизайнер презентаций</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>body { margin: 0; background: #fafafa; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    // Спецификация встроена в страницу: она открывается из файла, без запущенного сервиса.
    const spec = __SPEC__;
    window.ui = SwaggerUIBundle({ spec, dom_id: "#swagger-ui", deepLinking: true, docExpansion: "none" });
  </script>
</body>
</html>
"""


def swagger_page(spec: dict[str, Any]) -> str:
    # «</» внутри строк JSON закрыл бы тег script раньше времени.
    payload = json.dumps(spec, ensure_ascii=False, indent=1).replace("</", "<\\/")
    return SWAGGER_PAGE.replace("__SPEC__", payload)


if __name__ == "__main__":
    from app.main import app as application

    spec = static_spec(application)
    mode = sys.argv[1] if len(sys.argv) > 1 else "json"
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write(swagger_page(spec) if mode == "html" else json.dumps(spec, ensure_ascii=False, indent=2) + "\n")
