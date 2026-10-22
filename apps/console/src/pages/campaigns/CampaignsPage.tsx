import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client.ts';
import type { CampaignDetail, CampaignEstimate, CampaignSummary, Contact, MessageSummary, Segment, Template } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { ContactPicker } from '../../components/ContactPicker.tsx';
import { Badge, Button, Dialog, EmptyState, ErrorBanner, SelectField, Spinner, TextField, useFormatDate, type Tone } from '../../components/ui.tsx';
import { MessageStatusBadge } from '../messages/MessageStatusBadge.tsx';

const STATUS_TONE: Record<CampaignSummary['status'], Tone> = { draft: 'neutral', scheduled: 'brand', sending: 'warning', sent: 'success', cancelled: 'danger' };
const ACTIVE = new Set(['scheduled', 'sending']);

export function CampaignStatusBadge({ status }: { status: CampaignSummary['status'] }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`campaigns.status.${status}`)}</Badge>;
}

export function CampaignsPage() {
  const { t } = useTranslation();
  const user = useUser();
  const formatDate = useFormatDate();
  const campaigns = useQuery({
    queryKey: ['campaigns'],
    queryFn: ({ signal }) => api<{ data: CampaignSummary[] }>('/api/campaigns', { signal }),
    refetchInterval: (q) => (q.state.data?.data.some((c) => ACTIVE.has(c.status)) ? 4000 : false),
  });
  return (
    <section>
      <div className="pe-page-header">
        <h1>{t('nav.campaigns')}</h1>
        <span className="pe-spacer" />
        {hasRole(user, 'marketer') && <Link className="pe-button pe-button--primary" to="/campaigns/new">{t('campaigns.new')}</Link>}
      </div>
      <div className="pe-card">
        <ErrorBanner error={campaigns.error} />
        {campaigns.isPending ? <div className="pe-center"><Spinner /></div> : !campaigns.data?.data.length ? <EmptyState title={t('campaigns.empty')}>{t('campaigns.emptyHint')}</EmptyState> : (
          <div className="pe-table-wrap">
            <table className="pe-table">
              <thead><tr>
                <th>{t('templates.field.name')}</th><th>{t('messages.statusLabel')}</th><th>{t('messages.template')}</th><th>{t('campaigns.segment')}</th>
                <th>{t('campaigns.when')}</th><th>{t('campaigns.stat.sent')}</th><th>{t('campaigns.stat.opened')}</th>
              </tr></thead>
              <tbody>
                {campaigns.data.data.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={`/campaigns/${c.id}`}>{c.name}</Link></td>
                    <td><CampaignStatusBadge status={c.status} /></td>
                    <td>{c.template_name} <small className="pe-muted">· {t(`consent.channel_${c.channel}`)}</small></td>
                    <td>{c.segment_name}</td>
                    <td>{formatDate(c.completed_at ?? c.started_at ?? c.scheduled_at)}</td>
                    <td>{c.stats.sent.toLocaleString()} / {c.stats.targeted.toLocaleString()}</td>
                    <td>{c.stats.opened.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

export function CampaignPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const { t } = useTranslation();
  const user = useUser();
  const canEdit = hasRole(user, 'marketer');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const formatDate = useFormatDate();

  const campaign = useQuery({
    queryKey: ['campaign', id],
    enabled: !isNew,
    queryFn: ({ signal }) => api<CampaignDetail>(`/api/campaigns/${id}`, { signal }),
    refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.status) ? 3000 : false),
  });
  const templates = useQuery({ queryKey: ['templates'], queryFn: ({ signal }) => api<{ data: Template[] }>('/api/templates', { signal }) });
  const segments = useQuery({ queryKey: ['segments'], queryFn: ({ signal }) => api<{ data: Segment[] }>('/api/segments', { signal }) });
  const isDraft = isNew || campaign.data?.status === 'draft';
  const estimate = useQuery({ queryKey: ['campaign', id, 'estimate'], enabled: !isNew && isDraft, queryFn: ({ signal }) => api<CampaignEstimate>(`/api/campaigns/${id}/estimate`, { signal }) });

  const [form, setForm] = useState({ name: '', template_id: '', segment_id: '' });
  useEffect(() => { if (campaign.data) setForm({ name: campaign.data.name, template_id: campaign.data.template_id, segment_id: campaign.data.segment_id }); }, [campaign.data]);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [testContact, setTestContact] = useState<Contact | null>(null);

  const refresh = (cid: string) => {
    void qc.invalidateQueries({ queryKey: ['campaigns'] });
    void qc.invalidateQueries({ queryKey: ['campaign', cid] });
  };
  const save = useMutation({
    mutationFn: () => isNew ? api<CampaignDetail>('/api/campaigns', { method: 'POST', body: form }) : api<CampaignDetail>(`/api/campaigns/${id}`, { method: 'PUT', body: form }),
    onSuccess: (c) => { refresh(c.id); if (isNew) navigate(`/campaigns/${c.id}`, { replace: true }); },
  });
  const schedule = useMutation({
    mutationFn: () => api(`/api/campaigns/${id}/schedule`, { method: 'POST', body: when === 'later' && at ? { scheduled_at: new Date(at).toISOString() } : {} }),
    onSuccess: () => { setScheduleOpen(false); refresh(id!); },
  });
  const cancel = useMutation({ mutationFn: () => api(`/api/campaigns/${id}/cancel`, { method: 'POST' }), onSuccess: () => refresh(id!) });
  const testSend = useMutation({ mutationFn: () => api<MessageSummary>(`/api/campaigns/${id}/test`, { method: 'POST', body: { contact_id: testContact!.id } }) });

  if (!isNew && campaign.isPending) return <div className="pe-center"><Spinner /></div>;
  if (!isNew && campaign.error) return <ErrorBanner error={campaign.error} />;
  const c = campaign.data;
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const onSubmit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  const dirty = !c || form.name !== c.name || form.template_id !== c.template_id || form.segment_id !== c.segment_id;

  return (
    <section>
      <div className="pe-page-header"><Link to="/campaigns" className="pe-muted">{t('campaigns.backToList')}</Link></div>
      <div className="pe-page-header">
        <h1>{isNew ? t('campaigns.new') : c!.name}</h1>
        {c && <CampaignStatusBadge status={c.status} />}
        <span className="pe-spacer" />
        {c && canEdit && c.status === 'draft' && <Button variant="primary" disabled={dirty} onClick={() => setScheduleOpen(true)}>{t('campaigns.sendOrSchedule')}</Button>}
        {c && canEdit && ACTIVE.has(c.status) && <Button variant="danger" busy={cancel.isPending} onClick={() => cancel.mutate()}>{t('campaigns.cancel')}</Button>}
      </div>
      <ErrorBanner error={cancel.error} />

      {isDraft ? (
        <form className="pe-stack" onSubmit={onSubmit} noValidate>
          {save.error && <ErrorBanner error={save.error} />}
          <div className="pe-card pe-form-grid">
            <TextField label={t('templates.field.name')} value={form.name} disabled={!canEdit} error={fieldErrors.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <SelectField label={t('messages.template')} value={form.template_id} disabled={!canEdit} error={fieldErrors.template_id} onChange={(e) => setForm({ ...form, template_id: e.target.value })}>
              <option value="">{t('campaigns.choose')}</option>
              {templates.data?.data.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name} · {t(`consent.channel_${tpl.channel}`)} · {t(`consent.purpose.${tpl.purpose}`)}</option>)}
            </SelectField>
            <SelectField label={t('campaigns.segment')} value={form.segment_id} disabled={!canEdit} error={fieldErrors.segment_id} onChange={(e) => setForm({ ...form, segment_id: e.target.value })}>
              <option value="">{t('campaigns.choose')}</option>
              {segments.data?.data.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.size.toLocaleString()})</option>)}
            </SelectField>
          </div>
          {canEdit && dirty && <div><Button type="submit" variant="primary" busy={save.isPending} disabled={!form.name || !form.template_id || !form.segment_id}>{t('campaigns.saveDraft')}</Button></div>}
          {c && !dirty && (
            <div className="pe-grid-2">
              <div className="pe-card pe-stack">
                <h2>{t('campaigns.audience')}</h2>
                {estimate.data ? (
                  <div className="pe-stats">
                    <div className="pe-stat"><strong data-testid="estimate-eligible">{estimate.data.eligible.toLocaleString()}</strong><span className="pe-muted">{t('campaigns.eligible')}</span></div>
                    <div className="pe-stat"><strong>{estimate.data.segment_size.toLocaleString()}</strong><span className="pe-muted">{t('campaigns.inSegment')}</span></div>
                  </div>
                ) : <Spinner />}
                <p className="pe-muted">{t('campaigns.eligibleExplainer', { channel: t(`consent.channel_${estimate.data?.channel ?? 'email'}`), purpose: t(`consent.purpose.${estimate.data?.purpose ?? 'marketing'}`) })}</p>
              </div>
              {canEdit && (
                <div className="pe-card pe-stack">
                  <h2>{t('campaigns.testSend')}</h2>
                  <ContactPicker label={t('campaigns.testTo')} placeholder={t('campaigns.testPlaceholder')} value={testContact} onChange={setTestContact} />
                  <div><Button disabled={!testContact} busy={testSend.isPending} onClick={() => testSend.mutate()}>{t('campaigns.sendTest')}</Button></div>
                  <ErrorBanner error={testSend.error} />
                  {testSend.data && <div className="pe-row"><MessageStatusBadge status={testSend.data.status} reason={testSend.data.status_reason} /><Link to={`/messages/${testSend.data.id}`}>{t('campaigns.viewMessage')}</Link></div>}
                </div>
              )}
            </div>
          )}
        </form>
      ) : c && (
        <div className="pe-stack">
          <div className="pe-card pe-stack">
            <dl className="pe-dl">
              <dt>{t('messages.template')}</dt><dd><Link to={`/templates/${c.template.id}`}>{c.template.name}</Link> · {t(`consent.channel_${c.template.channel}`)} · {t(`consent.purpose.${c.template.purpose}`)}</dd>
              <dt>{t('campaigns.segment')}</dt><dd><Link to={`/segments/${c.segment.id}`}>{c.segment.name}</Link></dd>
              <dt>{t('campaigns.scheduledFor')}</dt><dd>{formatDate(c.scheduled_at)}</dd>
              <dt>{t('campaigns.started')}</dt><dd>{formatDate(c.started_at)}</dd>
              <dt>{t('campaigns.completed')}</dt><dd>{formatDate(c.completed_at)}</dd>
            </dl>
          </div>
          <div className="pe-card pe-stack">
            <h2>{t('campaigns.results')}</h2>
            <div className="pe-stats">
              {(['targeted', 'sent', 'delivered', 'opened', 'clicked', 'suppressed', 'failed', 'pending'] as const).map((k) => (
                <div key={k} className="pe-stat"><strong data-testid={`stat-${k}`}>{c.stats[k].toLocaleString()}</strong><span className="pe-muted">{t(`campaigns.stat.${k}`)}</span></div>
              ))}
            </div>
            {Object.keys(c.stats.suppressed_by_reason).length > 0 && (
              <div className="pe-row">
                <span className="pe-muted">{t('campaigns.notSentBecause')}</span>
                {Object.entries(c.stats.suppressed_by_reason).map(([reason, n]) => <Badge key={reason}>{t(`messages.reason.${reason}`, { defaultValue: reason })}: {n}</Badge>)}
              </div>
            )}
            <Link to={`/messages?campaign=${c.id}`} className="pe-muted">{t('campaigns.seeMessages')}</Link>
          </div>
        </div>
      )}

      <Dialog
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        title={t('campaigns.sendOrSchedule')}
        footer={<>
          <Button onClick={() => setScheduleOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={schedule.isPending} disabled={when === 'later' && !at} onClick={() => schedule.mutate()}>{when === 'now' ? t('campaigns.sendNow') : t('campaigns.schedule')}</Button>
        </>}
      >
        <p>{t('campaigns.confirmAudience', { n: (estimate.data?.eligible ?? 0).toLocaleString() })}</p>
        <label className="pe-row"><input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} /> {t('campaigns.sendNow')}</label>
        <label className="pe-row"><input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} /> {t('campaigns.later')}</label>
        {when === 'later' && <TextField label={t('campaigns.scheduledFor')} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
        <ErrorBanner error={schedule.error} />
      </Dialog>
    </section>
  );
}
