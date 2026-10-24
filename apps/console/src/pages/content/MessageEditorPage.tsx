// Push and WhatsApp editors: authored now (with live, Liquid-rendered phone previews), sent once their providers are
// connected. Saving works like other templates: each content change is a new version.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BatteryFull, ExternalLink, FileText, Info, Phone, Plus, Reply, Signal, X } from 'lucide-react';
import { api, ApiError } from '../../api/client.ts';
import type { Asset, Purpose, PushPart, TemplateDetail, WhatsAppButton, WhatsAppPart } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { AssetPicker, assetUrl } from '../../components/AssetPicker.tsx';
import { Badge, Button, ErrorBanner, SelectField, Spinner, TextField } from '../../components/ui.tsx';
import { Pill } from '../../components/bits.tsx';
import { FolderSelect, TagsField } from './common.tsx';

type Locale = 'en' | 'ar';
type Kind = 'push' | 'whatsapp';
const blankPush = (): PushPart => ({ title: '', body: '' });
const blankWa = (): WhatsAppPart => ({ header: { type: 'none' }, body: '', buttons: [], category: 'marketing', approval: 'draft' });
const dirOf = (l: Locale) => (l === 'ar' ? 'rtl' : 'ltr');

interface Draft<P> { name: string; purpose: Purpose; folder_id: string | null; tags: string[]; content: Record<Locale, P> }

function useDebounced<T>(v: T, ms = 400) {
  const [x, setX] = useState(v);
  useEffect(() => { const id = setTimeout(() => setX(v), ms); return () => clearTimeout(id); }, [v, ms]);
  return x;
}

/** Push parts without empty optional fields; WhatsApp parts with only the header fields its type uses. */
function cleanPart(kind: Kind, p: PushPart | WhatsAppPart): PushPart | WhatsAppPart {
  if (kind === 'push') {
    const x = p as PushPart;
    return { title: x.title, body: x.body, ...(x.image_asset_id ? { image_asset_id: x.image_asset_id } : {}), ...(x.deep_link?.trim() ? { deep_link: x.deep_link.trim() } : {}), ...(x.data && Object.keys(x.data).length ? { data: x.data } : {}) };
  }
  const w = p as WhatsAppPart;
  const header = w.header.type === 'none' ? { type: 'none' as const } : w.header.type === 'text' ? { type: 'text' as const, text: w.header.text ?? '' } : { type: w.header.type, ...(w.header.asset_id ? { asset_id: w.header.asset_id } : {}) };
  return { ...w, header, ...(w.footer?.trim() ? { footer: w.footer } : { footer: undefined }) };
}
const isEmpty = (kind: Kind, p: PushPart | WhatsAppPart) => (kind === 'push' ? !(p as PushPart).title.trim() && !(p as PushPart).body.trim() : !(p as WhatsAppPart).body.trim());

