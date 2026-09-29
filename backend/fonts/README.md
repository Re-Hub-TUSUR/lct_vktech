# Шрифты для рендера шаблонов и превью

LibreOffice рендерит .pptx в PDF и фоны макетов. Если шрифта из шаблона нет в системе,
он подставляет похожий, и вёрстка может немного сдвинуться. Эти же шрифты бэкенд отдаёт браузеру
(`/api/fonts/css?family=…`), поэтому превью в редакторе рисуется теми же файлами, что и рендер.

Уже есть:
- здесь: Play (шаблоны VK) и Poppins, лицензия SIL OFL (`OFL-*.txt`);
- в образе из Debian: Montserrat, Lato, Open Sans, Roboto, PT Sans/Serif, Inter,
  а также метрические замены Arial/Calibri/Cambria (Liberation, Carlito, Caladea).

Положите сюда `.ttf` или `.otf` других фирменных шрифтов (например, VK Sans Display),
лицензия которых допускает распространение, и пересоберите образ:
`docker compose up --build`. Файлы копируются в `/usr/local/share/fonts/templates/`.

Встроенные в .pptx шрифты (`ppt/fonts/*.fntdata`) хранятся в сжатом формате EOT/MicroType Express
и LibreOffice в Debian их не читает — поэтому шрифты нужно добавить отдельно.
