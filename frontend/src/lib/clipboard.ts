/**
 * Копирует текст в буфер обмена. navigator.clipboard есть только в безопасном контексте (https/localhost),
 * поэтому при его отсутствии или отказе используем старый execCommand через временное поле.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Падаем в запасной вариант ниже.
    }
  }

  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.top = '0'
  field.style.left = '0'
  field.style.opacity = '0'
  // Внутри открытой модалки поле должно лежать в ней, иначе фокус может не дойти до него.
  const host = document.activeElement?.closest('[role="dialog"]') ?? document.body
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  host.appendChild(field)
  field.focus()
  field.select()
  field.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } finally {
    field.remove()
    previousFocus?.focus()
  }
  if (!ok) throw new Error('Не удалось скопировать')
}
