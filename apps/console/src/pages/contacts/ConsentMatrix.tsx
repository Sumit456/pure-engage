import { useTranslation } from 'react-i18next';
import { CHANNELS, PURPOSES, CONSENT_STATUSES, type ConsentMap, type ConsentStatus } from '@pure-engage/shared';
import { Badge, type Tone } from '../../components/ui.tsx';

const TONE: Record<ConsentStatus, Tone> = { granted: 'success', denied: 'danger', unknown: 'neutral' };

/** Channel × purpose grid. Read-only unless `onChange` is given. Missing entries show as unknown. */
export function ConsentMatrix({ value, onChange }: { value: ConsentMap; onChange?: (next: ConsentMap) => void }) {
  const { t } = useTranslation();
  return (
    <table className="pe-consent">
      <thead>
        <tr>
          <th scope="col"><span className="pe-visually-hidden">{t('consent.channel')}</span></th>
          {PURPOSES.map((p) => <th key={p} scope="col">{t(`consent.purpose.${p}`)}</th>)}
        </tr>
      </thead>
      <tbody>
        {CHANNELS.map((ch) => (
          <tr key={ch}>
            <th scope="row">{t(`consent.channel_${ch}`)}</th>
            {PURPOSES.map((p) => {
              const status: ConsentStatus = value[ch]?.[p] ?? 'unknown';
              return (
                <td key={p}>
                  {onChange ? (
                    <select
                      aria-label={`${t(`consent.channel_${ch}`)} · ${t(`consent.purpose.${p}`)}`}
                      value={status}
                      onChange={(e) => onChange({ ...value, [ch]: { ...(value[ch] ?? {}), [p]: e.target.value as ConsentStatus } })}
                    >
                      {CONSENT_STATUSES.map((s) => <option key={s} value={s}>{t(`consent.status.${s}`)}</option>)}
                    </select>
                  ) : (
                    <Badge tone={TONE[status]}>{t(`consent.status.${status}`)}</Badge>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Compact summary for lists: the channels with care consent granted. */
export function ConsentSummary({ value }: { value: ConsentMap }) {
  const { t } = useTranslation();
  const granted = CHANNELS.filter((ch) => value[ch]?.care === 'granted');
  if (!granted.length) return <span className="pe-muted">—</span>;
  return <span className="pe-row">{granted.map((ch) => <Badge key={ch} tone="success">{t(`consent.channel_${ch}`)}</Badge>)}</span>;
}