export function MessageEditorPage() {
  const { channel, id } = useParams();
  const kind: Kind = channel === 'whatsapp' ? 'whatsapp' : 'push';
  const isNew = !id || id === 'new';
  const [search] = useSearchParams();
  const { t } = useTranslation();
  const canEdit = hasRole(useUser(), 'marketer');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const template = useQuery({ queryKey: ['template', id], enabled: !isNew, queryFn: ({ signal }) => api<TemplateDetail>(`/api/templates/${id}`, { signal }) });
  const blank = () => (kind === 'push' ? blankPush() : blankWa());
  const [draft, setDraft] = useState<Draft<PushPart | WhatsAppPart>>(() => ({ name: '', purpose: 'care', folder_id: search.get('folder'), tags: [], content: { en: blank(), ar: blank() } }));
  const [locale, setLocale] = useState<Locale>('en');
  useEffect(() => {
    const d = template.data;
    if (d) setDraft({ name: d.name, purpose: d.purpose, folder_id: d.folder_id, tags: d.tags, content: { en: { ...blank(), ...(d.content.en as object) }, ar: { ...blank(), ...((d.content.ar as object | undefined) ?? {}) } } });
  }, [template.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const part = draft.content[locale];
  const setPart = (patch: Partial<PushPart & WhatsAppPart>) => setDraft((d) => ({ ...d, content: { ...d.content, [locale]: { ...d.content[locale], ...patch } } }));
  const content = useMemo(() => {
    const en = cleanPart(kind, draft.content.en);
    return isEmpty(kind, draft.content.ar) ? { en } : { en, ar: cleanPart(kind, draft.content.ar) };
  }, [draft.content, kind]);

  const save = useMutation({
    mutationFn: () => isNew
      ? api<TemplateDetail>('/api/templates', { method: 'POST', body: { name: draft.name, channel: kind, purpose: draft.purpose, folder_id: draft.folder_id, tags: draft.tags, content } })
      : api<TemplateDetail>(`/api/templates/${id}`, { method: 'PUT', body: { name: draft.name, purpose: draft.purpose, folder_id: draft.folder_id, tags: draft.tags, content } }),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ['content'] });
      qc.setQueryData(['template', saved.id], saved);
      if (isNew) navigate(`/content/${kind}/${saved.id}`, { replace: true });
    },
  });
  const previewInput = useDebounced(useMemo(() => ({ channel: kind, content, locale }), [kind, content, locale]));
  const preview = useQuery<{ locale: Locale; fields: Record<string, string> }>({
    queryKey: ['message-preview', previewInput],
    // The debounced input, not the live draft: otherwise a stale (blank) input is previewed right after loading.
    enabled: !isEmpty(kind, previewInput.content.en),
    retry: false,
    placeholderData: (prev) => prev,
    queryFn: ({ signal }) => api<{ locale: Locale; fields: Record<string, string> }>('/api/templates/preview', { method: 'POST', body: previewInput, signal }),
  });
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const err = (f: string) => fieldErrors[`content.${locale}.${f}`];

  if (!isNew && template.isPending) return <div className="pe-center"><Spinner /></div>;
  if (!isNew && template.error) return <ErrorBanner error={template.error} />;

  return (
    <section className="pe-stack">
      <div className="pe-page-header"><Link to="/content" className="pe-muted">{t('content.backToLibrary')}</Link></div>
      <div className="pe-page-header">
        <h1>{isNew ? t(`content.new.${kind}`) : draft.name}</h1>
        {!isNew && template.data && <Badge tone="brand">v{template.data.current_version}</Badge>}
        <Pill tone="info" dot>{t('content.authorOnly')}</Pill>
        <span className="pe-spacer" />
        {canEdit && <Button variant="primary" busy={save.isPending} disabled={!draft.name.trim()} onClick={() => save.mutate()}>{isNew ? t('templates.create') : t('templates.saveVersion')}</Button>}
      </div>
      {save.error && <ErrorBanner error={save.error} />}
      {save.isSuccess && <p className="pe-ok" role="status">{t('content.saved')}</p>}

      <div className="pe-card pe-form-grid">
        <TextField label={t('templates.field.name')} value={draft.name} disabled={!canEdit} error={fieldErrors.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <SelectField label={t('templates.field.purpose')} value={draft.purpose} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, purpose: e.target.value as Purpose })}>
          <option value="care">{t('consent.purpose.care')}</option>
          <option value="marketing">{t('consent.purpose.marketing')}</option>
        </SelectField>
        <FolderSelect value={draft.folder_id} disabled={!canEdit} onChange={(folder_id) => setDraft({ ...draft, folder_id })} />
        <TagsField key={template.data?.id ?? 'new'} value={draft.tags} disabled={!canEdit} onChange={(tags) => setDraft({ ...draft, tags })} />
      </div>
      <p className="pe-alert pe-alert--info"><Info aria-hidden="true" /> {t(`content.sendLater.${kind}`)}</p>

      <div className="pe-grid-2 pe-grid-2--wide-first pe-msgeditor">
        <div className="pe-card pe-stack">
          <div className="pe-tabs" role="tablist" aria-label={t('templates.language')}>
            {(['en', 'ar'] as const).map((l) => (
              <button key={l} type="button" role="tab" aria-selected={locale === l} className="pe-tab" onClick={() => setLocale(l)}>
                {l === 'en' ? 'English' : 'العربية'}{l === 'ar' && <small className="pe-muted"> · {t('templates.optional')}</small>}
              </button>
            ))}
          </div>
          {kind === 'push'
            ? <PushFields part={part as PushPart} locale={locale} disabled={!canEdit} err={err} onChange={setPart} />
            : <WhatsAppFields part={part as WhatsAppPart} locale={locale} disabled={!canEdit} err={err} onChange={setPart} />}
          <small className="pe-muted">{t('content.liquidHint')}</small>
        </div>
        <aside className="pe-card pe-stack pe-msgeditor__preview" aria-label={t('templates.preview')}>
          <h2>{t('templates.preview')}</h2>
          {preview.error ? <ErrorBanner error={preview.error} /> : kind === 'push'
            ? <PushPreview part={part as PushPart} fields={preview.data?.fields} dir={dirOf(locale)} />
            : <WhatsAppPreview part={part as WhatsAppPart} fields={preview.data?.fields} dir={dirOf(locale)} />}
        </aside>
      </div>
    </section>
  );
}

