"""Рендер собранного .pptx через LibreOffice headless.

PDF и HTML получаются из того же файла, что и экспорт в .pptx, поэтому совпадают
с ним один в один: фон, картинки, логотипы и декор мастеров и макетов шаблона
сохраняются. Раньше PDF рисовался с нуля по данным слайдов и терял оформление.
"""

import os
import shutil
import signal
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


def run_soffice(command: list[str], timeout: float) -> subprocess.CompletedProcess:
    """Запуск LibreOffice с гарантированной остановкой по таймауту.

    soffice — обёртка, настоящая работа идёт в дочернем soffice.bin. subprocess.run при
    таймауте убивает только обёртку, а soffice.bin продолжает конвертировать ещё минуты и
    отнимает процессор и память у следующих рендеров. Поэтому процесс запускается в своей
    группе, и по таймауту убивается вся группа."""
    posix = os.name == "posix"
    process = subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=posix
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        if posix:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        process.communicate()
        raise
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


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
            result = run_soffice(command, settings.render_timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            raise RenderError(f"LibreOffice не уложился в {settings.render_timeout_seconds} с") from exc

        output = workdir / "deck.pdf"
        if result.returncode != 0 or not output.exists():
            details = (result.stderr or result.stdout).decode(errors="replace").strip()[:500]
            raise RenderError(f"LibreOffice не смог сконвертировать презентацию: {details or result.returncode}")
        return output.read_bytes()
