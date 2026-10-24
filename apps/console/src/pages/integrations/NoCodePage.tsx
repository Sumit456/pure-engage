// No-code automation: how to connect Zapier, Make or n8n using inbound webhooks (data in) and outbound webhooks
// (data out). Nothing tool-specific is installed: both directions are plain signed HTTPS.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { IconChip, PageHeader } from '../../components/bits.tsx';
import { BackLink } from './common.tsx';

const TOOLS = ['zapier', 'make', 'n8n'] as const;
type Tool = (typeof TOOLS)[number];

export function NoCodePage() {
  const { t } = useTranslation();
  const [tool, setTool] = useState<Tool>('zapier');
  const steps = (dir: 'in' | 'out') => [1, 2, 3, 4].map((n) => t(`integrations.nocode.${dir}${n}`, { action: t(`integrations.nocode.tools.${tool}.${dir}`), tool: t(`integrations.nocode.tools.${tool}.name`) }));
  return (
    <section className="pe-stack">
      <BackLink to="/integrations">{t('nav.integrations')}</BackLink>
      <PageHeader title={t('integrations.cards.nocode.title')} subtitle={t('integrations.nocode.subtitle')} />
      <div className="pe-tabs" role="tablist" aria-label={t('integrations.nocode.pick')}>
        {TOOLS.map((x) => <button key={x} type="button" role="tab" aria-selected={tool === x} className="pe-tab" onClick={() => setTool(x)}>{t(`integrations.nocode.tools.${x}.name`)}</button>)}
      </div>
      <div className="pe-grid-2">
        <div className="pe-card pe-stack">
          <div className="pe-row"><IconChip icon={ArrowDownToLine} tone="info" /><h2>{t('integrations.nocode.inTitle')}</h2></div>
          <ol className="pe-steps">{steps('in').map((s, i) => <li key={i}>{s}</li>)}</ol>
          <Link to="/integrations/inbound/new" className="pe-button pe-button--primary">{t('integrations.inbound.new')}</Link>
        </div>
        <div className="pe-card pe-stack">
          <div className="pe-row"><IconChip icon={ArrowUpFromLine} tone="sms" /><h2>{t('integrations.nocode.outTitle')}</h2></div>
          <ol className="pe-steps">{steps('out').map((s, i) => <li key={i}>{s}</li>)}</ol>
          <Link to="/integrations/outbound" className="pe-button pe-button--secondary">{t('settings.addWebhook')}</Link>
        </div>
      </div>
      <p className="pe-muted">{t('integrations.nocode.privacy')}</p>
    </section>
  );
}
