"""Извлечение текста из файлов контент-пакета и разбиение брифа на тезисы."""

import logging
import re
import zipfile
from pathlib import Path

import pymupdf
from lxml import etree
from pptx import Presentation

logger = logging.getLogger(__name__)

NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_XML_PARSER = etree.XMLParser(resolve_entities=False, no_network=True)


def extract_text(path: Path, filename: str) -> str | None:
    """Текст файла или None, если формат пока не поддержан (xlsx, json — следующий шаг)."""
    ext = Path(filename).suffix.lower()
    try:
        if ext in {".txt", ".md", ".csv"}:
            return _read_text(path)
        if ext == ".pdf":
            with pymupdf.open(path) as doc:
                return "\n".join(page.get_text() for page in doc)
        if ext == ".docx":
            return _docx_text(path)
        if ext == ".pptx":
            return _pptx_text(path)
    except Exception:
        logger.exception("Не удалось извлечь текст из %s", filename)
    return None


def _read_text(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "cp1251"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _docx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as zf:
        root = etree.fromstring(zf.read("word/document.xml"), _XML_PARSER)
    paragraphs = ("".join(t.text or "" for t in p.iter(f"{{{NS_W}}}t")) for p in root.iter(f"{{{NS_W}}}p"))
    return "\n".join(p for p in paragraphs if p.strip())


def _pptx_text(path: Path) -> str:
    lines = []
    for slide in Presentation(str(path)).slides:
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                lines.append(shape.text_frame.text.strip())
    return "\n".join(lines)


def split_sentences(text: str, limit: int = 12) -> list[str]:
    """Делит бриф на тезисы: по предложениям и строкам (в том числе маркированным)."""
    theses: list[str] = []
    for part in re.split(r"(?<=[.!?…])\s+|\n+", text or ""):
        thesis = part.strip().lstrip("-•*—–·").strip().rstrip(".")
        if len(thesis.split()) >= 3:
            theses.append(thesis)
        if len(theses) >= limit:
            break
    return theses
