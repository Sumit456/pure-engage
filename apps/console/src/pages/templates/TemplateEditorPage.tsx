import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { smsInfo } from '@pure-engage/shared';
import { api, ApiError } from '../../api/client.ts';
import type { Channel, Contact, EmailPart, Purpose, SmsPart, TemplateContent, TemplateDetail, TemplateVersion } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { Badge, Button, ErrorBanner, SelectField, Spinner, TextField, useFormatDate } from '../../components/ui.tsx';
import { ContactPicker } from '../../components/ContactPicker.tsx';

type Locale = 'en' | 'ar';
interface Draft { name: string; description: string; channel: Channel; purpose: Purpose; content: Record<Locale, EmailPart & SmsPart> }

const blankPart = (): EmailPart & SmsPart => ({ subject: '', html: '', text: '', body: '' });
const toDraft = (t?: TemplateDetail): Draft => ({
  name: t?.name ?? '', description: t?.description ?? '', channel: t?.channel ?? 'email', purpose: t?.purpose ?? 'care',
  content: { en: { ...blankPart(), ...(t?.content.en ?? {}) }, ar: { ...blankPart(), ...(t?.content.ar ?? {}) } },
});
/** Only the fields for the channel; Arabic is omitted when left empty. */
function toContent(d: Draft): TemplateContent {
  const part = (p: EmailPart & SmsPart) => (d.channel === 'sms' ? { body: p.body } : { subject: p.subject, html: p.html, ...(p.text?.trim() ? { text: p.text } : {}) });
  const arEmpty = d.channel === 'sms' ? !d.content.ar.body.trim() : !d.content.ar.subject.trim() && !d.content.ar.html.trim();
  return { en: part(d.content.en), ...(arEmpty ? {} : { ar: part(d.content.ar) }) };
}

function useDebouncedValue<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

