import { useTranslation } from 'react-i18next';
import type { MessageStatus } from '../../api/types.ts';
import { Badge, type Tone } from '../../components/ui.tsx';

const TONE: Record<MessageStatus, Tone> = {
  queued: 'brand', deferred: 'warning', sending: 'brand', sent: 'success', delivered: 'success', failed: 'danger', suppressed: 'neutral',
};

export function MessageStatusBadge({ status, reason }: { status: MessageStatus; reason?: string | null }) {
  const { t } = useTranslation();
  const label = t(`messages.status.${status}`);
  const why = reason ? t(`messages.reason.${reason}`, { defaultValue: reason }) : null;
  return (
    <span className="pe-row" style={{ gap: 6 }}>
      <Badge tone={TONE[status]}>{label}</Badge>
      {why && <small className="pe-muted">{why}</small>}
    </span>
  );
}
