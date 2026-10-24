// Pieces shared by the Content library and its editors: folder picking, tags, and type metadata.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Bell, Blocks, FileText, Film, ImageIcon, Mail, MessageCircle, MessageSquare, Music, type LucideIcon } from 'lucide-react';
import { api } from '../../api/client.ts';
import type { ContentType, Folder } from '../../api/types.ts';
import { SelectField } from '../../components/ui.tsx';
import type { Tone } from '../../components/bits.tsx';

export const TYPE_META: Record<ContentType, { icon: LucideIcon; tone: Tone }> = {
  email: { icon: Mail, tone: 'primary' },
  sms: { icon: MessageSquare, tone: 'sms' },
  push: { icon: Bell, tone: 'warning' },
  whatsapp: { icon: MessageCircle, tone: 'success' },
  block: { icon: Blocks, tone: 'info' },
  image: { icon: ImageIcon, tone: 'info' },
  document: { icon: FileText, tone: 'muted' },
  video: { icon: Film, tone: 'danger' },
  audio: { icon: Music, tone: 'muted' },
};
export const EDITABLE: ContentType[] = ['email', 'sms', 'push', 'whatsapp', 'block'];
export const editorPath = (type: ContentType, id: string) => `/content/${type}/${id}`;

export function useFolders() {
  return useQuery({ queryKey: ['folders'], queryFn: ({ signal }) => api<{ data: Folder[] }>('/api/folders', { signal }) });
}

/** Folders in tree order with their depth, for indented lists. */
export function flattenFolders(folders: Folder[]): (Folder & { depth: number })[] {
  const out: (Folder & { depth: number })[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parent_id === parent)) { out.push({ ...f, depth }); walk(f.id, depth + 1); }
  };
  walk(null, 0);
  return out;
}

export function FolderSelect({ value, onChange, disabled }: { value: string | null; onChange: (id: string | null) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const folders = useFolders();
  return (
    <SelectField label={t('content.folder')} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t('content.noFolder')}</option>
      {flattenFolders(folders.data?.data ?? []).map((f) => <option key={f.id} value={f.id}>{`${'  '.repeat(f.depth)}${f.name}`}</option>)}
    </SelectField>
  );
}

/** Comma-separated tags, normalised to lower case. */
export function TagsField({ value, onChange, disabled }: { value: string[]; onChange: (tags: string[]) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [text, setText] = useState(value.join(', '));
  return (
    <div className="pe-field">
      <label htmlFor="pe-tags">{t('content.tags')}</label>
      <input id="pe-tags" value={text} disabled={disabled} placeholder={t('content.tagsPlaceholder')}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange([...new Set(text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))])} />
    </div>
  );
}

export const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
