// Small hand-rolled SVG charts. Every chart also renders a visually hidden data table.
import { useId, type ReactNode } from 'react';
import { cx } from '../utils/format';

export interface Datum {
  label: string;
  value: number;
  tone?: string;
  hint?: string;
}

function SrTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Horizontal bars: categories with values. */
export function BarList({ data, label, format = (v) => String(v), onSelect, max: forcedMax }: { data: Datum[]; label: string; format?: (v: number) => string; onSelect?: (d: Datum) => void; max?: number }) {
  const max = forcedMax ?? Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="barlist" role="group" aria-label={label}>
      {data.map((d) => {
        const inner = (
          <>
            <span className="barlist-label">{d.label}</span>
            <span className="barlist-track">
              <span className={cx('barlist-fill', d.tone)} style={{ width: `${(d.value / max) * 100}%` }} />
            </span>
            <span className="barlist-value">{format(d.value)}</span>
          </>
        );
        return onSelect ? (
          <button type="button" key={d.label} className="barlist-row" onClick={() => onSelect(d)} title={d.hint}>
            {inner}
          </button>
        ) : (
          <div key={d.label} className="barlist-row" title={d.hint}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

export interface Series {
  name: string;
  values: number[];
  tone: string;
}

/** Vertical grouped or stacked columns over categories (e.g. weeks). */
export function ColumnChart({ categories, series, label, stacked, height = 180 }: { categories: string[]; series: Series[]; label: string; stacked?: boolean; height?: number }) {
  const W = 600;
  const H = height;
  const pad = { l: 28, r: 8, t: 10, b: 24 };
  const totals = categories.map((_, i) => (stacked ? series.reduce((s, x) => s + (x.values[i] ?? 0), 0) : Math.max(...series.map((x) => x.values[i] ?? 0))));
  const max = Math.max(1, ...totals);
  const niceMax = Math.ceil(max / 4) * 4 || 4;
  const bw = (W - pad.l - pad.r) / categories.length;
  const y = (v: number) => H - pad.b - (v / niceMax) * (H - pad.t - pad.b);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="none" className="chart-svg">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(niceMax * f)} y2={y(niceMax * f)} className="grid" />
            <text x={pad.l - 6} y={y(niceMax * f) + 3} className="axis" textAnchor="end">
              {Math.round(niceMax * f)}
            </text>
          </g>
        ))}
        {categories.map((c, i) => {
          const x0 = pad.l + i * bw + bw * 0.18;
          const w = bw * 0.64;
          let acc = 0;
          return (
            <g key={c}>
              {series.map((s, si) => {
                const v = s.values[i] ?? 0;
                if (stacked) {
                  const top = y(acc + v);
                  const h = y(acc) - top;
                  acc += v;
                  return <rect key={s.name} x={x0} y={top} width={w} height={Math.max(0, h)} className={cx('bar', s.tone)} rx={1.5}><title>{`${c} · ${s.name}: ${v}`}</title></rect>;
                }
                const sw = w / series.length;
                return <rect key={s.name} x={x0 + si * sw} y={y(v)} width={sw - 2} height={Math.max(0, y(0) - y(v))} className={cx('bar', s.tone)} rx={1.5}><title>{`${c} · ${s.name}: ${v}`}</title></rect>;
              })}
              {(categories.length <= 12 || i % 2 === 0) && (
                <text x={pad.l + i * bw + bw / 2} y={H - 8} className="axis" textAnchor="middle">
                  {c}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.name, tone: s.tone }))} />}
      <SrTable caption={label} head={['Category', ...series.map((s) => s.name)]} rows={categories.map((c, i) => [c, ...series.map((s) => s.values[i] ?? 0)])} />
    </figure>
  );
}

export function LineChart({ categories, series, label, height = 180, percent }: { categories: string[]; series: Series[]; label: string; height?: number; percent?: boolean }) {
  const W = 600;
  const H = height;
  const pad = { l: 32, r: 10, t: 10, b: 24 };
  const max = percent ? 1 : Math.max(1, ...series.flatMap((s) => s.values));
  const niceMax = percent ? 1 : Math.ceil(max / 4) * 4 || 4;
  const x = (i: number) => pad.l + (categories.length === 1 ? 0 : (i / (categories.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => H - pad.b - (v / niceMax) * (H - pad.t - pad.b);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="none" className="chart-svg">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(niceMax * f)} y2={y(niceMax * f)} className="grid" />
            <text x={pad.l - 6} y={y(niceMax * f) + 3} className="axis" textAnchor="end">
              {percent ? `${Math.round(f * 100)}%` : Math.round(niceMax * f)}
            </text>
          </g>
        ))}
        {series.map((s) => (
          <g key={s.name} className={cx('line', s.tone)}>
            <polyline fill="none" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            {s.values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={2.6}>
                <title>{`${categories[i]} · ${s.name}: ${percent ? `${Math.round(v * 100)}%` : v}`}</title>
              </circle>
            ))}
          </g>
        ))}
        {categories.map((c, i) => (categories.length <= 10 || i % 2 === 0) && (
          <text key={c + i} x={x(i)} y={H - 8} className="axis" textAnchor="middle">
            {c}
          </text>
        ))}
      </svg>
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.name, tone: s.tone }))} />}
      <SrTable caption={label} head={['Category', ...series.map((s) => s.name)]} rows={categories.map((c, i) => [c, ...series.map((s) => s.values[i] ?? 0)])} />
    </figure>
  );
}

