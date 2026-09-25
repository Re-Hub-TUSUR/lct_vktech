import type { ChartData } from '../../api/types'

const W = 800
const H = 360
const PAD = { left: 60, right: 20, top: 32, bottom: 44 }

function fmt(value: number): string {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })
}

// Ключевая категория (highlight) — цветом ряда, остальные столбцы приглушены, как в собранном .pptx.
function barOpacity(chart: ChartData, category: number): number {
  const key = chart.highlight
  return key != null && chart.series.length === 1 && category !== key ? 0.38 : 1
}

export function SlideChart({ chart, colors: defaultColors }: { chart: ChartData; colors: string[] }) {
  const colors = chart.colors && chart.colors.length > 0 ? chart.colors : defaultColors
  const showValues = chart.show_values !== false
  const showLegend = chart.show_legend !== false

  if (chart.type === 'pie') {
    return <PieChart chart={chart} colors={colors} showValues={showValues} showLegend={showLegend} />
  }

  if (chart.type === 'donut') {
    return <DonutChart chart={chart} colors={colors} showValues={showValues} showLegend={showLegend} />
  }

  if (chart.type === 'horizontal_bar') {
    return <HorizontalBarChart chart={chart} colors={colors} showValues={showValues} showLegend={showLegend} />
  }

  const values = chart.series.flatMap((s) => s.values)
  const top = Math.max(...values, 0) || 1
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const baseY = PAD.top + plotH
  const groupW = plotW / Math.max(chart.categories.length, 1)

  return (
    <svg className="slide-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.caption ?? 'Диаграмма'}>
      {[0.25, 0.5, 0.75, 1].map((t) => (
        <line
          key={t}
          x1={PAD.left}
          x2={W - PAD.right}
          y1={baseY - plotH * t}
          y2={baseY - plotH * t}
          className="slide-chart__grid"
        />
      ))}
      <line x1={PAD.left} x2={W - PAD.right} y1={baseY} y2={baseY} className="slide-chart__axis" />
      {chart.unit && (
        <text x={4} y={16} className="slide-chart__unit">
          {chart.unit}
        </text>
      )}
      {chart.categories.map((category, ci) => (
        <text
          key={category + ci}
          x={PAD.left + groupW * (ci + 0.5)}
          y={baseY + 28}
          textAnchor="middle"
          className="slide-chart__label"
        >
          {category}
        </text>
      ))}

      {chart.type === 'line'
        ? chart.series.map((series, si) => {
            const color = colors[si % colors.length]
            const points = series.values.map(
              (v, i) => [PAD.left + groupW * (i + 0.5), baseY - (plotH * Math.max(v, 0)) / top] as const
            )
            return (
              <g key={series.name + si}>
                <polyline
                  points={points.map((p) => p.join(',')).join(' ')}
                  fill="none"
                  stroke={color}
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {points.map(([x, y], i) => (
                  <g key={i}>
                    <circle cx={x} cy={y} r={6} fill={color} stroke="#FFFFFF" strokeWidth={2} />
                    {showValues && (
                      <text x={x} y={y - 12} textAnchor="middle" className="slide-chart__value">
                        {fmt(series.values[i])}
                      </text>
                    )}
                  </g>
                ))}
              </g>
            )
          })
        : chart.series.map((series, si) => {
            const barW = (groupW * 0.7) / Math.max(chart.series.length, 1)
            return series.values.map((v, ci) => {
              const h = (plotH * Math.max(v, 0)) / top
              const x = PAD.left + groupW * ci + groupW * 0.15 + barW * si
              return (
                <g key={`${si}-${ci}`}>
                  <rect
                    x={x}
                    y={baseY - h}
                    width={barW}
                    height={h}
                    rx={4}
                    fill={colors[si % colors.length]}
                    fillOpacity={barOpacity(chart, ci)}
                  />
                  {showValues && (
                    <text x={x + barW / 2} y={baseY - h - 8} textAnchor="middle" className="slide-chart__value">
                      {fmt(v)}
                    </text>
                  )}
                </g>
              )
            })
          })}

      {showLegend &&
        chart.series.length > 1 &&
        chart.series.map((series, si) => (
          <g key={`legend-${si}`} transform={`translate(${W - PAD.right - 170}, ${8 + si * 22})`}>
            <rect width={14} height={14} rx={3} fill={colors[si % colors.length]} />
            <text x={20} y={12} className="slide-chart__label">
              {series.name}
            </text>
          </g>
        ))}
    </svg>
  )
}

