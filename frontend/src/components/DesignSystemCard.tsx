import type { TemplateDetail } from '../api/types'
import { Badge, Card } from './ui'

// Токены дизайн-системы шаблона сверх палитры и шрифтов: типографика по ролям, сетка,
// колонтитулы и логотипы, стиль таблиц и диаграмм, доступность шрифтов, пиктограммы.

const ROLE_NAMES: Record<string, string> = {
  title: 'Заголовок',
  subtitle: 'Подзаголовок',
  body: 'Текст',
  body_2: 'Текст, 2-й уровень',
  body_3: 'Текст, 3-й уровень',
  caption: 'Подпись',
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 1000) / 10}%`
}

export function DesignSystemCard({ template }: { template: TemplateDetail }) {
  const { typography, grid, chrome, table_style: tableStyle, chart_style: chartStyle, fonts_check: fonts, icons } =
    template.tokens
  const missing = (fonts ?? []).filter((font) => !font.available)
  if (!typography && !grid && !chrome && !tableStyle && !chartStyle && !fonts && !icons?.length) return null

  return (
    <Card>
      <h2>Дизайн-система</h2>
      <p className="muted">
        Токены, по которым собираются новые слайды: кегли ролей текста, поля и сетка, колонтитулы, стиль таблиц и
        диаграмм шаблона.
      </p>

      {missing.length > 0 && (
        <p className="design-warning">
          Шрифты не установлены для рендера: {missing.map((font) => `${font.name} → ${font.substitute ?? 'замена'}`).join(', ')}.
          Превью и PDF будут с заменой; положите файлы шрифтов в backend/fonts/.
        </p>
      )}

      <div className="design-grid">
        {typography && (
          <section>
            <h3>Типографика</h3>
            <table className="data-table">
              <tbody>
                {Object.entries(typography).map(([role, style]) => (
                  <tr key={role}>
                    <td>{ROLE_NAMES[role] ?? role}</td>
                    <td style={{ fontFamily: style.font ? `"${style.font}", var(--font-sans)` : undefined }}>
                      {style.font ?? '—'}
                    </td>
                    <td>{style.size_pt ? `${style.size_pt} pt` : '—'}</td>
                    <td>{style.bold ? 'жирный' : ''}</td>
                    <td>{style.color && <span className="dot" style={{ background: style.color }} title={style.color} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {grid && (
          <section>
            <h3>Сетка</h3>
            <dl className="roles">
              <div>
                <dt>Поля (слева, справа, сверху, снизу)</dt>
                <dd>
                  {percent(grid.margins.left)} · {percent(grid.margins.right)} · {percent(grid.margins.top)} ·{' '}
                  {percent(grid.margins.bottom)}
                </dd>
              </div>
              <div>
                <dt>Направляющие PowerPoint</dt>
                <dd>
                  {grid.guides.vertical.length} вертикальных, {grid.guides.horizontal.length} горизонтальных
                </dd>
              </div>
              <div>
                <dt>Линии колонок</dt>
                <dd>{grid.columns.length ? grid.columns.map((edge) => percent(edge)).join(', ') : '—'}</dd>
              </div>
            </dl>
          </section>
        )}

        {chrome && (
          <section>
            <h3>Колонтитулы и логотипы</h3>
            <dl className="roles">
              <div>
                <dt>Номер слайда</dt>
                <dd>{chrome.slide_number ? 'переносится на новые слайды' : 'шаблон не ставит'}</dd>
              </div>
              <div>
                <dt>Колонтитул</dt>
                <dd>{chrome.footer_text ?? '—'}</dd>
              </div>
              <div>
                <dt>Логотипы</dt>
                <dd>{chrome.logos.length ? `${chrome.logos.length} (мастер, макеты или повтор на слайдах)` : '—'}</dd>
              </div>
            </dl>
          </section>
        )}

        {(tableStyle || chartStyle) && (
          <section>
            <h3>Таблицы и диаграммы</h3>
            <dl className="roles">
              {tableStyle && (
                <div>
                  <dt>Стиль таблиц</dt>
                  <dd>
                    {tableStyle.style_id ? 'свой стиль шаблона' : 'по заливкам примеров'}
                    {tableStyle.header_fill && <span className="dot" style={{ background: tableStyle.header_fill }} />}
                    {tableStyle.font_size_pt ? ` · ${tableStyle.font_size_pt} pt` : ''}
                  </dd>
                </div>
              )}
              {chartStyle && (
                <div>
                  <dt>Цвета рядов диаграмм</dt>
                  <dd>
                    {chartStyle.series_colors.length
                      ? chartStyle.series_colors.map((color) => (
                          <span key={color} className="dot" style={{ background: color }} title={color} />
                        ))
                      : '—'}
                  </dd>
                </div>
              )}
            </dl>
          </section>
        )}
      </div>

      {icons && icons.length > 0 && (
        <section className="stack">
          <h3>
            Пиктограммы шаблона <Badge>{icons.length}</Badge>
          </h3>
          <div className="icon-grid">
            {icons.slice(0, 48).map((icon) => (
              <img
                key={icon.id}
                src={`/api/templates/${template.id}/icons/${icon.file}`}
                alt=""
                loading="lazy"
                title={`Слайд ${icon.slide_index + 1}`}
              />
            ))}
          </div>
        </section>
      )}
    </Card>
  )
}