export function Donut({ data, label, center }: { data: Datum[]; label: string; center?: ReactNode }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const R = 42;
  const C = 2 * Math.PI * R;
  let off = 0;
  const id = useId();
  return (
    <figure className="donut">
      <svg viewBox="0 0 100 100" role="img" aria-labelledby={id} className="donut-svg">
        <title id={id}>{`${label}: ${data.map((d) => `${d.label} ${d.value}`).join(', ')}`}</title>
        <circle cx="50" cy="50" r={R} className="donut-track" />
        {total > 0 &&
          data.map((d) => {
            const len = (d.value / total) * C;
            const el = <circle key={d.label} cx="50" cy="50" r={R} className={cx('donut-seg', d.tone)} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} />;
            off += len;
            return el;
          })}
      </svg>
      <div className="donut-center">{center ?? total}</div>
      <Legend items={data.map((d) => ({ label: `${d.label} · ${d.value}`, tone: d.tone ?? '' }))} />
    </figure>
  );
}

export function Legend({ items }: { items: { label: string; tone: string }[] }) {
  return (
    <ul className="legend">
      {items.map((i) => (
        <li key={i.label}>
          <span className={cx('swatch', i.tone)} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export function Meter({ value, label }: { value: number | null; label: string }) {
  const v = value ?? 0;
  return (
    <div className="meter" role="meter" aria-valuenow={Math.round(v * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <span style={{ width: `${v * 100}%` }} className={v >= 0.8 ? 'ok' : v >= 0.6 ? 'warn' : 'danger'} />
    </div>
  );
}

export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const W = 72;
  const H = 26;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 3 - ((v - min) / span) * (H - 6)}`);
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${label}: ${values.map((v) => Math.round(v * 100) / 100).join(', ')}`}>
      <polyline points={`0,${H} ${pts.join(' ')} ${W},${H}`} className="spark-area" />
      <polyline points={pts.join(' ')} className="spark-line" fill="none" />
    </svg>
  );
}

export function Heatmap({ grid, rows, cols, label }: { grid: number[][]; rows: string[]; cols: string[]; label: string }) {
  const max = Math.max(1, ...grid.flat());
  return (
    <div className="heatmap" role="img" aria-label={label}>
      <div className="hm-grid" style={{ gridTemplateColumns: `36px repeat(${cols.length}, 1fr)` }}>
        <span />
        {cols.map((c) => (
          <span key={c} className="hm-col">{c}:00</span>
        ))}
        {grid.map((row, r) => (
          <div key={rows[r]} className="hm-row" style={{ display: 'contents' }}>
            <span className="hm-label">{rows[r]}</span>
            {row.map((v, c) => (
              <span key={c} className="hm-cell" style={{ ['--a' as string]: v ? 0.18 + (v / max) * 0.82 : 0 }} title={`${rows[r]} ${cols[c]}:00–${Number(cols[c]) + 3}:00 · ${v} update(s)`} />
            ))}
          </div>
        ))}
      </div>
      <SrTable caption={label} head={['Day', ...cols]} rows={grid.map((row, r) => [rows[r]!, ...row])} />
    </div>
  );
}

export function ProgressRing({ value, label, size = 96, children }: { value: number; label: string; size?: number; children?: ReactNode }) {
  const R = 40;
  const C = 2 * Math.PI * R;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" role="img" aria-label={`${label}: ${Math.round(v * 100)}%`}>
        <circle cx="50" cy="50" r={R} className="ring-track" />
        <circle cx="50" cy="50" r={R} className="ring-fill" strokeDasharray={`${v * C} ${C}`} transform="rotate(-90 50 50)" />
      </svg>
      <div className="ring-center">{children ?? `${Math.round(v * 100)}%`}</div>
    </div>
  );
}
