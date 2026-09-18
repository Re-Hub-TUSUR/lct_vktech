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

    storage_dir: Path = Path("/data")
    builtin_templates_dir: Path = Path("/builtin_templates")
    skills_dir: Path = BACKEND_DIR / "skills"
    max_upload_mb: int = 100

    # Множитель длительности стадий-заглушек пайплайна: 0 — без задержек, 1 — «реалистичный» темп.
    mock_speed: float = 1.0


settings = Settings()
