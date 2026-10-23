// Contact import wizard: upload a CSV or Excel file, map its columns, check it with a dry run, then import in
// chunks. Parsing happens in the browser; the API applies every row with the normal contact rules.
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Papa from 'papaparse';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CloudUpload, Download, FileSpreadsheet, PartyPopper, Sparkles, X } from 'lucide-react';
import { api } from '../../api/client.ts';
import { Button, ErrorBanner, Ltr, useFormatDate } from '../../components/ui.tsx';
import { PageHeader, Pill } from '../../components/bits.tsx';

const MAX_ROWS = 20_000;
const MAX_BYTES = 10 * 1024 * 1024;
const CHUNK = 500;

type Target =
  | 'skip' | 'external_id' | 'email' | 'phone' | 'first_name' | 'last_name' | 'preferred_language' | 'timezone' | 'attribute'
  | 'consent.email.care' | 'consent.email.marketing' | 'consent.sms.care' | 'consent.sms.marketing';
const TARGETS: Target[] = ['external_id', 'email', 'phone', 'first_name', 'last_name', 'preferred_language', 'timezone', 'consent.email.care', 'consent.email.marketing', 'consent.sms.care', 'consent.sms.marketing', 'attribute', 'skip'];

/** Header spellings we recognise, normalised to lowercase letters and digits. */
const SYNONYMS: Record<Exclude<Target, 'skip' | 'attribute'>, string[]> = {
  external_id: ['externalid', 'memberid', 'mrn', 'id', 'memberno', 'membernumber', 'patientid'],
  email: ['email', 'emailaddress', 'mail'],
  phone: ['phone', 'mobile', 'mobilenumber', 'phonenumber', 'msisdn', 'cell'],
  first_name: ['firstname', 'givenname', 'first', 'fname'],
  last_name: ['lastname', 'surname', 'familyname', 'last', 'lname'],
  preferred_language: ['language', 'preferredlanguage', 'lang', 'locale'],
  timezone: ['timezone', 'tz', 'zone'],
  'consent.email.care': ['emailcare', 'consentemailcare', 'careemail'],
  'consent.email.marketing': ['emailmarketing', 'consentemailmarketing', 'marketingemail', 'emailoptin'],
  'consent.sms.care': ['smscare', 'consentsmscare', 'caresms'],
  'consent.sms.marketing': ['smsmarketing', 'consentsmsmarketing', 'marketingsms', 'smsoptin'],
};
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
function guess(header: string, taken: Set<Target>): Target {
  const n = norm(header);
  for (const [target, names] of Object.entries(SYNONYMS) as [Target, string[]][]) if (!taken.has(target) && names.includes(n)) return target;
  return n ? 'attribute' : 'skip';
}
const attrKey = (h: string) => {
  const k = h.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return /^[A-Za-z]/.test(k) ? k : `a_${k}`.slice(0, 64);
};
const consentValue = (v: string) => {
  const s = v.trim().toLowerCase();
  if (['granted', 'yes', 'y', 'true', '1', 'opt-in', 'optin', 'نعم'].includes(s)) return 'granted';
  if (['denied', 'no', 'n', 'false', '0', 'opt-out', 'optout', 'لا'].includes(s)) return 'denied';
  return s;
};

interface Parsed { name: string; headers: string[]; rows: string[][] }
interface ChunkResult { created: number; updated: number; skipped: number; errors: { row: number; message: string; fields?: { path: string; message: string }[] }[] }
type Mode = 'upsert' | 'create_only' | 'update_only';