function HorizontalBarChart({
  chart,
  colors,
  showValues,
  showLegend,
}: {
  chart: ChartData
  colors: string[]
  showValues: boolean
  showLegend: boolean
}) {
  const values = chart.series.flatMap((s) => s.values)
  const top = Math.max(...values, 0) || 1
  const hPad = { left: 160, right: 60, top: 24, bottom: 24 }
  const plotW = W - hPad.left - hPad.right
  const plotH = H - hPad.top - hPad.bottom
  const catCount = Math.max(chart.categories.length, 1)
  const rowH = plotH / catCount

  return (
    <svg className="slide-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.caption ?? 'Диаграмма'}>
      {[0.25, 0.5, 0.75, 1].map((t) => (
        <line
          key={t}
          x1={hPad.left + plotW * t}
          x2={hPad.left + plotW * t}
          y1={hPad.top}
          y2={hPad.top + plotH}
          className="slide-chart__grid"
        />
      ))}
      <line x1={hPad.left} x2={hPad.left} y1={hPad.top} y2={hPad.top + plotH} className="slide-chart__axis" />
      {chart.unit && (
        <text x={hPad.left} y={16} className="slide-chart__unit">
          {chart.unit}
        </text>
      )}

      {chart.categories.map((cat, ci) => {
        const yCenter = hPad.top + rowH * (ci + 0.5)
        return (
          <text
            key={cat + ci}
            x={hPad.left - 12}
            y={yCenter + 5}
            textAnchor="end"
            className="slide-chart__label"
            style={{ fontWeight: 600 }}
          >
            {cat}
          </text>
        )
      })}

      {chart.series.map((series, si) => {
        const barH = (rowH * 0.7) / Math.max(chart.series.length, 1)
        return series.values.map((v, ci) => {
          const w = (plotW * Math.max(v, 0)) / top
          const y = hPad.top + rowH * ci + rowH * 0.15 + barH * si
          return (
            <g key={`${si}-${ci}`}>
              <rect
                x={hPad.left}
                y={y}
                width={Math.max(w, 2)}
                height={barH}
                rx={4}
                fill={colors[si % colors.length]}
                fillOpacity={barOpacity(chart, ci)}
              />
              {showValues && (
                <text x={hPad.left + w + 8} y={y + barH / 2 + 5} textAnchor="start" className="slide-chart__value">
                  {fmt(v)}
                </text>
              )}
            </g>
          )
        })
      })}

      {showLegend &&
        chart.series.length > 1 &&
        chart.series.map((series, si) => (
          <g key={`legend-${si}`} transform={`translate(${W - hPad.right - 150}, ${8 + si * 22})`}>
            <rect width={14} height={14} rx={3} fill={colors[si % colors.length]} />
            <text x={20} y={12} className="slide-chart__label">
              {series.name}
            </text>
          </g>
        ))}
    </svg>
  )
}

function PieChart({
  chart,
  colors,
  showValues,
  showLegend,
}: {
  chart: ChartData
  colors: string[]
  showValues: boolean
  showLegend: boolean
}) {
  const values = chart.series[0]?.values ?? []
  const total = values.reduce((sum, v) => sum + Math.max(v, 0), 0) || 1
  const cx = H / 2
  const cy = H / 2
  const r = H / 2 - 20
  let angle = -Math.PI / 2

  return (
    <svg className="slide-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.caption ?? 'Диаграмма'}>
      {values.map((v, i) => {
        const sweep = (2 * Math.PI * Math.max(v, 0)) / total
        const x1 = cx + r * Math.cos(angle)
        const y1 = cy + r * Math.sin(angle)
        angle += sweep
        const x2 = cx + r * Math.cos(angle)
        const y2 = cy + r * Math.sin(angle)
        const large = sweep > Math.PI ? 1 : 0
        return (
          <path
            key={i}
            d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`}
            fill={colors[i % colors.length]}
            stroke="var(--slide-bg)"
            strokeWidth={2}
          />
        )
      })}
      {showLegend &&
        values.map((v, i) => (
          <g key={`legend-${i}`} transform={`translate(${H + 30}, ${40 + i * 36})`}>
            <rect width={18} height={18} rx={4} fill={colors[i % colors.length]} />
            <text x={28} y={15} className="slide-chart__label">
              {chart.categories[i]} {showValues ? `— ${fmt(v)} (${Math.round((v / total) * 100)}%)` : ''}
            </text>
          </g>
        ))}
    </svg>
  )
}

function DonutChart({
  chart,
  colors,
  showValues,
  showLegend,
}: {
  chart: ChartData
  colors: string[]
  showValues: boolean
  showLegend: boolean
}) {
  const values = chart.series[0]?.values ?? []
  const total = values.reduce((sum, v) => sum + Math.max(v, 0), 0) || 1
  const cx = H / 2
  const cy = H / 2
  const r = H / 2 - 20
  const innerR = r * 0.58
  let angle = -Math.PI / 2

  return (
    <svg className="slide-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.caption ?? 'Диаграмма'}>
      {values.map((v, i) => {
        const sweep = (2 * Math.PI * Math.max(v, 0)) / total
        const x1 = cx + r * Math.cos(angle)
        const y1 = cy + r * Math.sin(angle)
        angle += sweep
        const x2 = cx + r * Math.cos(angle)
        const y2 = cy + r * Math.sin(angle)
        const large = sweep > Math.PI ? 1 : 0
        return (
          <path
            key={i}
            d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`}
            fill={colors[i % colors.length]}
            stroke="var(--slide-bg)"
            strokeWidth={3}
          />
        )
      })}

      {/* Inner hole */}
      <circle cx={cx} cy={cy} r={innerR} fill="var(--slide-bg)" />
      <text x={cx} y={cy - 4} textAnchor="middle" className="slide-chart__value" style={{ fontSize: 22 }}>
        {fmt(total)}
      </text>
      {chart.unit && (
        <text x={cx} y={cy + 18} textAnchor="middle" className="slide-chart__unit" style={{ fontSize: 13 }}>
          {chart.unit}
        </text>
      )}

      {showLegend &&
        values.map((v, i) => (
          <g key={`legend-${i}`} transform={`translate(${H + 30}, ${40 + i * 36})`}>
            <rect width={18} height={18} rx={4} fill={colors[i % colors.length]} />
            <text x={28} y={15} className="slide-chart__label">
              {chart.categories[i]} {showValues ? `— ${fmt(v)} (${Math.round((v / total) * 100)}%)` : ''}
            </text>
          </g>
        ))}
    </svg>
  )
}
