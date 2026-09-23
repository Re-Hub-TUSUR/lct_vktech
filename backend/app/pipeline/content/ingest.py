"""Извлечение текста из файлов контент-пакета, выдержки для модели и разбиение брифа на тезисы."""

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


def sources_digest(files: list[tuple[str, str]], *, per_file: int, total: int) -> str:
    """Материалы для промпта: имя файла и выдержка из его текста.

    Целиком контент-пакет в запрос не влезет и не нужен: модели хватает начала каждого
    файла, где обычно и лежат цифры и тезисы. Границы заданы LLM_SOURCE_CHARS и
    LLM_SOURCES_TOTAL_CHARS, обрезка отмечается явно — чтобы модель не додумывала хвост."""
    blocks: list[str] = []
    left = total
    for filename, text in files:
        text = re.sub(r"[ \t]+", " ", re.sub(r"\n{3,}", "\n\n", (text or "").strip()))
        if not text or left <= 0:
            continue
        limit = min(per_file, left)
        excerpt = text[:limit]
        if len(text) > limit:
            excerpt += "\n[…документ обрезан…]"
        left -= len(excerpt)
        blocks.append(f"### {filename}\n{excerpt}")
    return "\n\n".join(blocks)


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
