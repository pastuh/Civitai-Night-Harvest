import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n/context'

type Props = {
  /** Inclusive range start (YYYY-MM-DD), or null if no date filter. */
  from: string | null
  /** Inclusive range end; same as from for a single day. */
  to: string | null
  /** Days that have downloads — shown with a marker. */
  daysWithCounts: Map<string, number>
  onPickDay: (day: string) => void
}

function parseDay(day: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

function dayKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const dt = new Date(y, m - 1 + delta, 1)
  return { y: dt.getFullYear(), m: dt.getMonth() + 1 }
}

/** Build a 6×7 month grid (Mon-first). Cells are day keys or null. */
function monthGrid(y: number, m: number): Array<string | null> {
  const first = new Date(y, m - 1, 1)
  // Mon=0 … Sun=6
  const startPad = (first.getDay() + 6) % 7
  const daysInMonth = new Date(y, m, 0).getDate()
  const cells: Array<string | null> = []
  for (let i = 0; i < startPad; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(dayKey(y, m, d))
  while (cells.length % 7 !== 0) cells.push(null)
  while (cells.length < 42) cells.push(null)
  return cells
}

export function SidebarDownloadCalendar({ from, to, daysWithCounts, onPickDay }: Props) {
  const { locale, t } = useI18n()
  const initial = parseDay(to ?? from ?? '') ?? (() => {
    const n = new Date()
    return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() }
  })()
  const [view, setView] = useState(() => ({ y: initial.y, m: initial.m }))

  useEffect(() => {
    const p = parseDay(from ?? '')
    if (!p) return
    setView((v) => (v.y === p.y && v.m === p.m ? v : { y: p.y, m: p.m }))
  }, [from, to])

  const cells = useMemo(() => monthGrid(view.y, view.m), [view.y, view.m])
  const monthLabel = useMemo(() => {
    const dt = new Date(view.y, view.m - 1, 1)
    return dt.toLocaleDateString(locale === 'lt' ? 'lt-LT' : 'en-US', {
      month: 'long',
      year: 'numeric'
    })
  }, [view.y, view.m, locale])

  const weekdayLabels = useMemo(() => {
    const base = locale === 'lt' ? 'lt-LT' : 'en-US'
    // 2024-01-01 was Monday — take Mon…Sun short names
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(2024, 0, 1 + i)
      return d.toLocaleDateString(base, { weekday: 'narrow' })
    })
  }, [locale])

  const rangeFrom = from && to ? (from <= to ? from : to) : from
  const rangeTo = from && to ? (from <= to ? to : from) : to

  const selectionLabel =
    rangeFrom && rangeTo
      ? rangeFrom === rangeTo
        ? rangeFrom
        : `${rangeFrom} – ${rangeTo}`
      : null

  return (
    <div className="sidebar-cal" aria-label={t('gallery.downloadedByDate')}>
      <div className="sidebar-cal-nav">
        <button
          type="button"
          className="btn-sm sidebar-cal-nav-btn"
          aria-label={t('gallery.calendarPrevMonth')}
          onClick={() => setView((v) => addMonths(v.y, v.m, -1))}
        >
          ‹
        </button>
        <span className="sidebar-cal-month">{monthLabel}</span>
        <button
          type="button"
          className="btn-sm sidebar-cal-nav-btn"
          aria-label={t('gallery.calendarNextMonth')}
          onClick={() => setView((v) => addMonths(v.y, v.m, 1))}
        >
          ›
        </button>
      </div>
      <div className="sidebar-cal-weekdays" aria-hidden>
        {weekdayLabels.map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>
      <div className="sidebar-cal-grid" role="grid">
        {cells.map((day, i) => {
          if (!day) {
            return <span key={`e-${i}`} className="sidebar-cal-cell empty" />
          }
          const count = daysWithCounts.get(day) ?? 0
          const inRange =
            rangeFrom != null && rangeTo != null && day >= rangeFrom && day <= rangeTo
          const isStart = rangeFrom === day
          const isEnd = rangeTo === day
          const isToday = day === dayKeyFromDate(new Date())
          return (
            <button
              key={day}
              type="button"
              role="gridcell"
              className={[
                'sidebar-cal-cell',
                inRange ? 'in-range' : '',
                isStart || isEnd ? 'endpoint' : '',
                isToday ? 'today' : '',
                count > 0 ? 'has-downloads' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              title={count > 0 ? `${day} · ${count}` : day}
              onClick={() => onPickDay(day)}
            >
              <span className="sidebar-cal-daynum">{Number(day.slice(8))}</span>
              {count > 0 ? <span className="sidebar-cal-dot" aria-hidden /> : null}
            </button>
          )
        })}
      </div>
      <p className="sidebar-cal-hint muted">{t('gallery.calendarRangeHint')}</p>
      {selectionLabel ? (
        <p className="sidebar-cal-selection" aria-live="polite">
          {selectionLabel}
        </p>
      ) : null}
    </div>
  )
}

function dayKeyFromDate(d: Date): string {
  return dayKey(d.getFullYear(), d.getMonth() + 1, d.getDate())
}
