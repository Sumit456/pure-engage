import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GroupRule } from '@pure-engage/shared';
import { api, ApiError } from '../../api/client.ts';
import type { Segment, SegmentPreview } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { Button, EmptyState, ErrorBanner, Spinner, TextField, useFormatDate } from '../../components/ui.tsx';
import { displayName } from '../contacts/ContactsPage.tsx';
import { GroupEditor } from './RuleBuilder.tsx';

export function SegmentsPage() {
  const { t } = useTranslation();
  const user = useUser();
  const formatDate = useFormatDate();
  const segments = useQuery({ queryKey: ['segments'], queryFn: ({ signal }) => api<{ data: Segment[] }>('/api/segments', { signal }) });
  return (
    <section>
      <div className="pe-page-header">
        <h1>{t('nav.segments')}</h1>
        <span className="pe-spacer" />
        {hasRole(user, 'marketer') && <Link className="pe-button pe-button--primary" to="/segments/new">{t('segments.new')}</Link>}
      </div>
      <div className="pe-card">
        <ErrorBanner error={segments.error} />
        {segments.isPending ? <div className="pe-center"><Spinner /></div> : !segments.data?.data.length ? <EmptyState title={t('segments.empty')}>{t('segments.emptyHint')}</EmptyState> : (
          <div className="pe-table-wrap">
            <table className="pe-table">
              <thead><tr><th>{t('templates.field.name')}</th><th>{t('segments.size')}</th><th>{t('contacts.field.updated_at')}</th></tr></thead>
              <tbody>
                {segments.data.data.map((s) => (
                  <tr key={s.id}><td><Link to={`/segments/${s.id}`}>{s.name}</Link></td><td>{s.size.toLocaleString()}</td><td>{formatDate(s.updated_at)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

const EMPTY: GroupRule = { type: 'group', op: 'and', rules: [] };

export function SegmentEditorPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const { t } = useTranslation();
  const user = useUser();
  const canEdit = hasRole(user, 'marketer');
  const navigate = useNavigate();
  const qc = useQueryClient();

  const segment = useQuery({ queryKey: ['segment', id], enabled: !isNew, queryFn: ({ signal }) => api<Segment>(`/api/segments/${id}`, { signal }) });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rules, setRules] = useState<GroupRule>(EMPTY);
  useEffect(() => {
    if (segment.data) { setName(segment.data.name); setDescription(segment.data.description); setRules(segment.data.rules); }
  }, [segment.data]);

  // Live audience size while editing.
  const [debouncedRules, setDebouncedRules] = useState(rules);
  useEffect(() => { const h = setTimeout(() => setDebouncedRules(rules), 400); return () => clearTimeout(h); }, [rules]);
  const preview = useQuery({
    queryKey: ['segment-preview', debouncedRules],
    retry: false,
    queryFn: ({ signal }) => api<SegmentPreview>('/api/segments/preview', { method: 'POST', body: { rules: debouncedRules }, signal }),
  });

  const save = useMutation({
    mutationFn: () => isNew
      ? api<Segment>('/api/segments', { method: 'POST', body: { name, description, rules } })
      : api<Segment>(`/api/segments/${id}`, { method: 'PUT', body: { name, description, rules } }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['segments'] });
      void qc.invalidateQueries({ queryKey: ['segment', s.id] });
      if (isNew) navigate(`/segments/${s.id}`, { replace: true });
    },
  });
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors() : {};

  if (!isNew && segment.isPending) return <div className="pe-center"><Spinner /></div>;
  if (!isNew && segment.error) return <ErrorBanner error={segment.error} />;

  const onSubmit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  return (
    <section>
      <div className="pe-page-header"><Link to="/segments" className="pe-muted">{t('segments.backToList')}</Link></div>
      <form className="pe-stack" onSubmit={onSubmit} noValidate>
        <div className="pe-page-header">
          <h1>{isNew ? t('segments.new') : name}</h1>
          <span className="pe-spacer" />
          {canEdit && <Button type="submit" variant="primary" busy={save.isPending}>{t('common.save')}</Button>}
        </div>
        {save.error && <ErrorBanner error={save.error} />}
        <div className="pe-card pe-form-grid">
          <TextField label={t('templates.field.name')} value={name} disabled={!canEdit} error={fieldErrors.name} onChange={(e) => setName(e.target.value)} />
          <TextField label={t('templates.field.description')} value={description} disabled={!canEdit} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="pe-grid-2 pe-grid-2--wide-first">
          <div className="pe-card pe-stack">
            <h2>{t('segments.rules')}</h2>
            <GroupEditor group={rules} onChange={setRules} readOnly={!canEdit} />
          </div>
          <div className="pe-card pe-stack" aria-live="polite">
            <h2>{t('segments.audience')}</h2>
            {preview.error ? <ErrorBanner error={preview.error} /> : !preview.data ? <Spinner /> : (
              <>
                <div className="pe-stat"><strong data-testid="segment-count">{preview.data.count.toLocaleString()}</strong> <span className="pe-muted">{t('segments.contactsMatch')}</span></div>
                <ul className="pe-plain-list">
                  {preview.data.sample.map((c) => <li key={c.id}><Link to={`/contacts/${c.id}`}>{displayName(c)}</Link></li>)}
                </ul>
                {preview.data.count > preview.data.sample.length && <small className="pe-muted">{t('segments.andMore', { n: (preview.data.count - preview.data.sample.length).toLocaleString() })}</small>}
              </>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
