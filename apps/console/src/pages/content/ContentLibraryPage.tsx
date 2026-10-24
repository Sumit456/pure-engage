// Content library (in the spirit of SFMC Content Builder): folders on the left, every email, SMS, push, WhatsApp
// message, content block and file in one place, uploads with progress, and a preview drawer.
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check, ChevronDown, CloudUpload, Folder as FolderIcon, FolderInput, FolderOpen, FolderPlus, Inbox, LayoutGrid, Library, List, Pencil, Plus, Search, Trash2, X,
} from 'lucide-react';
import { api } from '../../api/client.ts';
import type { AssetDetail, ContentItem, ContentType, Folder } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { AssetThumb, uploadFile } from '../../components/AssetPicker.tsx';
import { Button, EmptyState, ErrorBanner, Ltr, Spinner, useFormatDate } from '../../components/ui.tsx';
import { IconChip, PageHeader, Pill } from '../../components/bits.tsx';
import { CopyField } from '../integrations/common.tsx';
import { EDITABLE, TYPE_META, editorPath, flattenFolders, formatBytes, useFolders } from './common.tsx';
import { ACCEPT } from '../../components/AssetPicker.tsx';

const FILTERS: { id: string; types: ContentType[] }[] = [
  { id: 'all', types: [] },
  { id: 'emails', types: ['email'] },
  { id: 'messages', types: ['sms', 'push', 'whatsapp'] },
  { id: 'blocks', types: ['block'] },
  { id: 'images', types: ['image'] },
  { id: 'videos', types: ['video', 'audio'] },
  { id: 'documents', types: ['document'] },
];
const CREATE: ContentType[] = ['email', 'sms', 'push', 'whatsapp', 'block'];
const FILE_KINDS = new Set<ContentType>(['image', 'document', 'video', 'audio']);
const DND = 'application/x-pe-content';
const DB_QUOTA = 1024 * 1024 * 1024;

interface Upload { key: string; name: string; progress: number; error?: string; done?: boolean }