async function parseFile(file: File): Promise<Parsed> {
  if (file.size > MAX_BYTES) throw new Error('too_big');
  const isExcel = /\.xlsx$/i.test(file.name) || file.type.includes('spreadsheetml');
  let table: string[][];
  if (isExcel) {
    const { readSheet } = await import('read-excel-file/browser');
    const raw = await readSheet(file);
    table = raw.map((r) => r.map((c) => (c === null || c === undefined ? '' : c instanceof Date ? c.toISOString() : String(c))));
  } else {
    const text = await file.text();
    const res = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
    table = res.data;
  }
  const [headers = [], ...rows] = table;
  if (!headers.length) throw new Error('empty');
  if (rows.length > MAX_ROWS) throw new Error('too_many');
  return { name: file.name, headers: headers.map((h) => String(h).trim()), rows };
}

function toContact(row: string[], mapping: Target[], headers: string[]) {
  const out: Record<string, unknown> = {};
  const consent: Record<string, Record<string, string>> = {};
  mapping.forEach((target, i) => {
    const v = (row[i] ?? '').trim();
    if (!v || target === 'skip') return;
    if (target.startsWith('consent.')) {
      const [, channel, purpose] = target.split('.') as [string, string, string];
      (consent[channel] ??= {})[purpose] = consentValue(v);
    } else if (target === 'attribute') {
      out[attrKey(headers[i]!)] = /^-?\d+(\.\d+)?$/.test(v) && v.length < 16 ? Number(v) : v;
    } else out[target] = target === 'preferred_language' ? v.toLowerCase() : v;
  });
  if (Object.keys(consent).length) out.consent = consent;
  return out;
}

