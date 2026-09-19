"""Рендер собранного .pptx через LibreOffice headless.

PDF и HTML получаются из того же файла, что и экспорт в .pptx, поэтому совпадают
с ним один в один: фон, картинки, логотипы и декор мастеров и макетов шаблона
сохраняются. Раньше PDF рисовался с нуля по данным слайдов и терял оформление.
"""

import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from app.core.config import settings


class RenderError(RuntimeError):
    pass


_slots = threading.BoundedSemaphore(max(1, settings.render_concurrency))


def soffice_binary() -> str | None:
    if settings.soffice_path:
        return settings.soffice_path if Path(settings.soffice_path).exists() else None
    return shutil.which("soffice") or shutil.which("libreoffice")


def libreoffice_available() -> bool:
    return soffice_binary() is not None


def pptx_to_pdf(pptx: bytes) -> bytes:
    binary = soffice_binary()
    if binary is None:
        raise RenderError("LibreOffice не установлен — рендер .pptx недоступен")

    with _slots, tempfile.TemporaryDirectory(prefix="render-") as tmp:
        workdir = Path(tmp)
        source = workdir / "deck.pptx"
        source.write_bytes(pptx)
        command = [
            binary,
            "--headless",
            "--norestore",
            "--nolockcheck",
            "--nodefault",
            "--nologo",
            # Свой профиль на каждый вызов: несколько конвертаций не мешают друг другу.
            f"-env:UserInstallation={(workdir / 'profile').as_uri()}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(workdir),
            str(source),
        ]
        try:
            result = subprocess.run(command, capture_output=True, timeout=settings.render_timeout_seconds, check=False)
        except subprocess.TimeoutExpired as exc:
            raise RenderError(f"LibreOffice не уложился в {settings.render_timeout_seconds} с") from exc

        output = workdir / "deck.pdf"
        if result.returncode != 0 or not output.exists():
            details = (result.stderr or result.stdout).decode(errors="replace").strip()[:500]
            raise RenderError(f"LibreOffice не смог сконвертировать презентацию: {details or result.returncode}")
        return output.read_bytes()
