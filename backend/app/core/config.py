from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Цифровой дизайнер презентаций"

    database_url: str = "postgresql+asyncpg://app:app@localhost:5432/slides"
    redis_url: str = "redis://localhost:6379/0"

    session_cookie_name: str = "session"
    session_ttl_hours: int = 24 * 7
    cookie_secure: bool = False
    demo_user_email: str = "demo.expert@vk.tech"
    demo_user_name: str = "Тестовый эксперт"

    storage_dir: Path = Path("/data")
    builtin_templates_dir: Path = Path("/builtin_templates")
    # Кэш разбора шаблонов контент-пакета (каталог cache/ репозитория): готовые паттерны и рендеры,
    # чтобы первый запуск не ждал LibreOffice и не тратил запросы к VLM. Нет каталога — нет кэша.
    template_cache_dir: Path | None = Path("/cache")
    skills_dir: Path = BACKEND_DIR / "skills"
    max_upload_mb: int = 100

    # Рендер .pptx → PDF через LibreOffice headless. Пусто — ищем soffice в PATH.
    soffice_path: str | None = None
    render_timeout_seconds: int = 420
    # Параллельных процессов LibreOffice на один процесс приложения (каждый — сотни МБ памяти).
    render_concurrency: int = 2

    # LLM для текстовых стадий: план колоды и тексты слайдов. Любой OpenAI-совместимый API,
    # модель с открытыми весами до 35B (по ТЗ). Пусто — колода собирается из тезисов брифа без модели.
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    llm_model: str | None = None
    llm_timeout_seconds: float = 180
    # Слайды пишутся параллельно: один запрос на слайд.
    llm_concurrency: int = 4
    llm_max_tokens: int = 1600
    # План всей колоды — длинный ответ: с тесным лимитом он обрывается на середине JSON.
    llm_plan_max_tokens: int = 4000
    llm_temperature: float = 0.3
    llm_disable_reasoning: bool = True
    llm_extra_body: str | None = None
    # Сколько знаков материалов контент-пакета уходит в промпт (на файл и всего).
    llm_source_chars: int = 4000
    llm_sources_total_chars: int = 12000

    # Модель аудита (судья): контекстуальные проверки по тексту колоды и по рендерам слайдов с картинками.
    # Отдельная роль, чтобы судью можно было сменить, не трогая генерацию; пустые поля берутся из LLM_*.
    # Модель должна понимать картинки (проверка «картинки относятся к теме» смотрит на рендер).
    audit_base_url: str | None = None
    audit_api_key: str | None = None
    audit_model: str | None = None
    audit_timeout_seconds: float = 180
    # Разбор всей колоды — длинный ответ: по строке вердиктов на каждый слайд.
    audit_max_tokens: int = 6000
    audit_concurrency: int = 6
    # Сколько стадия аудита генерации ждёт судью после рендера. Не успел — генерация завершается,
    # контекстуальные проверки показаны как «ждут», вердикты догоняют в фоновой задаче.
    audit_wait_seconds: float = 60

    # VLM для разметки паттернов слайдов: любой OpenAI-совместимый API (VK Inference с Qwen3.8-27B,
    # Yandex AI Studio, Cloud.ru Foundation Models, свой vLLM/SGLang). Пусто — только эвристики.
    vlm_base_url: str | None = None
    vlm_api_key: str | None = None
    vlm_model: str | None = None
    vlm_timeout_seconds: float = 90
    vlm_max_patterns: int = 60
    vlm_concurrency: int = 6
    vlm_max_tokens: int = 900
    # У гибридных моделей (Qwen3.x) рассуждения включены по умолчанию и съедают лимит ответа — выключаем.
    vlm_disable_reasoning: bool = True
    # Доп. поля запроса JSON-строкой, например для vLLM: {"chat_template_kwargs": {"enable_thinking": false}}.
    vlm_extra_body: str | None = None


settings = Settings()
