// Multi-series line chart in plain SVG: one y-axis, recessive grid, 2px lines, legend plus direct labels at the
// line ends, a crosshair + tooltip on hover/focus, and a table view so nothing depends on colour alone.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

export interface Series { key: string; label: string; color: string; values: number[] }

const H = 240;
const PAD = { top: 16, right: 56, bottom: 28, left: 40 };

function niceMax(n: number): number {
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((m) => m >= n) ?? n;
}

export function LineChart({ title, labels, series, formatLabel = (s) => s }: { title: string; labels: string[]; series: Series[]; formatLabel?: (s: string) => string }) {
  const { t, i18n } = useTranslation();
  const rtl = i18n.dir() === 'rtl';
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const innerW = width - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const n = labels.length;
  // Time runs right-to-left in Arabic.
  const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (rtl ? (n - 1 - i) : i) * (innerW / (n - 1)));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 70))));
  const paths = useMemo(() => series.map((s) => s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')), [series, width, max, rtl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Direct labels at the line ends, nudged apart when lines finish at (nearly) the same value.
  const endLabelY = useMemo(() => {
    const ends = series.map((sr, i) => ({ i, y: y(sr.values[n - 1] ?? 0) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) if (ends[k]!.y - ends[k - 1]!.y < 13) ends[k]!.y = ends[k - 1]!.y + 13;
    return Object.fromEntries(ends.map((e) => [e.i, e.y])) as Record<number, number>;
  }, [series, n, max]); // eslint-disable-line react-hooks/exhaustive-deps

  const fromPointer = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    const px = clientX - rect.left;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setHover(best);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    const step = (e.key === 'ArrowRight') !== rtl ? 1 : -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setHover((h) => Math.min(n - 1, Math.max(0, (h ?? (step > 0 ? -1 : n)) + step))); }
    if (e.key === 'Escape') setHover(null);
  };

  return (
    <figure className="pe-chart">
      <figcaption className="pe-row">
        <strong>{title}</strong>
        <span className="pe-spacer" />
        <ul className="pe-legend" aria-label={t('reports.legend')}>
          {series.map((s) => <li key={s.key}><span className="pe-legend__swatch" style={{ background: s.color }} aria-hidden="true" />{s.label}</li>)}
        </ul>
        <button type="button" className="pe-button pe-button--ghost" aria-expanded={showTable} aria-controls={tableId} onClick={() => setShowTable((v) => !v)}>
          {showTable ? t('reports.showChart') : t('reports.showTable')}
        </button>
      </figcaption>

      {!showTable ? (
        <div
          ref={wrap}
          className="pe-chart__plot"
          tabIndex={0}
          role="img"
          aria-label={t('reports.chartLabel', { title })}
          onPointerMove={(e) => fromPointer(e.clientX)}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} aria-hidden="true">
            {ticks.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className="pe-chart__grid" />
                <text x={rtl ? width - PAD.right + 6 : PAD.left - 6} y={y(v)} dy="0.32em" textAnchor={rtl ? 'start' : 'end'} className="pe-chart__tick">{Math.round(v).toLocaleString(i18n.language)}</text>
              </g>
            ))}
            {labels.map((l, i) => (i % every === 0 || (i === n - 1 && (n - 1) % every >= every / 2)) && (
              <text key={l} x={x(i)} y={H - 8} textAnchor="middle" className="pe-chart__tick">{formatLabel(l)}</text>
            ))}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} className="pe-chart__crosshair" />}
            {series.map((s, si) => (
              <g key={s.key}>
                <path d={paths[si]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {n > 0 && <text x={x(n - 1) + (rtl ? -6 : 6)} y={endLabelY[si]} dy="0.32em" textAnchor={rtl ? 'end' : 'start'} className="pe-chart__label">{s.label}</text>}
                {hover !== null && <circle cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4.5} fill={s.color} stroke="var(--pe-surface)" strokeWidth={2} />}
              </g>
            ))}
          </svg>
          {hover !== null && (
            // Sits beside the crosshair, on whichever side has room, so it never hides the line it describes.
            <div className="pe-tooltip" role="status" style={x(hover) > width / 2
              ? { left: x(hover) - 12, transform: 'translateX(-100%)' }
              : { left: x(hover) + 12 }}>
              <strong>{formatLabel(labels[hover]!)}</strong>
              {series.map((s) => <div key={s.key} className="pe-row" style={{ gap: 6 }}><span className="pe-legend__swatch" style={{ background: s.color }} aria-hidden="true" />{s.label}: <strong>{(s.values[hover] ?? 0).toLocaleString(i18n.language)}</strong></div>)}
            </div>
          )}
        </div>
      ) : (
        <div className="pe-table-wrap" id={tableId}>
          <table className="pe-table">
            <thead><tr><th>{t('reports.day')}</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
            <tbody>{labels.map((l, i) => <tr key={l}><td>{formatLabel(l)}</td>{series.map((s) => <td key={s.key}>{(s.values[i] ?? 0).toLocaleString(i18n.language)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </figure>
  );
}

/** Horizontal bars for one measure across categories (single hue; labels and values are text). */
export function BarList({ title, items, empty }: { title: string; items: { label: string; value: number }[]; empty: string }) {
  const { i18n } = useTranslation();
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <figure className="pe-chart">
      <figcaption><strong>{title}</strong></figcaption>
      {!items.length ? <p className="pe-muted">{empty}</p> : (
        <ul className="pe-bars">
          {items.map((it) => (
            <li key={it.label}>
              <span className="pe-bars__label">{it.label}</span>
              <span className="pe-bars__track"><span className="pe-bars__bar" style={{ inlineSize: `${(it.value / max) * 100}%` }} /></span>
              <span className="pe-bars__value">{it.value.toLocaleString(i18n.language)}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