interface FieldsProps<P> { part: P; locale: Locale; disabled: boolean; err: (f: string) => string | undefined; onChange: (p: Partial<PushPart & WhatsAppPart>) => void }

function PushFields({ part, locale, disabled, err, onChange }: FieldsProps<PushPart>) {
  const { t } = useTranslation();
  const data = Object.entries(part.data ?? {});
  const setData = (entries: [string, string][]) => onChange({ data: Object.fromEntries(entries) });
  return (
    <div className="pe-stack">
      <TextField label={t('content.push.title')} dir={dirOf(locale)} value={part.title} disabled={disabled} error={err('title')} maxLength={100} hint={t('content.push.titleHint', { n: part.title.length })} onChange={(e) => onChange({ title: e.target.value })} />
      <div className="pe-field">
        <label htmlFor={`push-body-${locale}`}>{t('content.push.body')}</label>
        <textarea id={`push-body-${locale}`} dir={dirOf(locale)} rows={4} maxLength={500} value={part.body} disabled={disabled} onChange={(e) => onChange({ body: e.target.value })} aria-invalid={err('body') ? true : undefined} />
        <small className={err('body') ? 'pe-field__error' : 'pe-muted'}>{err('body') ?? t('content.push.bodyHint', { n: part.body.length })}</small>
      </div>
      <TextField label={t('content.push.deepLink')} dir="ltr" placeholder="pura://appointments" value={part.deep_link ?? ''} disabled={disabled} error={err('deep_link')} onChange={(e) => onChange({ deep_link: e.target.value })} />
      <AssetPicker kind="image" label={t('content.push.image')} value={part.image_asset_id} onPick={(a: Asset | null) => onChange({ image_asset_id: a?.id })} />
      <fieldset className="pe-fieldset">
        <legend>{t('content.push.data')}</legend>
        {data.map(([k, v], i) => (
          <div key={i} className="pe-pairrow">
            <TextField label={t('content.push.key')} dir="ltr" value={k} disabled={disabled} onChange={(e) => setData(data.map((x, j) => (j === i ? [e.target.value.replace(/[^A-Za-z0-9_]/g, '_'), x[1]] : x)))} />
            <TextField label={t('content.push.value')} dir="ltr" value={v} disabled={disabled} onChange={(e) => setData(data.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
            <button type="button" className="pe-icon-button" aria-label={t('integrations.remove')} onClick={() => setData(data.filter((_, j) => j !== i))}><X aria-hidden="true" /></button>
          </div>
        ))}
        {data.length < 10 && !disabled && <div><Button variant="ghost" onClick={() => setData([...data, [`key${data.length + 1}`, '']])}><Plus aria-hidden="true" />{t('content.push.addData')}</Button></div>}
      </fieldset>
    </div>
  );
}

function WhatsAppFields({ part, locale, disabled, err, onChange }: FieldsProps<WhatsAppPart>) {
  const { t } = useTranslation();
  const h = part.header;
  const setButtons = (buttons: WhatsAppButton[]) => onChange({ buttons });
  return (
    <div className="pe-stack">
      <div className="pe-form-grid">
        <SelectField label={t('content.wa.category')} value={part.category} disabled={disabled} onChange={(e) => onChange({ category: e.target.value as WhatsAppPart['category'] })}>
          <option value="marketing">{t('content.wa.categories.marketing')}</option>
          <option value="utility">{t('content.wa.categories.utility')}</option>
        </SelectField>
        <SelectField label={t('content.wa.approval')} value={part.approval} disabled={disabled} onChange={(e) => onChange({ approval: e.target.value as WhatsAppPart['approval'] })}>
          {(['draft', 'submitted', 'approved', 'rejected'] as const).map((a) => <option key={a} value={a}>{t(`content.wa.approvals.${a}`)}</option>)}
        </SelectField>
        <SelectField label={t('content.wa.header')} value={h.type} disabled={disabled} onChange={(e) => onChange({ header: { type: e.target.value as WhatsAppPart['header']['type'] } })}>
          {(['none', 'text', 'image', 'video', 'document'] as const).map((x) => <option key={x} value={x}>{t(`content.wa.headers.${x}`)}</option>)}
        </SelectField>
      </div>
      {h.type === 'text' && <TextField label={t('content.wa.headerText')} dir={dirOf(locale)} maxLength={60} value={h.text ?? ''} disabled={disabled} error={err('header')} onChange={(e) => onChange({ header: { ...h, text: e.target.value } })} />}
      {(h.type === 'image' || h.type === 'video' || h.type === 'document') && (
        <AssetPicker kind={h.type} pdfOnly={h.type === 'document'} label={t(`content.wa.headers.${h.type}`)} value={h.asset_id} onPick={(a) => onChange({ header: { ...h, asset_id: a?.id } })} />
      )}
      <div className="pe-field">
        <label htmlFor={`wa-body-${locale}`}>{t('content.wa.body')}</label>
        <textarea id={`wa-body-${locale}`} dir={dirOf(locale)} rows={6} maxLength={1024} value={part.body} disabled={disabled} onChange={(e) => onChange({ body: e.target.value })} aria-invalid={err('body') ? true : undefined} />
        <small className={err('body') ? 'pe-field__error' : 'pe-muted'}>{err('body') ?? t('content.wa.bodyHint', { n: part.body.length })}</small>
      </div>
      <TextField label={t('content.wa.footer')} dir={dirOf(locale)} maxLength={60} value={part.footer ?? ''} disabled={disabled} onChange={(e) => onChange({ footer: e.target.value })} />
      <fieldset className="pe-fieldset">
        <legend>{t('content.wa.buttons')}</legend>
        {part.buttons.map((b, i) => (
          <div key={i} className="pe-pairrow pe-pairrow--3">
            <SelectField label={t('content.wa.buttonType')} value={b.type} disabled={disabled} onChange={(e) => {
              const type = e.target.value as WhatsAppButton['type'];
              const next: WhatsAppButton = type === 'url' ? { type, text: b.text, url: 'https://' } : type === 'call' ? { type, text: b.text, phone: '+9715' } : { type, text: b.text };
              setButtons(part.buttons.map((x, j) => (j === i ? next : x)));
            }}>
              {(['quick_reply', 'url', 'call'] as const).map((x) => <option key={x} value={x}>{t(`content.wa.buttonTypes.${x}`)}</option>)}
            </SelectField>
            <TextField label={t('content.wa.buttonText')} dir={dirOf(locale)} maxLength={25} value={b.text} disabled={disabled} onChange={(e) => setButtons(part.buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
            {b.type === 'url' && <TextField label="URL" dir="ltr" value={b.url} disabled={disabled} error={err(`buttons.${i}.url`)} onChange={(e) => setButtons(part.buttons.map((x, j) => (j === i ? { ...b, url: e.target.value } : x)))} />}
            {b.type === 'call' && <TextField label={t('content.wa.phone')} dir="ltr" value={b.phone} disabled={disabled} error={err(`buttons.${i}.phone`)} onChange={(e) => setButtons(part.buttons.map((x, j) => (j === i ? { ...b, phone: e.target.value } : x)))} />}
            {b.type === 'quick_reply' && <span />}
            <button type="button" className="pe-icon-button" aria-label={t('integrations.remove')} onClick={() => setButtons(part.buttons.filter((_, j) => j !== i))}><X aria-hidden="true" /></button>
          </div>
        ))}
        {part.buttons.length < 3 && !disabled && <div><Button variant="ghost" onClick={() => setButtons([...part.buttons, { type: 'quick_reply', text: '' }])}><Plus aria-hidden="true" />{t('content.wa.addButton')}</Button></div>}
      </fieldset>
    </div>
  );
}

function PushPreview({ part, fields, dir }: { part: PushPart; fields?: Record<string, string>; dir: 'ltr' | 'rtl' }) {
  const { t } = useTranslation();
  const [os, setOs] = useState<'ios' | 'android'>('ios');
  return (
    <div className="pe-stack">
      <div className="pe-tabs" role="tablist" aria-label={t('content.push.device')}>
        {(['ios', 'android'] as const).map((x) => <button key={x} type="button" role="tab" aria-selected={os === x} className="pe-tab" onClick={() => setOs(x)}>{x === 'ios' ? 'iOS' : 'Android'}</button>)}
      </div>
      <div className="pe-phone" data-os={os}>
        <div className="pe-phone__status" aria-hidden="true"><span>9:41</span><span className="pe-row"><Signal /><BatteryFull /></span></div>
        <div className="pe-phone__clock" aria-hidden="true">9:41</div>
        <div className="pe-notif" dir={dir} data-testid="push-preview">
          <div className="pe-notif__app"><span className="pe-notif__icon" aria-hidden="true" />{t('content.push.appName')}<span className="pe-muted">· {t('content.push.now')}</span></div>
          <div className="pe-notif__main">
            <div>
              <strong>{fields?.title ?? part.title ?? ''}</strong>
              <p>{fields?.body ?? part.body}</p>
            </div>
            {part.image_asset_id && <img src={assetUrl(part.image_asset_id)} alt="" />}
          </div>
        </div>
      </div>
    </div>
  );
}

function WhatsAppPreview({ part, fields, dir }: { part: WhatsAppPart; fields?: Record<string, string>; dir: 'ltr' | 'rtl' }) {
  const { t } = useTranslation();
  const h = part.header;
  return (
    <div className="pe-wa" data-testid="wa-preview">
      <div className="pe-wa__top"><span className="pe-notif__icon" aria-hidden="true" /><strong>{t('content.push.appName')}</strong><small>{t('content.wa.business')}</small></div>
      <div className="pe-wa__chat">
        <div className="pe-wa__bubble" dir={dir}>
          {h.type === 'text' && <strong className="pe-wa__header">{fields?.['header.text'] ?? h.text}</strong>}
          {h.type === 'image' && (h.asset_id ? <img src={assetUrl(h.asset_id)} alt="" className="pe-wa__media" /> : <div className="pe-wa__media pe-wa__media--empty" />)}
          {h.type === 'video' && (h.asset_id ? <video src={assetUrl(h.asset_id)} className="pe-wa__media" muted preload="metadata" /> : <div className="pe-wa__media pe-wa__media--empty" />)}
          {h.type === 'document' && <div className="pe-wa__doc"><FileText aria-hidden="true" /><span>PDF</span></div>}
          <p className="pe-wa__body">{fields?.body ?? part.body}</p>
          {(fields?.footer ?? part.footer) && <small className="pe-wa__footer">{fields?.footer ?? part.footer}</small>}
          <span className="pe-wa__time">9:41</span>
        </div>
        {part.buttons.map((b, i) => (
          <div key={i} className="pe-wa__button" dir={dir}>
            {b.type === 'url' ? <ExternalLink aria-hidden="true" /> : b.type === 'call' ? <Phone aria-hidden="true" /> : <Reply aria-hidden="true" />}
            {b.text || '…'}
          </div>
        ))}
      </div>
    </div>
  );
}
