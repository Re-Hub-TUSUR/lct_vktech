"""Форматы шаблонов: всё приводится к обычному .pptx до разбора.

Корпоративные шаблоны часто приходят как .potx (шаблон PowerPoint), реже — .pptm/.potm
с макросами, .ppsx (демонстрация) или в старых форматах .ppt/.pot и OpenDocument .odp.
OOXML-варианты отличаются от .pptx только типом основной части пакета — его и меняем
(макросы при этом не выполняются и не нужны). Старые двоичные форматы и .odp
переводит в .pptx LibreOffice, который уже есть в образе для рендера.
"""

import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

from app.core.config import settings
from app.pipeline.export.render import RenderError, run_soffice, soffice_binary

PPTX_MAIN = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
# Основная часть пакета у «родственников» .pptx: шаблон, демонстрация и их версии с макросами.
OOXML_MAIN_TYPES = (
    "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
    "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
    "application/vnd.ms-powerpoint.template.macroEnabled.main+xml",
    "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml",
)
OOXML_EXTENSIONS = {".pptx", ".potx", ".pptm", ".potm", ".ppsx", ".ppsm"}
LEGACY_EXTENSIONS = {".ppt", ".pot", ".pps", ".odp", ".otp"}
TEMPLATE_EXTENSIONS = OOXML_EXTENSIONS | LEGACY_EXTENSIONS
# Части с макросами и их связи: в .pptx они не нужны и только путают PowerPoint.
VBA_RX = re.compile(r"(^|/)vbaProject(Signature)?\.bin$|(^|/)vbaData\.xml$", re.IGNORECASE)


class TemplateFormatError(ValueError):
    pass


def extensions_label() -> str:
    return ", ".join(sorted(TEMPLATE_EXTENSIONS))


def _rewrite_ooxml(source: Path, dest: Path) -> None:
    """Копия OOXML-пакета с типом основной части .pptx и без частей VBA."""
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
        for info in src.infolist():
            name = info.filename
            if VBA_RX.search(name):
                continue
            data = src.read(name)
            if name == "[Content_Types].xml":
                text = data.decode("utf-8")
                for content_type in OOXML_MAIN_TYPES:
                    text = text.replace(content_type, PPTX_MAIN)
                text = re.sub(r'<Override[^>]*PartName="[^"]*vbaProject[^"]*"[^>]*/>', "", text)
                text = re.sub(r'<Default[^>]*Extension="bin"[^>]*ContentType="application/vnd\.ms-office\.vbaProject"[^>]*/>', "", text)
                data = text.encode("utf-8")
            elif name.endswith(".rels"):
                text = data.decode("utf-8")
                text = re.sub(r"<Relationship[^>]*Target=\"[^\"]*vbaProject[^\"]*\"[^>]*/>", "", text)
                data = text.encode("utf-8")
            out.writestr(info, data)
    tmp.replace(dest)


def _convert_legacy(source: Path, dest: Path) -> None:
    binary = soffice_binary()
    if binary is None:
        raise TemplateFormatError(f"Для формата {source.suffix} нужен LibreOffice — загрузите шаблон как .pptx или .potx")
    with tempfile.TemporaryDirectory(prefix="convert-") as tmp:
        workdir = Path(tmp)
        copy = workdir / f"template{source.suffix.lower()}"
        shutil.copyfile(source, copy)
        command = [
            binary,
            "--headless",
            "--norestore",
            "--nolockcheck",
            f"-env:UserInstallation={(workdir / 'profile').as_uri()}",
            "--convert-to",
            "pptx",
            "--outdir",
            str(workdir),
            str(copy),
        ]
        try:
            run_soffice(command, settings.render_timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            raise TemplateFormatError("LibreOffice не успел сконвертировать шаблон") from exc
        result = workdir / "template.pptx"
        if not result.exists():
            raise TemplateFormatError(f"LibreOffice не смог сконвертировать {source.suffix} в .pptx")
        shutil.copyfile(result, dest)


def normalize_template(source: Path, dest: Path, extension: str | None = None) -> Path:
    """Приводит шаблон к .pptx и кладёт в dest. extension — исходное расширение, если source без него."""
    suffix = (extension or source.suffix).lower()
    if suffix not in TEMPLATE_EXTENSIONS:
        raise TemplateFormatError(f"Формат {suffix or '—'} не поддерживается. Подойдут: {extensions_label()}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        if suffix in LEGACY_EXTENSIONS:
            _convert_legacy(source, dest)
        elif suffix == ".pptx":
            if source.resolve() != dest.resolve():
                shutil.copyfile(source, dest)
        else:
            _rewrite_ooxml(source, dest)
    except (zipfile.BadZipFile, OSError, UnicodeDecodeError, RenderError) as exc:
        raise TemplateFormatError(f"Не удалось прочитать шаблон: {exc}") from exc
    return dest
