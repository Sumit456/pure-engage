// Small set of themed building blocks. Styling lives in theme/components.css and reads tokens.css only.
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({ variant = 'secondary', busy = false, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button type="button" {...rest} className={`pe-button pe-button--${variant} ${rest.className ?? ''}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy && <Spinner small />}
      {children}
    </button>
  );
}

export function TextField({ label, error, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | undefined; hint?: string }) {
  const id = useId();
  return (
    <div className="pe-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...rest} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-msg` : undefined} />
      {(error || hint) && <small id={`${id}-msg`} className={error ? 'pe-field__error' : 'pe-muted'}>{error ?? hint}</small>}
    </div>
  );
}

export function SelectField({ label, error, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string | undefined; children: ReactNode }) {
  const id = useId();
  return (
    <div className="pe-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} {...rest} aria-invalid={error ? true : undefined}>{children}</select>
      {error && <small className="pe-field__error">{error}</small>}
    </div>
  );
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'brand';
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pe-badge pe-badge--${tone}`}>{children}</span>;
}

export function Spinner({ small = false }: { small?: boolean }) {
  const { t } = useTranslation();
  return <span className={`pe-spinner${small ? ' pe-spinner--small' : ''}`} role="status" aria-label={t('common.loading')} />;
}

export function ErrorBanner({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const message = error instanceof Error ? error.message : t('errors.generic');
  return <div className="pe-alert pe-alert--danger" role="alert">{message}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pe-empty">
      <strong>{title}</strong>
      {children && <div className="pe-muted">{children}</div>}
    </div>
  );
}

/** Native <dialog> as a modal; closes on Escape and backdrop click. */
export function Dialog({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) (typeof d.showModal === 'function' ? d.showModal() : d.setAttribute('open', ''));
    if (!open && d.open) (typeof d.close === 'function' ? d.close() : d.removeAttribute('open'));
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="pe-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open && (
        <div className="pe-dialog__body">
          <h2 id={titleId}>{title}</h2>
          {children}
          {footer && <div className="pe-dialog__footer">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function useFormatDate() {
  const { i18n } = useTranslation();
  const fmt = new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-AE' : 'en-AE', { dateStyle: 'medium', timeStyle: 'short' });
  return (value: string | Date | null | undefined) => (value ? fmt.format(new Date(value)) : '—');
}

/** Left-to-right island for phone numbers, emails and IDs, so "+971…" keeps its sign in Arabic. */
export function Ltr({ children }: { children: ReactNode }) {
  return <bdi dir="ltr" className="pe-ltr">{children}</bdi>;
}
