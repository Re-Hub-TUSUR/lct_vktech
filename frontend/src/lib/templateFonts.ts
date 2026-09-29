// Гарнитуры шаблона в браузере. Шрифты интерфейса (VK Sans Display, Inter) лежат в проекте, а гарнитур
// шаблонов (Play, Montserrat, Lato Light…) у пользователя обычно нет — без них превью молча рисуется шрифтом
// интерфейса. Бэкенд отдаёт @font-face теми же файлами, которыми LibreOffice рендерит слайды
// (backend/app/services/fonts.py), поэтому превью совпадает с рендером и .pptx, включая жирные начертания.

// Шрифты, подключённые в styles/fonts.css, — их начертания уже объявлены.
const BUNDLED = new Set(['vk sans display', 'inter'])
const requested = new Set<string>()

/** Подключает @font-face для гарнитур (один <link> на гарнитуру, повторные вызовы ничего не делают). */
export function ensureFonts(names: Array<string | null | undefined>): void {
  if (typeof document === 'undefined') return
  for (const raw of names) {
    const name = raw?.trim()
    const key = name?.toLowerCase()
    if (!name || !key || BUNDLED.has(key) || requested.has(key)) continue
    requested.add(key)
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = `/api/fonts/css?family=${encodeURIComponent(name)}`
    link.dataset.templateFont = name
    document.head.appendChild(link)
  }
}
