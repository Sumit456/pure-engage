// Files from the content library: raw uploads with progress, and a picker used by the email designer and the push
// and WhatsApp editors.
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Film, Music, Upload } from 'lucide-react';
import { api, ApiError } from '../api/client.ts';
import type { Asset, AssetKind } from '../api/types.ts';
import { Button, ErrorBanner } from './ui.tsx';

/** Absolute /a/ links (as stored in emails) are loaded through the console's own origin. */
export const localUrl = (url: string | undefined) => (url ?? '').replace(/^https?:\/\/[^/]+(\/a\/[0-9a-f-]{36})$/i, '$1');
export const assetUrl = (id: string) => `/a/${id}`;

export const ACCEPT: Record<AssetKind | 'any', string> = {
  image: 'image/png,image/jpeg,image/gif,image/webp',
  video: 'video/mp4,video/webm',
  audio: 'audio/mpeg',
  document: 'application/pdf,.pdf,.csv,.txt,.docx,.xlsx,.pptx',
  any: 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,audio/mpeg,application/pdf,.pdf,.csv,.txt,.docx,.xlsx,.pptx',
};

/** Uploads raw bytes (no base64), reporting progress from 0 to 1. Uses XHR because fetch has no upload progress. */
export function uploadFile(file: File, { folderId, onProgress }: { folderId?: string | null; onProgress?: (p: number) => void } = {}): Promise<Asset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/assets/upload');
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-pe-csrf', '1');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    if (folderId) xhr.setRequestHeader('x-folder-id', folderId);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let body: { error?: string; details?: unknown } & Partial<Asset> = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Asset);
      else reject(new ApiError(xhr.status, body.error ?? xhr.statusText, body.details));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(file);
  });
}

export function FileIcon({ kind }: { kind: AssetKind }) {
  const Icon = kind === 'video' ? Film : kind === 'audio' ? Music : FileText;
  return <Icon aria-hidden="true" />;
}

/** Thumbnail for any library file. */
export function AssetThumb({ asset }: { asset: Pick<Asset, 'id' | 'kind' | 'name' | 'content_type'> }) {
  if (asset.kind === 'image') return <img src={assetUrl(asset.id)} alt="" loading="lazy" />;
  if (asset.kind === 'video') return <video src={`${assetUrl(asset.id)}#t=0.1`} muted preload="metadata" aria-hidden="true" />;
  return (
    <span className="pe-filethumb">
      <FileIcon kind={asset.kind} />
      <small>{(asset.name.split('.').pop() ?? '').toUpperCase().slice(0, 4)}</small>
    </span>
  );
}

/** Upload a file or pick one from the library, filtered to one kind. */
export function AssetPicker({ kind, value, label, onPick, pdfOnly = false }: { kind: AssetKind; value: string | undefined | null; label: string; onPick: (a: Asset | null) => void; pdfOnly?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const library = useQuery({ queryKey: ['assets', kind], queryFn: ({ signal }) => api<{ data: Asset[] }>(`/api/assets?kind=${kind}&limit=24`, { signal }) });
  const upload = useMutation({
    mutationFn: (f: File) => uploadFile(f, { onProgress: setProgress }),
    onSuccess: (a) => { void qc.invalidateQueries({ queryKey: ['assets'] }); void qc.invalidateQueries({ queryKey: ['content'] }); onPick(a); },
    onSettled: () => setProgress(null),
  });
  const onFile = (f: File | undefined) => { if (f) upload.mutate(f); };
  const items = (library.data?.data ?? []).filter((a) => !pdfOnly || a.content_type === 'application/pdf');
  const picked = items.find((a) => a.id === value || a.url === value) ?? null;
  const selected = (a: Asset) => value === a.id || value === a.url;
  return (
    <div className="pe-stack pe-stack--tight">
      <span className="pe-field"><span>{label}</span></span>
      <label className="pe-dropzone pe-dropzone--small" data-drag={drag || undefined}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0]); }}>
        <input ref={input} type="file" accept={pdfOnly ? 'application/pdf' : ACCEPT[kind]} className="pe-visually-hidden" aria-label={t('designer.upload')} onChange={(e) => onFile(e.target.files?.[0])} />
        {kind === 'image' && value ? <img src={localUrl(picked?.url ?? (value.startsWith('http') || value.startsWith('/') ? value : assetUrl(value)))} alt="" className="pe-picked" /> : <Upload aria-hidden="true" />}
        <span>{upload.isPending ? t('content.uploadingPct', { pct: Math.round((progress ?? 0) * 100) }) : t('designer.upload')}</span>
        <small className="pe-muted">{t(`content.pickerHint.${pdfOnly ? 'pdf' : kind}`)}</small>
      </label>
      <ErrorBanner error={upload.error} />
      {items.length > 0 && (
        <>
          <span className="pe-muted" style={{ fontSize: '0.8rem' }}>{t('designer.library')}</span>
          <div className="pe-assets">
            {items.slice(0, 12).map((a) => (
              <button key={a.id} type="button" className="pe-asset" data-selected={selected(a) || undefined} onClick={() => onPick(a)} title={a.name} aria-label={t('designer.useImage', { name: a.name })}>
                <AssetThumb asset={a} />
              </button>
            ))}
          </div>
        </>
      )}
      {value && <div><Button variant="ghost" onClick={() => onPick(null)}>{t('content.removeFile')}</Button></div>}
    </div>
  );
}
