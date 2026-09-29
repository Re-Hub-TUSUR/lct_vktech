"""Шрифты для превью в браузере — те же файлы, которыми LibreOffice рендерит слайды (fontconfig).

Без этого браузер рисует гарнитуру шаблона только если она установлена у пользователя, иначе молча
подставляет шрифт интерфейса: превью расходится с рендером и .pptx. Здесь гарнитура шаблона превращается
в @font-face: своими файлами, если шрифт есть в образе, иначе файлами той замены, которую выберет LibreOffice
(Arial → Liberation Sans, Calibri → Carlito). Каждое начертание объявлено с настоящей жирностью —
жирный текст рисуется жирным файлом, а не обычным под видом жирного.
"""

import hashlib
import re
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

# Жирность fontconfig → CSS (FC_WEIGHT_*).
_FC_WEIGHTS = [(0, 100), (40, 200), (50, 300), (55, 350), (75, 400), (80, 400), (100, 500), (180, 600), (200, 700), (205, 800), (210, 900)]
_FORMAT = "%{file}\\t%{family}\\t%{style}\\t%{weight}\\t%{slant}\\t%{index}\\n"
_FORMATS = [".woff2", ".woff", ".otf", ".ttf"]
_SAFE_NAME = re.compile(r"^[\w .\-+]{1,80}$", re.UNICODE)


@dataclass(frozen=True)
class Face:
    path: Path
    families: tuple[str, ...]
    styles: tuple[str, ...]
    weight: str  # CSS: «400» или диапазон вариативного шрифта «100 900»
    italic: bool

    @property
    def key(self) -> str:
        return hashlib.sha1(str(self.path).encode()).hexdigest()[:16] + self.path.suffix.lower()


def _css_weight(value: float) -> int:
    return min(_FC_WEIGHTS, key=lambda pair: abs(pair[0] - value))[1]


def _parse_weight(raw: str) -> str | None:
    numbers = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", raw)]
    if not numbers:
        return None
    if len(numbers) >= 2 and numbers[0] != numbers[1]:
        return f"{_css_weight(numbers[0])} {_css_weight(numbers[1])}"
    return str(_css_weight(numbers[0]))


@lru_cache(maxsize=1)
def installed_faces() -> tuple[Face, ...]:
    """Все начертания из fontconfig. Шрифты образа не меняются, пока он работает, — список кэшируется."""
    binary = shutil.which("fc-list")
    if binary is None:
        return ()
    try:
        output = subprocess.run([binary, "--format", _FORMAT], capture_output=True, text=True, timeout=20, check=False).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ()
    faces = []
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) != 6:
            continue
        file, family, style, weight, slant, index = parts
        path = Path(file)
        # Именованные экземпляры вариативного шрифта: браузер берёт файл целиком, хватает записи с диапазоном.
        if not index.isdigit() or int(index) >= 1 << 16 or path.suffix.lower() not in _FORMATS:
            continue
        css_weight = _parse_weight(weight)
        if css_weight is None:
            continue
        faces.append(
            Face(
                path=path,
                families=tuple(name.strip() for name in family.split(",") if name.strip()),
                styles=tuple(name.strip() for name in style.split(",") if name.strip()),
                weight=css_weight,
                italic=slant.strip() not in {"", "0"},
            )
        )
    return tuple(faces)


def face_by_key(key: str) -> Face | None:
    return next((face for face in installed_faces() if face.key == key), None)


def _faces_of(family: str) -> list[tuple[Face, str, bool]]:
    """Начертания гарнитуры: (файл, CSS-жирность, курсив). Учитывает «старые» имена семейств вроде
    «Montserrat Medium» или «Lato Light»: у них есть только обычное и жирное начертание — как в PowerPoint."""
    wanted = family.casefold()
    found: dict[tuple[str, bool], tuple[Face, str, bool]] = {}
    # Одно начертание бывает в нескольких форматах (fonts-montserrat) — браузеру отдаём самый компактный.
    for face in sorted(installed_faces(), key=lambda face: _FORMATS.index(face.path.suffix.lower())):
        names = [name.casefold() for name in face.families]
        if wanted not in names:
            continue
        i = names.index(wanted)
        if i == 0:
            weight, italic = face.weight, face.italic
        else:
            style = (face.styles[i] if len(face.styles) == len(face.families) else face.styles[0] if face.styles else "").casefold()
            weight = "700" if "bold" in style else "400"
            italic = "italic" in style or "oblique" in style
        found.setdefault((weight, italic), (face, weight, italic))
    return list(found.values())


def _substitute(family: str) -> str | None:
    """Гарнитура, которую fontconfig (а значит, и LibreOffice при рендере) подставит вместо недостающей."""
    binary = shutil.which("fc-match")
    if binary is None:
        return None
    try:
        matched = subprocess.run([binary, "-f", "%{family[0]}", family], capture_output=True, text=True, timeout=5, check=False).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    return matched.strip() or None


def _local_name(family: str, weight: str, italic: bool) -> str:
    style = " ".join(part for part in ("Bold" if int(weight.split()[0]) >= 600 else "", "Italic" if italic else "") if part)
    return f"{family} {style}".strip()


@lru_cache(maxsize=256)
def font_css(family: str) -> str:
    """@font-face гарнитуры для браузера; пустая строка — нечем отрисовать."""
    if not _SAFE_NAME.match(family):
        return ""
    faces = _faces_of(family)
    substitute = False
    if not faces:
        replacement = _substitute(family)
        faces = _faces_of(replacement) if replacement else []
        substitute = True
    rules = []
    quoted = family.replace("\\", "").replace("'", "")
    for face, weight, italic in faces:
        src = f"url('/api/fonts/files/{face.key}')"
        if substitute:
            # Настоящий шрифт у пользователя в системе точнее замены; local() — по полному имени начертания,
            # иначе жирное начертание получило бы обычный файл и жирный текст выглядел бы обычным.
            src = f"local('{_local_name(quoted, weight, italic)}'), {src}"
        rules.append(
            "@font-face {"
            f" font-family: '{quoted}'; font-style: {'italic' if italic else 'normal'}; font-weight: {weight};"
            f" font-display: swap; src: {src}; }}"
        )
    return "\n".join(rules)
