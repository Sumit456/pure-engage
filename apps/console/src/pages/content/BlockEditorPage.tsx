// Reusable content blocks: a set of designer blocks (header, footer, offer banner...), or plain HTML or text. Designer
// blocks show up in every email's designer, where they're inserted as a copy.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_DESIGN_STYLE, newBlock, type EmailBlock, type EmailDesign } from '@pure-engage/shared';
import { api, ApiError } from '../../api/client.ts';
import type { ContentBlock } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { Button, ErrorBanner, SelectField, Spinner, TextField } from '../../components/ui.tsx';
import { EmailDesigner } from '../templates/EmailDesigner.tsx';
import { FolderSelect, TagsField } from './common.tsx';

type Kind = ContentBlock['kind'];

export function BlockEditorPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const [search] = useSearchParams();
  const { t } = useTranslation();
  const canEdit = hasRole(useUser(), 'marketer');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const block = useQuery({ queryKey: ['content-block', id], enabled: !isNew, queryFn: ({ signal }) => api<ContentBlock>(`/api/content-blocks/${id}`, { signal }) });
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('design');
  const [folderId, setFolderId] = useState<string | null>(search.get('folder'));
  const [tags, setTags] = useState<string[]>([]);
  const [blocks, setBlocks] = useState<EmailBlock[]>(() => [newBlock('footer')]);
  const [text, setText] = useState('');
  useEffect(() => {
    const b = block.data;
    if (!b) return;
    setName(b.name); setKind(b.kind); setFolderId(b.folder_id); setTags(b.tags);
    if (b.kind === 'design') setBlocks(b.content.blocks ?? []);
    else setText(b.kind === 'html' ? b.content.html ?? '' : b.content.text ?? '');
  }, [block.data]);

  const content = kind === 'design' ? { blocks } : kind === 'html' ? { html: text } : { text };
  const save = useMutation({
    mutationFn: () => isNew
      ? api<ContentBlock>('/api/content-blocks', { method: 'POST', body: { name, kind, folder_id: folderId, tags, content } })
      : api<ContentBlock>(`/api/content-blocks/${id}`, { method: 'PUT', body: { name, folder_id: folderId, tags, content } }),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ['content'] });
      void qc.invalidateQueries({ queryKey: ['content-blocks'] });
      qc.setQueryData(['content-block', saved.id], saved);
      if (isNew) navigate(`/content/block/${saved.id}`, { replace: true });
    },
  });
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const design: EmailDesign = { version: 1, style: { ...DEFAULT_DESIGN_STYLE }, blocks };

  if (!isNew && block.isPending) return <div className="pe-center"><Spinner /></div>;
  if (!isNew && block.error) return <ErrorBanner error={block.error} />;

  return (
    <section className="pe-stack">
      <div className="pe-page-header"><Link to="/content" className="pe-muted">{t('content.backToLibrary')}</Link></div>
      <div className="pe-page-header">
        <h1>{isNew ? t('content.new.block') : name}</h1>
        <span className="pe-spacer" />
        {canEdit && <Button variant="primary" busy={save.isPending} disabled={!name.trim() || (kind === 'design' ? !blocks.length : !text.trim())} onClick={() => save.mutate()}>{t('common.save')}</Button>}
      </div>
      {save.error && <ErrorBanner error={save.error} />}
      {save.isSuccess && <p className="pe-ok" role="status">{t('content.saved')}</p>}
      <div className="pe-card pe-form-grid">
        <TextField label={t('templates.field.name')} value={name} disabled={!canEdit} error={fieldErrors.name} onChange={(e) => setName(e.target.value)} />
        <SelectField label={t('content.blockKind')} value={kind} disabled={!isNew || !canEdit} onChange={(e) => setKind(e.target.value as Kind)}>
          {(['design', 'html', 'text'] as const).map((k) => <option key={k} value={k}>{t(`content.blockKinds.${k}`)}</option>)}
        </SelectField>
        <FolderSelect value={folderId} disabled={!canEdit} onChange={setFolderId} />
        <TagsField key={block.data?.id ?? 'new'} value={tags} disabled={!canEdit} onChange={setTags} />
      </div>
      <p className="pe-muted">{t(`content.blockHint.${kind}`)}</p>
      {kind === 'design'
        ? <EmailDesigner design={design} dir="ltr" readOnly={!canEdit} onChange={(d) => setBlocks(d.blocks)} />
        : (
          <div className="pe-card pe-field">
            <label htmlFor="block-text">{t(`content.blockKinds.${kind}`)}</label>
            <textarea id="block-text" className="pe-code" dir={kind === 'html' ? 'ltr' : 'auto'} rows={14} value={text} disabled={!canEdit} onChange={(e) => setText(e.target.value)} />
          </div>
        )}
    </section>
  );
}
