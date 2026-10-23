// Small visual building blocks for the redesigned console: pills, initials, sparklines, icon chips and KPI tiles.
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'primary' | 'sms' | 'muted';

export function Pill({ tone = 'muted', dot, live, children }: { tone?: Tone; dot?: boolean; live?: boolean; children: ReactNode }) {
  return (
    <span className={`pe-pill pe-pill--${tone}`}>
      {(dot || live) && <span className={live ? 'pe-pill__dot pe-pill__dot--live' : 'pe-pill__dot'} aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Initials({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  const ini = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase();
  return <span className={`pe-initials pe-initials--${size}`} aria-hidden="true">{ini}</span>;
}

export function IconChip({ icon: Icon, tone = 'primary' }: { icon: LucideIcon; tone?: Tone }) {
  return <span className={`pe-iconchip pe-pill--${tone}`} aria-hidden="true"><Icon /></span>;
}

/** A tiny trend line; decorative (the number it accompanies is the accessible value). */
export function Sparkline({ data, tone = 'primary' }: { data: number[]; tone?: 'primary' | 'sms' }) {
  if (data.length < 2) return null;
  const w = 96, h = 32;
  const min = Math.min(...data), max = Math.max(...data);
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / (max - min || 1)) * (h - 4) - 2] as const);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} className={`pe-spark pe-spark--${tone}`} aria-hidden="true" focusable="false">
      <path d={`${d} L${w},${h} L0,${h} Z`} className="pe-spark__fill" />
      <path d={d} className="pe-spark__line" />
    </svg>
  );
}

export function KpiTile({ label, value, hint, icon, trend, footer, testId }: { label: string; value: ReactNode; hint?: ReactNode; icon: LucideIcon; trend?: number[]; footer?: ReactNode; testId?: string }) {
  return (
    <div className="pe-card pe-kpi">
      <div className="pe-kpi__head">
        <span className="pe-kpi__label">{label}</span>
        <IconChip icon={icon} />
      </div>
      <div className="pe-kpi__body">
        <strong className="pe-kpi__value" data-testid={testId}>{value}</strong>
        {trend && <Sparkline data={trend} />}
      </div>
      {hint && <small className="pe-muted">{hint}</small>}
      {footer}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="pe-page-header pe-page-header--rich">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="pe-muted pe-page-header__sub">{subtitle}</p>}
      </div>
      {actions && <div className="pe-row">{actions}</div>}
    </div>
  );
}
