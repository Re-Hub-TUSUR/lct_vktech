"""Файловое хранилище: загруженные шаблоны и контент-пакеты (Docker-том /data)."""

import shutil
from pathlib import Path

from fastapi import HTTPException, UploadFile

from app.core.config import settings

CHUNK_SIZE = 1024 * 1024


def storage_path(*parts: str) -> Path:
    path = settings.storage_dir.joinpath(*parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


async def save_upload(upload: UploadFile, dest: Path, max_bytes: int | None = None) -> int:
    max_bytes = max_bytes or settings.max_upload_mb * 1024 * 1024
    size = 0
    try:
        with dest.open("wb") as fh:
            while chunk := await upload.read(CHUNK_SIZE):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(413, f"Файл «{upload.filename}» больше {max_bytes // CHUNK_SIZE} МБ")
                fh.write(chunk)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    return size


def _inside_storage(path: Path) -> bool:
    try:
        path.resolve().relative_to(settings.storage_dir.resolve())
    except ValueError:
        return False
    return True


def remove_file(path: str | Path | None) -> None:
    """Удаляет файл, только если он лежит в хранилище (встроенные шаблоны не трогаем)."""
    if not path:
        return
    path = Path(path)
    if _inside_storage(path):
        path.unlink(missing_ok=True)


def remove_dir(*parts: str) -> None:
    path = settings.storage_dir.joinpath(*parts)
    if _inside_storage(path):
        shutil.rmtree(path, ignore_errors=True)
