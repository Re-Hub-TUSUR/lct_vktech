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
    skills_dir: Path = BACKEND_DIR / "skills"
    max_upload_mb: int = 100

    # Множитель длительности стадий-заглушек пайплайна: 0 — без задержек, 1 — «реалистичный» темп.
    mock_speed: float = 1.0

    # Рендер .pptx → PDF через LibreOffice headless. Пусто — ищем soffice в PATH.
    soffice_path: str | None = None
    render_timeout_seconds: int = 180
    # Параллельных процессов LibreOffice на один процесс приложения (каждый — сотни МБ памяти).
    render_concurrency: int = 2

    # VLM для разметки паттернов слайдов: любой OpenAI-совместимый API (VK Inference с Qwen3.8-27B,
    # Yandex AI Studio, Cloud.ru Foundation Models, свой vLLM/SGLang). Пусто — только эвристики.
    vlm_base_url: str | None = None
    vlm_api_key: str | None = None
    vlm_model: str | None = None
    vlm_timeout_seconds: float = 90
    vlm_max_patterns: int = 40
    vlm_concurrency: int = 4


settings = Settings()