export function ContentLibraryPage() {
  const { t } = useTranslation();
  const canEdit = hasRole(useUser(), 'marketer');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const formatDate = useFormatDate();
  const [params, setParams] = useSearchParams();
  const folder = params.get('folder') ?? '';
  const filter = FILTERS.find((f) => f.id === params.get('type')) ?? FILTERS[0]!;
  const view = params.get('view') === 'list' ? 'list' : 'grid';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<ContentItem | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const setParam = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });

  // Only write the search to the URL when it changed: a stale write would undo a folder picked in the meantime.
  useEffect(() => {
    if (q.trim() === (params.get('q') ?? '')) return;
    const id = setTimeout(() => setParam('q', q.trim() || null), 250);
    return () => clearTimeout(id);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const query = new URLSearchParams({ limit: '120', ...(filter.types.length ? { type: filter.types.join(',') } : {}), ...(folder ? { folder_id: folder } : {}), ...(params.get('q') ? { q: params.get('q')! } : {}) });
  const items = useQuery({ queryKey: ['content', query.toString()], queryFn: ({ signal }) => api<{ data: ContentItem[]; total: number }>(`/api/content?${query}`, { signal }) });
  const folders = useFolders();
  const usage = useQuery({ queryKey: ['assets-usage'], queryFn: () => api<{ bytes: number; files: number }>('/api/assets/usage') });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['content'] }); void qc.invalidateQueries({ queryKey: ['folders'] }); void qc.invalidateQueries({ queryKey: ['assets-usage'] }); void qc.invalidateQueries({ queryKey: ['assets'] }); };
  const move = useMutation({
    mutationFn: ({ ids, to }: { ids: string[]; to: string | null }) => {
      const list = items.data?.data ?? [];
      return api('/api/content/move', { method: 'POST', body: { folder_id: to, items: ids.map((id) => ({ id, type: list.find((i) => i.id === id)?.type ?? 'image' })) } });
    },
    onSuccess: () => { setSelected(new Set()); refresh(); },
  });

  const startUploads = (files: FileList | File[]) => {
    const folderId = folder && folder !== 'root' ? folder : null;
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      const set = (patch: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      uploadFile(file, { folderId, onProgress: (progress) => set({ progress }) })
        .then(() => { set({ progress: 1, done: true }); refresh(); setTimeout(() => setUploads((u) => u.filter((x) => x.key !== key)), 2500); })
        .catch((err: Error) => set({ error: err.message }));
    }
  };
  const onDropFiles = (e: DragEvent) => {
    e.preventDefault(); setDragOver(false);
    if (canEdit && e.dataTransfer.files.length) startUploads(e.dataTransfer.files);
  };
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const activate = (item: ContentItem) => (EDITABLE.includes(item.type) ? navigate(editorPath(item.type, item.id)) : setOpen(item));
  const dragStart = (e: DragEvent, item: ContentItem) => {
    const ids = selected.has(item.id) ? [...selected] : [item.id];
    e.dataTransfer.setData(DND, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  };
  const folderName = new Map((folders.data?.data ?? []).map((f) => [f.id, f.name]));
  const heading = folder === 'root' ? t('content.unfiled') : folder ? folderName.get(folder) ?? t('content.folder') : t('content.all');
  const list = items.data?.data ?? [];

  return (
    <section className="pe-stack">
      <PageHeader
        title={t('nav.content')}
        subtitle={t('content.subtitle')}
        actions={canEdit && <>
          <input ref={fileInput} type="file" multiple accept={ACCEPT.any} className="pe-visually-hidden" aria-label={t('content.upload')} onChange={(e) => { if (e.target.files) startUploads(e.target.files); e.target.value = ''; }} />
          <Button onClick={() => fileInput.current?.click()}><CloudUpload aria-hidden="true" />{t('content.upload')}</Button>
          <div className="pe-menu">
            <Button variant="primary" aria-haspopup="menu" aria-expanded={createOpen} onClick={() => setCreateOpen((o) => !o)}><Plus aria-hidden="true" />{t('content.create')}<ChevronDown aria-hidden="true" /></Button>
            {createOpen && (
              <div className="pe-menu__list" role="menu" onMouseLeave={() => setCreateOpen(false)}>
                {CREATE.map((type) => {
                  const M = TYPE_META[type];
                  return (
                    <Link key={type} role="menuitem" to={`/content/${type}/new${folder && folder !== 'root' ? `?folder=${folder}` : ''}`} className="pe-menu__item" onClick={() => setCreateOpen(false)}>
                      <IconChip icon={M.icon} tone={M.tone} />
                      <span><strong>{t(`content.types.${type}`)}</strong><small className="pe-muted">{t(`content.createHint.${type}`)}</small></span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </>}
      />

      <div className="pe-library">
        <FolderTree current={folder} folders={folders.data?.data ?? []} canEdit={canEdit} onPick={(id) => { setParam('folder', id || null); setSelected(new Set()); }}
          onDropItems={(ids, to) => move.mutate({ ids, to })} onChanged={refresh} />

        <div className="pe-stack pe-library__main" onDragOver={(e) => { if (canEdit && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }} onDragLeave={() => setDragOver(false)} onDrop={onDropFiles} data-drop={dragOver || undefined}>
          <div className="pe-library__toolbar">
            <label className="pe-searchbox">
              <Search aria-hidden="true" />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('content.search')} aria-label={t('content.search')} />
            </label>
            <div className="pe-chips" role="group" aria-label={t('content.filter')}>
              {FILTERS.map((f) => <button key={f.id} type="button" className="pe-chip" aria-pressed={filter.id === f.id} onClick={() => setParam('type', f.id === 'all' ? null : f.id)}>{t(`content.filters.${f.id}`)}</button>)}
            </div>
            <span className="pe-spacer" />
            <div className="pe-tabs" role="tablist" aria-label={t('content.view')}>
              <button type="button" role="tab" aria-selected={view === 'grid'} className="pe-tab" aria-label={t('content.grid')} onClick={() => setParam('view', null)}><LayoutGrid aria-hidden="true" width={16} /></button>
              <button type="button" role="tab" aria-selected={view === 'list'} className="pe-tab" aria-label={t('content.list')} onClick={() => setParam('view', 'list')}><List aria-hidden="true" width={16} /></button>
            </div>
          </div>

          <div className="pe-row pe-library__meta">
            <strong>{heading}</strong>
            <span className="pe-muted">{t('content.count', { count: items.data?.total ?? 0 })}</span>
            <span className="pe-spacer" />
            {usage.data && <span className="pe-quota" title={t('content.quotaHint')}><span className="pe-quota__track"><span style={{ inlineSize: `${Math.max(1, Math.min(100, (usage.data.bytes / DB_QUOTA) * 100))}%` }} /></span><small className="pe-muted">{t('content.quota', { used: formatBytes(usage.data.bytes) })}</small></span>}
          </div>

          {selected.size > 0 && canEdit && (
            <div className="pe-library__selection" role="region" aria-label={t('content.selection')}>
              <Check aria-hidden="true" /><span>{t('content.selected', { count: selected.size })}</span>
              <FolderInput aria-hidden="true" />
              <select aria-label={t('content.moveTo')} value="" onChange={(e) => { if (e.target.value) move.mutate({ ids: [...selected], to: e.target.value === 'root' ? null : e.target.value }); }}>
                <option value="">{t('content.moveTo')}</option>
                <option value="root">{t('content.unfiled')}</option>
                {flattenFolders(folders.data?.data ?? []).map((f) => <option key={f.id} value={f.id}>{`${'  '.repeat(f.depth)}${f.name}`}</option>)}
              </select>
              <Button variant="ghost" onClick={() => setSelected(new Set())}><X aria-hidden="true" />{t('content.clearSelection')}</Button>
            </div>
          )}

          {uploads.length > 0 && (
            <ul className="pe-uploads" aria-label={t('content.uploads')}>
              {uploads.map((u) => (
                <li key={u.key} data-state={u.error ? 'error' : u.done ? 'done' : 'busy'}>
                  <span className="pe-uploads__name">{u.name}</span>
                  {u.error ? <span className="pe-field__error">{u.error}</span> : <span className="pe-progress" role="progressbar" aria-label={u.name} aria-valuenow={Math.round(u.progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ inlineSize: `${u.progress * 100}%` }} /></span>}
                  {(u.error || u.done) && <button type="button" className="pe-icon-button" aria-label={t('common.close')} onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}><X aria-hidden="true" /></button>}
                </li>
              ))}
            </ul>
          )}
          <ErrorBanner error={items.error ?? move.error} />

          {items.isPending ? <div className="pe-center"><Spinner /></div> : !list.length ? (
            <div className="pe-card pe-library__empty">
              <EmptyState title={params.get('q') || filter.id !== 'all' ? t('content.noMatch') : t('content.empty')}>{canEdit ? t('content.emptyHint') : ''}</EmptyState>
            </div>
          ) : view === 'grid' ? (
            <ul className="pe-tiles">
              {list.map((item) => {
                const M = TYPE_META[item.type];
                return (
                  <li key={item.id} className="pe-tile" data-selected={selected.has(item.id) || undefined} data-open={open?.id === item.id || undefined}
                    draggable={canEdit} onDragStart={(e) => dragStart(e, item)}>
                    <button type="button" className="pe-tile__open" onClick={() => (FILE_KINDS.has(item.type) || item.type === 'block' ? setOpen(item) : activate(item))} onDoubleClick={() => activate(item)} aria-label={`${t(`content.types.${item.type}`)}: ${item.name}`}>
                      <span className="pe-tile__thumb" data-type={item.type}>
                        {FILE_KINDS.has(item.type) ? <AssetThumb asset={{ id: item.id, kind: item.type as 'image', name: item.name, content_type: item.content_type ?? '' }} /> : <IconChip icon={M.icon} tone={M.tone} />}
                      </span>
                      <span className="pe-tile__name">{item.name}</span>
                      <span className="pe-tile__meta"><Pill tone={M.tone}>{t(`content.types.${item.type}`)}</Pill><small className="pe-muted">{item.size ? formatBytes(item.size) : formatDate(item.updated_at)}</small></span>
                    </button>
                    {canEdit && <label className="pe-tile__check"><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label={t('content.select', { name: item.name })} /></label>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="pe-card pe-table-wrap">
              <table className="pe-table">
                <thead><tr>{canEdit && <th aria-label={t('content.selection')} />}<th>{t('templates.field.name')}</th><th>{t('content.type')}</th><th>{t('content.folder')}</th><th>{t('content.size')}</th><th>{t('contacts.field.updated_at')}</th></tr></thead>
                <tbody>
                  {list.map((item) => (
                    <tr key={item.id} draggable={canEdit} onDragStart={(e) => dragStart(e, item)}>
                      {canEdit && <td><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label={t('content.select', { name: item.name })} /></td>}
                      <td><button type="button" className="pe-linkbutton" onClick={() => activate(item)}>{item.name}</button></td>
                      <td><Pill tone={TYPE_META[item.type].tone}>{t(`content.types.${item.type}`)}</Pill></td>
                      <td>{item.folder_id ? folderName.get(item.folder_id) : '—'}</td>
                      <td>{item.size ? formatBytes(item.size) : '—'}</td>
                      <td>{formatDate(item.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {open && <DetailDrawer item={open} canEdit={canEdit} onClose={() => setOpen(null)} onChanged={refresh} />}
      </div>
    </section>
  );
}

function FolderTree({ current, folders, canEdit, onPick, onDropItems, onChanged }: {
  current: string; folders: Folder[]; canEdit: boolean; onPick: (id: string) => void; onDropItems: (ids: string[], to: string | null) => void; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState<string | null | undefined>(undefined); // undefined: not adding; null: top level
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [over, setOver] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => api<Folder>('/api/folders', { method: 'POST', body: { name, parent_id: adding ?? null } }), onSuccess: (f) => { setAdding(undefined); setName(''); onChanged(); onPick(f.id); } });
  const rename = useMutation({ mutationFn: (id: string) => api(`/api/folders/${id}`, { method: 'PATCH', body: { name } }), onSuccess: () => { setRenaming(null); setName(''); onChanged(); } });
  const remove = useMutation({ mutationFn: (id: string) => api(`/api/folders/${id}`, { method: 'DELETE' }), onSuccess: (_r, id) => { if (current === id) onPick(''); onChanged(); } });
  const tree = useMemo(() => flattenFolders(folders), [folders]);
  const drop = (e: DragEvent, to: string | null) => {
    e.preventDefault(); setOver(null);
    const raw = e.dataTransfer.getData(DND);
    if (raw && canEdit) onDropItems(JSON.parse(raw) as string[], to);
  };
  const target = (key: string, to: string | null) => ({
    onDragOver: (e: DragEvent) => { if (canEdit && e.dataTransfer.types.includes(DND)) { e.preventDefault(); setOver(key); } },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent) => drop(e, to),
    'data-over': over === key || undefined,
  });
  const nameInput = (onSubmit: () => void, busy: boolean) => (
    <form className="pe-foldertree__form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(); }}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label={t('content.folderName')} placeholder={t('content.folderName')} maxLength={100} onKeyDown={(e) => { if (e.key === 'Escape') { setAdding(undefined); setRenaming(null); } }} />
      <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>{t('common.save')}</Button>
    </form>
  );

  return (
    <aside className="pe-card pe-foldertree" aria-label={t('content.folders')}>
      <div className="pe-row"><strong>{t('content.folders')}</strong><span className="pe-spacer" />
        {canEdit && <button type="button" className="pe-icon-button" aria-label={t('content.newFolder')} title={t('content.newFolder')} onClick={() => { setAdding(current && current !== 'root' ? current : null); setName(''); }}><FolderPlus aria-hidden="true" /></button>}
      </div>
      <ul role="tree">
        <li role="treeitem" aria-selected={!current}><button type="button" className="pe-foldertree__item" onClick={() => onPick('')}><Library aria-hidden="true" />{t('content.all')}</button></li>
        <li role="treeitem" aria-selected={current === 'root'} {...target('root', null)}><button type="button" className="pe-foldertree__item" onClick={() => onPick('root')}><Inbox aria-hidden="true" />{t('content.unfiled')}</button></li>
        {tree.map((f) => (
          <li key={f.id} role="treeitem" aria-selected={current === f.id} style={{ paddingInlineStart: `${f.depth * 14}px` }} {...target(f.id, f.id)}>
            {renaming === f.id ? nameInput(() => rename.mutate(f.id), rename.isPending) : (
              <div className="pe-foldertree__row">
                <button type="button" className="pe-foldertree__item" onClick={() => onPick(f.id)}>
                  {current === f.id ? <FolderOpen aria-hidden="true" /> : <FolderIcon aria-hidden="true" />}<span>{f.name}</span><small className="pe-muted">{f.items || ''}</small>
                </button>
                {canEdit && (
                  <span className="pe-foldertree__actions">
                    <button type="button" className="pe-icon-button" aria-label={t('content.renameFolder', { name: f.name })} onClick={() => { setRenaming(f.id); setName(f.name); }}><Pencil aria-hidden="true" /></button>
                    <button type="button" className="pe-icon-button" aria-label={t('content.deleteFolder', { name: f.name })} onClick={() => remove.mutate(f.id)}><Trash2 aria-hidden="true" /></button>
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {adding !== undefined && (
        <div className="pe-stack pe-stack--tight">
          <small className="pe-muted">{adding ? t('content.newSubfolder', { name: folders.find((f) => f.id === adding)?.name ?? '' }) : t('content.newFolder')}</small>
          {nameInput(() => create.mutate(), create.isPending)}
        </div>
      )}
      <ErrorBanner error={create.error ?? rename.error ?? remove.error} />
      {canEdit && <small className="pe-muted">{t('content.dragHint')}</small>}
    </aside>
  );
}

function DetailDrawer({ item, canEdit, onClose, onChanged }: { item: ContentItem; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const isFile = FILE_KINDS.has(item.type);
  const detail = useQuery({ queryKey: ['asset', item.id], enabled: isFile, queryFn: ({ signal }) => api<AssetDetail>(`/api/assets/${item.id}`, { signal }) });
  const [name, setName] = useState(item.name);
  const [tags, setTags] = useState(item.tags.join(', '));
  useEffect(() => { setName(item.name); setTags(item.tags.join(', ')); }, [item]);
  const save = useMutation({
    mutationFn: () => api(`/api/assets/${item.id}`, { method: 'PATCH', body: { name, tags: tags.split(',').map((s) => s.trim()).filter(Boolean) } }),
    onSuccess: () => { onChanged(); void detail.refetch(); },
  });
  const remove = useMutation({ mutationFn: () => api(`/api/assets/${item.id}`, { method: 'DELETE' }), onSuccess: () => { onChanged(); onClose(); } });
  const d = detail.data;
  const M = TYPE_META[item.type];
  return (
    <aside className="pe-card pe-drawer" aria-label={t('content.details')}>
      <div className="pe-row">
        <IconChip icon={M.icon} tone={M.tone} />
        <strong className="pe-drawer__title">{item.name}</strong>
        <span className="pe-spacer" />
        <button type="button" className="pe-icon-button" aria-label={t('common.close')} onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      {isFile && (
        <div className="pe-drawer__preview" data-kind={item.type}>
          {item.type === 'image' && <img src={`/a/${item.id}`} alt={item.name} />}
          {item.type === 'video' && <video src={`/a/${item.id}`} controls preload="metadata" aria-label={item.name} />}
          {item.type === 'audio' && <audio src={`/a/${item.id}`} controls aria-label={item.name} />}
          {item.type === 'document' && <AssetThumb asset={{ id: item.id, kind: 'document', name: item.name, content_type: item.content_type ?? '' }} />}
        </div>
      )}
      {!isFile && <p className="pe-muted">{t(`content.createHint.${item.type}`)}</p>}
      {EDITABLE.includes(item.type) && <Link to={editorPath(item.type, item.id)} className="pe-button pe-button--primary">{t('content.openEditor')}</Link>}
      {isFile && (!d ? <Spinner /> : (
        <>
          <a href={`/a/${item.id}`} target="_blank" rel="noreferrer" className="pe-button pe-button--secondary">{t('content.openFile')}</a>
          <CopyField label={t('content.publicUrl')} value={d.url} hint={t('content.publicUrlHint')} />
          <dl className="pe-dl pe-dl--compact">
            <dt>{t('content.type')}</dt><dd><Ltr>{d.content_type}</Ltr></dd>
            <dt>{t('content.size')}</dt><dd>{formatBytes(d.size)}{d.width ? ` · ${d.width}×${d.height}` : ''}</dd>
            <dt>{t('messages.created')}</dt><dd>{formatDate(d.created_at)}</dd>
          </dl>
          {canEdit && (
            <form className="pe-stack pe-stack--tight" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
              <div className="pe-field"><label htmlFor="asset-name">{t('templates.field.name')}</label><input id="asset-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="pe-field"><label htmlFor="asset-tags">{t('content.tags')}</label><input id="asset-tags" value={tags} placeholder={t('content.tagsPlaceholder')} onChange={(e) => setTags(e.target.value)} /></div>
              <div><Button type="submit" busy={save.isPending}>{t('common.save')}</Button></div>
            </form>
          )}
          <div className="pe-stack pe-stack--tight">
            <strong>{t('content.usedIn')}</strong>
            {d.used_in.length ? (
              <ul className="pe-usedin">{d.used_in.map((u) => <li key={u.id}><Link to={editorPath(u.type as ContentType, u.id)}>{u.name}</Link> <Pill tone={TYPE_META[u.type as ContentType]?.tone ?? 'muted'}>{t(`content.types.${u.type}`)}</Pill></li>)}</ul>
            ) : <small className="pe-muted">{t('content.notUsed')}</small>}
          </div>
          {canEdit && <div><Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}><Trash2 aria-hidden="true" />{t('common.delete')}</Button></div>}
          <ErrorBanner error={save.error ?? remove.error} />
        </>
      ))}
    </aside>
  );
}
