from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import FileResponse, Response

from app.services.fonts import face_by_key, font_css

# Без авторизации: браузер грузит шрифты из CSS (@font-face) без заголовков клиента, а отдаются
# только свободно установленные в образ файлы по непрозрачному ключу.
router = APIRouter(prefix="/fonts", tags=["fonts"])

MEDIA_TYPES = {".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2"}


@router.get("/css")
async def fonts_css(family: list[str] = Query(default=[], max_length=16)) -> Response:
    """@font-face для гарнитур шаблона — превью рисуется теми же файлами, что и рендер LibreOffice."""
    css = "\n".join(filter(None, (font_css(name.strip()) for name in dict.fromkeys(family))))
    return Response(css, media_type="text/css", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/files/{key}")
async def font_file(key: str) -> FileResponse:
    face = face_by_key(key)
    if face is None or not face.path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Шрифт не найден")
    return FileResponse(
        face.path,
        media_type=MEDIA_TYPES.get(face.path.suffix.lower(), "application/octet-stream"),
        headers={"Cache-Control": "public, max-age=2592000, immutable"},
    )