const SAMPLE = [
  'external_id,email,phone,first_name,last_name,language,time_zone,email_marketing,sms_marketing,membership_tier',
  'MBR-TEST-7001,test.member.a@example.com,+971500000701,Test,Member A,en,Asia/Dubai,granted,denied,gold',
  'MBR-TEST-7002,test.member.b@example.com,+971500000702,Test,Member B,ar,Asia/Dubai,yes,yes,silver',
  'MBR-TEST-7003,test.member.c@example.com,,Test,Member C,en,Asia/Dubai,no,,platinum',
].join('\n');

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ContactImportPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const formatDate = useFormatDate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(0);
  const [drag, setDrag] = useState(false);
  const [file, setFile] = useState<Parsed | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Target[]>([]);
  const [mode, setMode] = useState<Mode>('upsert');
  const [review, setReview] = useState<ChunkResult | null>(null);
  const [result, setResult] = useState<ChunkResult | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const history = useQuery({ queryKey: ['contact-imports'], queryFn: ({ signal }) => api<{ data: { id: string; at: string; details: Record<string, number | string>; actor_name: string | null; actor_email: string | null }[] }>('/api/contacts/imports', { signal }) });
  const num = (n: number) => n.toLocaleString(i18n.language);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileError(null); setReview(null); setResult(null);
    try {
      const parsed = await parseFile(f);
      const taken = new Set<Target>();
      const guessed = parsed.headers.map((h) => { const g = guess(h, taken); if (g !== 'attribute' && g !== 'skip') taken.add(g); return g; });
      setFile(parsed); setMapping(guessed);
    } catch (e) {
      setFile(null);
      setFileError(t(`contacts.import.fileErrors.${(e as Error).message}`, { defaultValue: t('contacts.import.fileErrors.unreadable') }));
    }
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); void onFile(e.dataTransfer.files[0]); };

  const hasId = mapping.includes('external_id') || mapping.includes('email');
  const duplicates = useMemo(() => {
    const seen = new Set<Target>();
    return new Set(mapping.filter((m) => m !== 'attribute' && m !== 'skip' && (seen.has(m) || (seen.add(m), false))));
  }, [mapping]);
  const autoMatched = mapping.filter((m) => m !== 'attribute' && m !== 'skip').length;

  /** Sends every chunk; the dry run checks everything first, the real run writes and reports progress. */
  const send = async (dryRun: boolean, m: Mode = mode) => {
    const total: ChunkResult = { created: 0, updated: 0, skipped: 0, errors: [] };
    const rows = file!.rows.map((r) => toContact(r, mapping, file!.headers));
    for (let i = 0; i < rows.length; i += CHUNK) {
      const r = await api<ChunkResult>('/api/contacts/import', { method: 'POST', body: { rows: rows.slice(i, i + CHUNK), mode: m, dry_run: dryRun, file_name: file!.name, first_row: i + 2 } });
      total.created += r.created; total.updated += r.updated; total.skipped += r.skipped; total.errors.push(...r.errors);
      if (!dryRun) setProgress(Math.min(rows.length, i + CHUNK) / rows.length);
    }
    return total;
  };
  const runReview = async (m: Mode = mode) => {
    setBusy(true); setError(null);
    try { setReview(await send(true, m)); setStep(2); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const runImport = async () => {
    setBusy(true); setError(null); setProgress(0); setStep(3);
    try {
      setResult(await send(false));
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      void qc.invalidateQueries({ queryKey: ['contact-imports'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const errorReport = (r: ChunkResult) => download(`${file?.name.replace(/\.[^.]+$/, '') ?? 'import'}-errors.csv`,
    ['row,problem', ...r.errors.map((e) => `${e.row},"${[e.message, ...(e.fields ?? []).map((f) => `${f.path}: ${f.message}`)].join('; ').replace(/"/g, '""')}"`)].join('\n'));

  const STEPS = ['upload', 'map', 'review', 'import'] as const;
  return (
    <section className="pe-import">
      <div className="pe-page-header"><Link to="/contacts" className="pe-muted">{t('contacts.backToList')}</Link></div>
      <PageHeader title={t('contacts.import.title')} subtitle={t('contacts.import.subtitle')} />

      <ol className="pe-stepper" aria-label={t('contacts.import.steps')}>
        {STEPS.map((s, i) => (
          <li key={s} data-state={i < step ? 'done' : i === step ? 'current' : 'todo'} aria-current={i === step ? 'step' : undefined}>
            <span className="pe-stepper__dot">{i < step ? <Check aria-hidden="true" /> : i + 1}</span>
            <span>{t(`contacts.import.step.${s}`)}</span>
          </li>
        ))}
      </ol>

      <div className="pe-card">
        {step === 0 && (
          <div className="pe-stack">
            <label
              className="pe-dropzone" data-drag={drag || undefined}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
            >
              <input ref={fileInput} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="pe-visually-hidden" onChange={(e) => void onFile(e.target.files?.[0])} aria-label={t('contacts.import.chooseFile')} />
              <span className="pe-dropzone__icon" aria-hidden="true"><CloudUpload /></span>
              <strong>{t('contacts.import.drop')}</strong>
              <span className="pe-muted">{t('contacts.import.dropHint', { rows: num(MAX_ROWS) })}</span>
            </label>
            <div className="pe-row">
              <button type="button" className="pe-linklike pe-row" style={{ gap: 6 }} onClick={() => download('pure-engage-sample.csv', SAMPLE)}><Download aria-hidden="true" width={16} />{t('contacts.import.sample')}</button>
            </div>
            {fileError && <div className="pe-alert pe-alert--danger" role="alert">{fileError}</div>}
            {file && (
              <div className="pe-filecard">
                <FileSpreadsheet aria-hidden="true" />
                <div className="pe-list__main"><strong>{file.name}</strong><small className="pe-muted">{t('contacts.import.detected', { rows: num(file.rows.length), cols: file.headers.length })}</small></div>
                <button type="button" className="pe-icon-button" aria-label={t('common.clear')} onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ''; }}><X aria-hidden="true" /></button>
              </div>
            )}
          </div>
        )}

        {step === 1 && file && (
          <div className="pe-stack">
            <div className="pe-callout"><Sparkles aria-hidden="true" />{t('contacts.import.autoMatched', { n: autoMatched, total: file.headers.length })}</div>
            <div className="pe-table-wrap">
              <table className="pe-table">
                <thead><tr><th>{t('contacts.import.column')}</th><th>{t('contacts.import.sampleValue')}</th><th>{t('contacts.import.mapsTo')}</th></tr></thead>
                <tbody>
                  {file.headers.map((h, i) => (
                    <tr key={i}>
                      <td><code><Ltr>{h || `#${i + 1}`}</Ltr></code></td>
                      <td className="pe-muted"><Ltr>{file.rows.find((r) => r[i]?.trim())?.[i] ?? '—'}</Ltr></td>
                      <td>
                        <select aria-label={t('contacts.import.mapsToFor', { column: h })} value={mapping[i]} onChange={(e) => setMapping(mapping.map((m, j) => (j === i ? e.target.value as Target : m)))} className="pe-select">
                          {TARGETS.map((tg) => <option key={tg} value={tg}>{tg === 'attribute' ? t('contacts.import.target.attribute', { key: attrKey(h) }) : t(`contacts.import.target.${tg}`)}</option>)}
                        </select>
                        {duplicates.has(mapping[i]!) && <div className="pe-field__error">{t('contacts.import.duplicateTarget')}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!hasId && <div className="pe-alert pe-alert--danger" role="alert">{t('contacts.import.needId')}</div>}
            <p className="pe-muted">{t('contacts.import.consentHint')}</p>
          </div>
        )}

        {step === 2 && review && (
          <div className="pe-stack" style={{ gap: 20 }}>
            <div className="pe-kpis">
              <SummaryTile tone="success" label={t('contacts.import.new')} value={num(review.created)} />
              <SummaryTile tone="info" label={t('contacts.import.updated')} value={num(review.updated)} />
              <SummaryTile tone="muted" label={t('contacts.import.skipped')} value={num(review.skipped)} />
              <SummaryTile tone="danger" label={t('contacts.import.errors')} value={num(review.errors.length)} />
            </div>
            <fieldset className="pe-fieldset">
              <legend>{t('contacts.import.existing')}</legend>
              <div className="pe-choice-grid">
                {(['upsert', 'create_only', 'update_only'] as const).map((m) => (
                  <label key={m} className="pe-choice" data-checked={mode === m || undefined}>
                    <input type="radio" name="mode" value={m} checked={mode === m} disabled={busy} onChange={() => { setMode(m); void runReview(m); }} />
                    <span><strong>{t(`contacts.import.mode.${m}`)}</strong><small className="pe-muted">{t(`contacts.import.modeHint.${m}`)}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>
            {review.errors.length > 0 && (
              <div className="pe-stack">
                <div className="pe-row"><AlertTriangle aria-hidden="true" width={18} className="pe-warn-icon" /><strong>{t('contacts.import.errorRows')}</strong><span className="pe-spacer" /><Button variant="ghost" onClick={() => errorReport(review)}><Download aria-hidden="true" />{t('contacts.import.errorReport')}</Button></div>
                <div className="pe-table-wrap">
                  <table className="pe-table">
                    <thead><tr><th>{t('contacts.import.row')}</th><th>{t('contacts.import.problem')}</th></tr></thead>
                    <tbody>{review.errors.slice(0, 50).map((e) => <tr key={e.row}><td>{e.row}</td><td>{e.message}{e.fields?.map((f) => <div key={f.path} className="pe-muted"><code><Ltr>{f.path}</Ltr></code>: {f.message}</div>)}</td></tr>)}</tbody>
                  </table>
                </div>
                {review.errors.length > 50 && <p className="pe-muted">{t('contacts.import.moreErrors', { n: num(review.errors.length - 50) })}</p>}
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="pe-import__done">
            <span className="pe-dropzone__icon" data-done={result ? true : undefined} aria-hidden="true">{result ? <PartyPopper /> : <CloudUpload />}</span>
            <h2>{result ? t('contacts.import.doneTitle') : t('contacts.import.running')}</h2>
            <div className="pe-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label={t('contacts.import.progress')}>
              <span style={{ inlineSize: `${Math.round(progress * 100)}%` }} />
            </div>
            <small className="pe-muted">{t('contacts.import.processed', { done: num(Math.round(progress * (file?.rows.length ?? 0))), total: num(file?.rows.length ?? 0) })}</small>
            {result && (
              <div className="pe-kpis pe-import__summary" data-testid="import-result">
                <SummaryTile tone="success" label={t('contacts.import.created')} value={num(result.created)} />
                <SummaryTile tone="info" label={t('contacts.import.updated')} value={num(result.updated)} />
                <SummaryTile tone="muted" label={t('contacts.import.skipped')} value={num(result.skipped)} />
                <SummaryTile tone="danger" label={t('contacts.import.errors')} value={num(result.errors.length)} />
              </div>
            )}
            {result && result.errors.length > 0 && <Button variant="ghost" onClick={() => errorReport(result)}><Download aria-hidden="true" />{t('contacts.import.errorReport')}</Button>}
          </div>
        )}
        <ErrorBanner error={error} />
      </div>

      <div className="pe-row pe-import__nav">
        <Button variant="ghost" disabled={step === 0 || step === 3 || busy} onClick={() => setStep(step - 1)}><ArrowLeft aria-hidden="true" className="pe-flip-rtl" />{t('contacts.import.back')}</Button>
        <span className="pe-spacer" />
        {step === 0 && <Button variant="primary" disabled={!file} onClick={() => setStep(1)}>{t('contacts.import.continue')}<ArrowRight aria-hidden="true" className="pe-flip-rtl" /></Button>}
        {step === 1 && <Button variant="primary" busy={busy} disabled={!hasId || duplicates.size > 0} onClick={() => void runReview()}>{t('contacts.import.check')}<ArrowRight aria-hidden="true" className="pe-flip-rtl" /></Button>}
        {step === 2 && <Button variant="primary" busy={busy} disabled={!review || review.created + review.updated === 0} onClick={() => void runImport()}>{t('contacts.import.start', { n: num((review?.created ?? 0) + (review?.updated ?? 0)) })}</Button>}
        {step === 3 && result && <Link className="pe-button pe-button--primary" to="/contacts">{t('contacts.import.viewContacts')}</Link>}
        {step === 3 && result && <Button onClick={() => { setStep(0); setFile(null); setReview(null); setResult(null); }}>{t('contacts.import.another')}</Button>}
      </div>

      <div className="pe-card pe-stack" style={{ marginBlockStart: 24 }}>
        <h2>{t('contacts.import.history')}</h2>
        {history.data?.data.length ? (
          <div className="pe-table-wrap">
            <table className="pe-table">
              <thead><tr><th>{t('contacts.import.when')}</th><th>{t('contacts.import.file')}</th><th>{t('contacts.import.by')}</th><th>{t('contacts.import.created')}</th><th>{t('contacts.import.updated')}</th><th>{t('contacts.import.errors')}</th></tr></thead>
              <tbody>
                {history.data.data.map((h) => (
                  <tr key={h.id}>
                    <td>{formatDate(h.at)}</td><td><Ltr>{String(h.details.file_name ?? '')}</Ltr></td><td>{h.actor_name || h.actor_email || '—'}</td>
                    <td>{num(Number(h.details.created ?? 0))}</td><td>{num(Number(h.details.updated ?? 0))}</td><td>{num(Number(h.details.errors ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="pe-muted">{t('contacts.import.noHistory')}</p>}
      </div>
    </section>
  );
}

function SummaryTile({ tone, label, value }: { tone: 'success' | 'info' | 'muted' | 'danger'; label: string; value: string }) {
  return (
    <div className="pe-card pe-kpi" style={{ boxShadow: 'none' }}>
      <Pill tone={tone}>{label}</Pill>
      <strong className="pe-kpi__value">{value}</strong>
    </div>
  );
}