export function TemplateEditorPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const { t } = useTranslation();
  const user = useUser();
  const canEdit = hasRole(user, 'marketer');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const formatDate = useFormatDate();

  const template = useQuery({ queryKey: ['template', id], enabled: !isNew, queryFn: ({ signal }) => api<TemplateDetail>(`/api/templates/${id}`, { signal }) });
  const versions = useQuery({ queryKey: ['template', id, 'versions'], enabled: !isNew, queryFn: ({ signal }) => api<{ data: TemplateVersion[] }>(`/api/templates/${id}/versions`, { signal }) });

  const [draft, setDraft] = useState<Draft>(toDraft());
  const [locale, setLocale] = useState<Locale>('en');
  const [previewContact, setPreviewContact] = useState<Contact | null>(null);
  useEffect(() => { if (template.data) setDraft(toDraft(template.data)); }, [template.data]);

  const part = draft.content[locale];
  const setPart = (patch: Partial<EmailPart & SmsPart>) => setDraft({ ...draft, content: { ...draft.content, [locale]: { ...part, ...patch } } });

  const save = useMutation({
    mutationFn: () => isNew
      ? api<TemplateDetail>('/api/templates', { method: 'POST', body: { name: draft.name, description: draft.description, channel: draft.channel, purpose: draft.purpose, content: toContent(draft) } })
      : api<TemplateDetail>(`/api/templates/${id}`, { method: 'PUT', body: { name: draft.name, description: draft.description, purpose: draft.purpose, content: toContent(draft) } }),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      qc.setQueryData(['template', saved.id], saved);
      void qc.invalidateQueries({ queryKey: ['template', saved.id, 'versions'] });
      if (isNew) navigate(`/templates/${saved.id}`, { replace: true });
    },
  });
  const restore = useMutation({
    mutationFn: (version: number) => api<TemplateDetail>(`/api/templates/${id}/versions/${version}/restore`, { method: 'POST' }),
    onSuccess: (saved) => { qc.setQueryData(['template', saved.id], saved); void qc.invalidateQueries({ queryKey: ['template', saved.id, 'versions'] }); },
  });

  // Live preview of the unsaved draft.
  const previewInput = useDebouncedValue(useMemo(() => ({ channel: draft.channel, purpose: draft.purpose, content: toContent(draft), locale, contact_id: previewContact?.id, data: { date: '12 January 2026, 9:30' } }), [draft, locale, previewContact]));
  const hasContent = draft.channel === 'sms' ? !!previewInput.content.en && !!(previewInput.content.en as SmsPart).body : !!(previewInput.content.en as EmailPart).html;
  const preview = useQuery({
    queryKey: ['template-preview', previewInput],
    enabled: hasContent,
    retry: false,
    queryFn: ({ signal }) => api<{ locale: Locale; subject?: string; html?: string; text: string; sms?: ReturnType<typeof smsInfo> }>('/api/templates/preview', { method: 'POST', body: previewInput, signal }),
  });
  const sms = draft.channel === 'sms' ? smsInfo(part.body) : null;

  if (!isNew && template.isPending) return <div className="pe-center"><Spinner /></div>;
  if (!isNew && template.error) return <ErrorBanner error={template.error} />;

  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const onSubmit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

  return (
    <section>
      <div className="pe-page-header"><Link to="/templates" className="pe-muted">{t('templates.backToList')}</Link></div>
      <form onSubmit={onSubmit} className="pe-stack" noValidate>
        <div className="pe-page-header">
          <h1>{isNew ? t('templates.new') : draft.name || t('templates.untitled')}</h1>
          {!isNew && template.data && <Badge tone="brand">v{template.data.current_version}</Badge>}
          <span className="pe-spacer" />
          {canEdit && <Button type="submit" variant="primary" busy={save.isPending}>{isNew ? t('templates.create') : t('templates.saveVersion')}</Button>}
        </div>
        {save.error && <ErrorBanner error={save.error} />}

        <div className="pe-card pe-form-grid">
          <TextField label={t('templates.field.name')} value={draft.name} disabled={!canEdit} error={fieldErrors.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <SelectField label={t('templates.field.channel')} value={draft.channel} disabled={!isNew || !canEdit} onChange={(e) => setDraft({ ...draft, channel: e.target.value as Channel })}>
            <option value="email">{t('consent.channel_email')}</option>
            <option value="sms">{t('consent.channel_sms')}</option>
          </SelectField>
          <SelectField label={t('templates.field.purpose')} value={draft.purpose} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, purpose: e.target.value as Purpose })}>
            <option value="care">{t('consent.purpose.care')}</option>
            <option value="marketing">{t('consent.purpose.marketing')}</option>
          </SelectField>
          <TextField label={t('templates.field.description')} value={draft.description} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </div>
        <p className="pe-muted">{draft.purpose === 'care' ? t('templates.purposeCare') : t('templates.purposeMarketing')}</p>

        <div className="pe-grid-2">
          <div className="pe-card pe-stack">
            <div className="pe-tabs" role="tablist" aria-label={t('templates.language')}>
              {(['en', 'ar'] as const).map((l) => (
                <button key={l} type="button" role="tab" aria-selected={locale === l} className="pe-tab" onClick={() => setLocale(l)}>
                  {l === 'en' ? 'English' : 'العربية'}{l === 'ar' && <small className="pe-muted"> · {t('templates.optional')}</small>}
                </button>
              ))}
            </div>
            {draft.channel === 'email' ? (
              <>
                <TextField label={t('templates.field.subject')} dir={locale === 'ar' ? 'rtl' : 'ltr'} value={part.subject} disabled={!canEdit} error={fieldErrors[`content.${locale}.subject`]} onChange={(e) => setPart({ subject: e.target.value })} />
                <div className="pe-field">
                  <label htmlFor={`html-${locale}`}>{t('templates.field.html')}</label>
                  <textarea id={`html-${locale}`} className="pe-code" dir="ltr" rows={14} value={part.html} disabled={!canEdit} onChange={(e) => setPart({ html: e.target.value })} aria-invalid={fieldErrors[`content.${locale}.html`] ? true : undefined} />
                  {fieldErrors[`content.${locale}.html`] && <small className="pe-field__error">{fieldErrors[`content.${locale}.html`]}</small>}
                </div>
                <div className="pe-field">
                  <label htmlFor={`text-${locale}`}>{t('templates.field.text')}</label>
                  <textarea id={`text-${locale}`} className="pe-code" dir={locale === 'ar' ? 'rtl' : 'ltr'} rows={4} value={part.text ?? ''} disabled={!canEdit} placeholder={t('templates.textPlaceholder')} onChange={(e) => setPart({ text: e.target.value })} />
                </div>
              </>
            ) : (
              <div className="pe-field">
                <label htmlFor={`sms-${locale}`}>{t('templates.field.body')}</label>
                <textarea id={`sms-${locale}`} dir={locale === 'ar' ? 'rtl' : 'ltr'} rows={5} value={part.body} disabled={!canEdit} onChange={(e) => setPart({ body: e.target.value })} aria-invalid={fieldErrors[`content.${locale}.body`] ? true : undefined} />
                {sms && <small className="pe-muted" data-testid="sms-counter">{t('templates.smsCounter', { units: sms.units, segments: sms.segments, encoding: sms.encoding })}</small>}
                {fieldErrors[`content.${locale}.body`] && <small className="pe-field__error">{fieldErrors[`content.${locale}.body`]}</small>}
              </div>
            )}
            <details>
              <summary>{t('templates.variablesTitle')}</summary>
              <ul className="pe-muted" dir="ltr">
                <li><code>{'{{ contact.first_name }}'}</code>, <code>{'{{ contact.last_name }}'}</code>, <code>{'{{ contact.external_id }}'}</code></li>
                <li><code>{'{{ contact.attributes.plan }}'}</code></li>
                <li><code>{'{{ data.date }}'}</code> {t('templates.variablesData')}</li>
                <li><code>{'{{ brand.name }}'}</code>, <code>{'{{ unsubscribe_url }}'}</code></li>
                <li><code>{'{% if contact.first_name %}…{% endif %}'}</code></li>
              </ul>
            </details>
          </div>

          <div className="pe-card pe-stack">
            <div className="pe-row">
              <h2 style={{ margin: 0 }}>{t('templates.preview')}</h2>
              <span className="pe-spacer" />
              <ContactPicker label={t('templates.previewAs')} placeholder={t('templates.previewAsPlaceholder')} value={previewContact} onChange={setPreviewContact} />
            </div>
            {preview.error ? <ErrorBanner error={preview.error} /> : !hasContent ? <p className="pe-muted">{t('templates.previewEmpty')}</p> : !preview.data ? <Spinner /> : draft.channel === 'email' ? (
              <>
                <div><span className="pe-muted">{t('templates.field.subject')}:</span> <strong>{preview.data.subject}</strong></div>
                <iframe title={t('templates.preview')} className="pe-preview" sandbox="" srcDoc={preview.data.html} />
              </>
            ) : (
              <div className="pe-sms-bubble" dir={preview.data.locale === 'ar' ? 'rtl' : 'ltr'}>{preview.data.text}</div>
            )}
            {preview.data && preview.data.locale !== locale && <small className="pe-muted">{t('templates.fallbackNote')}</small>}
          </div>
        </div>

        {!isNew && versions.data && (
          <div className="pe-card pe-stack">
            <h2>{t('templates.history')}</h2>
            <ul className="pe-timeline">
              {versions.data.data.map((v) => (
                <li key={v.version} className="pe-row">
                  <strong>v{v.version}</strong>
                  <span className="pe-muted">{formatDate(v.created_at)}{v.created_by_email ? ` · ${v.created_by_email}` : ''}</span>
                  <span className="pe-spacer" />
                  {v.version === template.data?.current_version ? <Badge tone="success">{t('templates.current')}</Badge>
                    : canEdit && <Button variant="ghost" busy={restore.isPending && restore.variables === v.version} onClick={() => restore.mutate(v.version)}>{t('templates.restore')}</Button>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </section>
  );
}
