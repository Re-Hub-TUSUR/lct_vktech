FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Зеркало Debian: из России deb.debian.org (CDN Fastly) часто обрывает загрузку больших пакетов.
# Другое зеркало: docker compose build --build-arg DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_MIRROR=http://mirror.yandex.ru/debian

# LibreOffice (без GUI) рендерит .pptx в PDF и фоны макетов шаблона.
# Шрифты с метриками Arial/Calibri/Cambria и кириллицей — чтобы вёрстка при рендере не «плыла»,
# и частые в шаблонах свободные гарнитуры (Montserrat, Lato, Open Sans, Roboto, PT, Inter). Эти же файлы
# бэкенд отдаёт браузеру (/api/fonts), так что превью в редакторе рисуется теми же шрифтами, что и рендер.
RUN sed -i "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        libreoffice-impress-nogui \
        fonts-liberation \
        fonts-crosextra-carlito \
        fonts-crosextra-caladea \
        fonts-dejavu-core \
        fonts-montserrat \
        fonts-lato \
        fonts-open-sans \
        fonts-roboto-unhinted \
        fonts-paratype \
        fonts-inter \
        fontconfig \
    && rm -rf /var/lib/apt/lists/*

# Фирменные шрифты шаблонов, которых нет в Debian (Play, Poppins; VK Sans и т. п. — положите .ttf/.otf в backend/fonts/).
COPY fonts/ /usr/local/share/fonts/templates/
RUN fc-cache -f

WORKDIR /app

COPY requirements.txt requirements-dev.txt ./
RUN pip install -r requirements.txt -r requirements-dev.txt

COPY . .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
