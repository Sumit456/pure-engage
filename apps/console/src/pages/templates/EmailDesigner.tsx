// Block-based email designer. Blocks are previewed with React (so nothing marketers type is ever injected as
// HTML here); the exact email, rendered with Liquid for a real contact, is in the preview beside it.
import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, Columns2, Copy, Heading, ImageIcon, LayoutPanelTop, Minus, MousePointerClick, MoveVertical, PanelBottom,
  BookmarkPlus, Blocks, Monitor, Palette, Smartphone, Trash2, Type, type LucideIcon,
} from 'lucide-react';
import { DEFAULT_DESIGN_STYLE, newBlock, newBlockId, type BlockAlign, type EmailBlock, type EmailBlockType, type EmailDesign } from '@pure-engage/shared';
import { api } from '../../api/client.ts';
import { Button, Dialog, ErrorBanner, TextField } from '../../components/ui.tsx';
import { AssetPicker, localUrl } from '../../components/AssetPicker.tsx';
import type { ContentBlock } from '../../api/types.ts';


const PALETTE: { type: EmailBlockType; icon: LucideIcon }[] = [
  { type: 'header', icon: LayoutPanelTop }, { type: 'heading', icon: Heading }, { type: 'text', icon: Type }, { type: 'image', icon: ImageIcon },
  { type: 'button', icon: MousePointerClick }, { type: 'columns', icon: Columns2 }, { type: 'divider', icon: Minus }, { type: 'spacer', icon: MoveVertical },
  { type: 'footer', icon: PanelBottom },
];
const DND = 'application/x-pe-email-block';
/** Our own uploaded images load from this console's origin; emails keep the absolute public link. */
const local = localUrl;

/** **bold**, *italic*, [label](url) and line breaks as React nodes (preview only). */
function Inline({ text, accent }: { text: string; accent: string }) {
  const out: ReactNode[] = [];
  text.split(/\n/).forEach((line, li) => {
    if (li) out.push(<br key={`br${li}`} />);
    const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let last = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push(line.slice(last, m.index));
      if (m[1]) out.push(<strong key={`${li}-${m.index}`}>{m[1]}</strong>);
      else if (m[2]) out.push(<em key={`${li}-${m.index}`}>{m[2]}</em>);
      else out.push(<span key={`${li}-${m.index}`} style={{ color: accent, textDecoration: 'underline' }}>{m[3]}</span>);
      last = m.index + m[0].length;
    }
    if (last < line.length) out.push(line.slice(last));
  });
  return <>{out}</>;
}

function BlockPreview({ block, design }: { block: EmailBlock; design: EmailDesign }) {
  const s = { ...DEFAULT_DESIGN_STYLE, ...design.style };
  const ta = (a: BlockAlign) => (a === 'center' ? 'center' : a);
  switch (block.type) {
    case 'header':
      return <div className="pe-eb pe-eb--header" style={{ background: block.background || s.accent, color: block.color || '#fff', borderStartStartRadius: s.radius, borderStartEndRadius: s.radius }}>
        {block.imageUrl ? <img src={local(block.imageUrl)} alt={block.imageAlt ?? ''} style={{ height: 40 }} /> : <strong>{block.text}</strong>}
      </div>;
    case 'heading': return <div className="pe-eb" style={{ textAlign: ta(block.align), color: s.text, fontSize: block.level === 1 ? 26 : 20, fontWeight: 700, lineHeight: 1.3 }}>{block.text}</div>;
    case 'text': return <div className="pe-eb" style={{ textAlign: ta(block.align), color: s.text, fontSize: 16, lineHeight: 1.6 }}><Inline text={block.text} accent={s.accent} /></div>;
    case 'image': return <div className="pe-eb" style={{ textAlign: ta(block.align) }}>
      {block.src ? <img src={local(block.src)} alt={block.alt} style={{ width: `${block.width}%`, maxWidth: '100%', borderRadius: Math.min(s.radius, 12) }} /> : <div className="pe-eb__placeholder"><ImageIcon aria-hidden="true" /></div>}
    </div>;
    case 'button': return <div className="pe-eb" style={{ textAlign: ta(block.align) }}><span className="pe-eb__button" style={{ background: block.background || s.accent, color: block.color || '#fff', borderRadius: Math.max(6, s.radius - 2) }}>{block.label}</span></div>;
    case 'divider': return <div className="pe-eb"><hr className="pe-eb__hr" /></div>;
    case 'spacer': return <div className="pe-eb__spacer" style={{ height: block.height }} />;
    case 'columns': return <div className="pe-eb pe-eb__cols" style={{ color: s.text }}><div><Inline text={block.left} accent={s.accent} /></div><div><Inline text={block.right} accent={s.accent} /></div></div>;
    case 'footer': return <div className="pe-eb pe-eb--footer"><Inline text={block.text} accent="#6b7b83" /></div>;
  }
}

export function EmailDesigner({ design, dir, readOnly, onChange }: { design: EmailDesign; dir: 'ltr' | 'rtl'; readOnly: boolean; onChange: (d: EmailDesign) => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop');
  const [dropAt, setDropAt] = useState<number | null>(null);
  const dragId = useRef<string | null>(null);
  const blocks = design.blocks;
  const sel = blocks.find((b) => b.id === selected);

  const qc = useQueryClient();
  const saved = useQuery({ queryKey: ['content-blocks'], enabled: !readOnly, queryFn: ({ signal }) => api<{ data: ContentBlock[] }>('/api/content-blocks', { signal }) });
  const designBlocks = (saved.data?.data ?? []).filter((b) => b.kind === 'design' && b.content.blocks?.length);
  const [saving, setSaving] = useState<EmailBlock | null>(null);
  const [blockName, setBlockName] = useState('');
  const saveBlock = useMutation({
    mutationFn: () => api<ContentBlock>('/api/content-blocks', { method: 'POST', body: { name: blockName, kind: 'design', content: { blocks: [saving] } } }),
    onSuccess: () => { setSaving(null); setBlockName(''); void qc.invalidateQueries({ queryKey: ['content-blocks'] }); void qc.invalidateQueries({ queryKey: ['content'] }); },
  });
  /** Saved blocks are copied in (with new ids), so later edits to the saved block don't change sent emails. */
  const insertSaved = (b: ContentBlock) => {
    const at = selected ? blocks.findIndex((x) => x.id === selected) + 1 : blocks.length;
    const copies = (b.content.blocks ?? []).map((x) => ({ ...x, id: newBlockId() }) as EmailBlock);
    set([...blocks.slice(0, at), ...copies, ...blocks.slice(at)]);
    if (copies[0]) setSelected(copies[0].id);
  };
  const set = (next: EmailBlock[]) => onChange({ ...design, blocks: next });
  const patch = (id: string, p: Partial<EmailBlock>) => set(blocks.map((b) => (b.id === id ? { ...b, ...p } as EmailBlock : b)));
  const insert = (type: EmailBlockType, at = selected ? blocks.findIndex((b) => b.id === selected) + 1 : blocks.length) => {
    const b = newBlock(type);
    set([...blocks.slice(0, at), b, ...blocks.slice(at)]);
    setSelected(b.id);
  };
  const move = (id: string, to: number) => {
    const from = blocks.findIndex((b) => b.id === id);
    const next = blocks.filter((b) => b.id !== id);
    next.splice(to > from ? to - 1 : to, 0, blocks[from]!);
    set(next);
  };
  const onDrop = (e: DragEvent, at: number) => {
    e.preventDefault(); setDropAt(null);
    if (readOnly) return;
    const type = e.dataTransfer.getData(DND) as EmailBlockType;
    if (type) insert(type, at);
    else if (dragId.current) move(dragId.current, at);
    dragId.current = null;
  };
  const dropZone = (at: number) => (
    <div className="pe-eb-drop" data-active={dropAt === at || undefined}
      onDragOver={(e) => { if (!readOnly) { e.preventDefault(); setDropAt(at); } }} onDragLeave={() => setDropAt(null)} onDrop={(e) => onDrop(e, at)} />
  );

  return (
    <div className="pe-designer">
      <Dialog open={!!saving} onClose={() => setSaving(null)} title={t('content.saveAsBlock')} footer={<>
        <Button onClick={() => setSaving(null)}>{t('common.cancel')}</Button>
        <Button variant="primary" busy={saveBlock.isPending} disabled={!blockName.trim()} onClick={() => saveBlock.mutate()}>{t('common.save')}</Button>
      </>}>
        <p className="pe-muted">{t('content.saveAsBlockHint')}</p>
        <TextField label={t('templates.field.name')} value={blockName} onChange={(e) => setBlockName(e.target.value)} autoFocus />
        <ErrorBanner error={saveBlock.error} />
      </Dialog>
      <aside className="pe-designer__blocks" aria-label={t('designer.blocks')}>
        <div className="pe-nav__label">{t('designer.blocks')}</div>
        {PALETTE.map(({ type, icon: Icon }) => (
          <button key={type} type="button" className="pe-palette-item" disabled={readOnly} draggable={!readOnly}
            onDragStart={(e) => { e.dataTransfer.setData(DND, type); e.dataTransfer.effectAllowed = 'copy'; }} onClick={() => insert(type)}>
            <span className="pe-iconchip pe-pill--primary" aria-hidden="true"><Icon /></span><span>{t(`designer.block.${type}`)}</span>
          </button>
        ))}
        <p className="pe-muted pe-palette-panel__hint">{t('designer.hint')}</p>
        {designBlocks.length > 0 && (
          <>
            <div className="pe-nav__label">{t('content.savedBlocks')}</div>
            {designBlocks.slice(0, 12).map((b) => (
              <button key={b.id} type="button" className="pe-palette-item" onClick={() => insertSaved(b)} title={t('content.insertBlock', { name: b.name })}>
                <span className="pe-iconchip pe-pill--info" aria-hidden="true"><Blocks /></span><span>{b.name}</span>
              </button>
            ))}
          </>
        )}
      </aside>

      <div className="pe-designer__stage" onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
        <div className="pe-row pe-designer__toolbar">
          <div className="pe-tabs" role="tablist" aria-label={t('designer.width')}>
            <button type="button" role="tab" aria-selected={width === 'desktop'} className="pe-tab" onClick={() => setWidth('desktop')}><Monitor aria-hidden="true" width={15} /> {t('designer.desktop')}</button>
            <button type="button" role="tab" aria-selected={width === 'mobile'} className="pe-tab" onClick={() => setWidth('mobile')}><Smartphone aria-hidden="true" width={15} /> {t('designer.mobile')}</button>
          </div>
          <span className="pe-spacer" />
          <Button variant="ghost" onClick={() => setSelected(null)}><Palette aria-hidden="true" />{t('designer.style')}</Button>
        </div>
        <div className="pe-designer__bg" style={{ background: design.style.background }}>
          <div className="pe-designer__email" dir={dir} data-width={width} style={{ background: design.style.content, borderRadius: design.style.radius, fontFamily: design.style.font === 'serif' ? 'Georgia, serif' : 'Arial, Helvetica, sans-serif' }}>
            {dropZone(0)}
            {blocks.map((b, i) => (
              <div key={b.id}>
                <div
                  className="pe-eb-wrap" data-selected={selected === b.id || undefined} data-block={b.type} tabIndex={0} role="button"
                  aria-label={t(`designer.block.${b.type}`)} aria-pressed={selected === b.id}
                  draggable={!readOnly} onDragStart={(e) => { dragId.current = b.id; e.dataTransfer.effectAllowed = 'move'; }}
                  onClick={() => setSelected(b.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(b.id); } }}
                >
                  <BlockPreview block={b} design={design} />
                  {selected === b.id && !readOnly && (
                    <div className="pe-eb-tools" onClick={(e) => e.stopPropagation()}>
                      <button type="button" aria-label={t('designer.moveUp')} disabled={i === 0} onClick={() => move(b.id, i - 1)}><ArrowUp /></button>
                      <button type="button" aria-label={t('designer.moveDown')} disabled={i === blocks.length - 1} onClick={() => move(b.id, i + 2)}><ArrowDown /></button>
                      <button type="button" aria-label={t('designer.duplicate')} onClick={() => { const c = { ...b, id: newBlockId() }; set([...blocks.slice(0, i + 1), c, ...blocks.slice(i + 1)]); setSelected(c.id); }}><Copy /></button>
                      <button type="button" aria-label={t('content.saveAsBlock')} title={t('content.saveAsBlock')} onClick={() => { setSaving(b); setBlockName(''); }}><BookmarkPlus /></button>
                      <button type="button" aria-label={t('designer.remove')} onClick={() => { set(blocks.filter((x) => x.id !== b.id)); setSelected(null); }}><Trash2 /></button>
                    </div>
                  )}
                </div>
                {dropZone(i + 1)}
              </div>
            ))}
            {blocks.length === 0 && <p className="pe-muted" style={{ padding: 32, textAlign: 'center' }}>{t('designer.empty')}</p>}
          </div>
        </div>
      </div>

      <aside className="pe-designer__props" aria-label={t('designer.properties')}>
        {sel ? <BlockProps block={sel} readOnly={readOnly} onPatch={(p) => patch(sel.id, p)} /> : <StyleProps design={design} readOnly={readOnly} onChange={onChange} />}
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="pe-field"><span>{label}</span>{children}</label>;
}

function AlignField({ value, onChange }: { value: BlockAlign; onChange: (a: BlockAlign) => void }) {
  const { t } = useTranslation();
  return (
    <Field label={t('designer.align')}>
      <select value={value} onChange={(e) => onChange(e.target.value as BlockAlign)}>
        {(['start', 'center', 'end'] as const).map((a) => <option key={a} value={a}>{t(`designer.alignOpt.${a}`)}</option>)}
      </select>
    </Field>
  );
}

function ColorField({ label, value, fallback, onChange }: { label: string; value: string | undefined; fallback: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <span className="pe-row" style={{ gap: 8 }}>
        <input type="color" value={value || fallback} onChange={(e) => onChange(e.target.value)} className="pe-color" />
        <input dir="ltr" value={value || fallback} onChange={(e) => onChange(e.target.value)} maxLength={9} style={{ inlineSize: '7em' }} />
      </span>
    </Field>
  );
}

function BlockProps({ block, readOnly, onPatch }: { block: EmailBlock; readOnly: boolean; onPatch: (p: Partial<EmailBlock>) => void }) {
  const { t } = useTranslation();
  let body: ReactNode = null;
  switch (block.type) {
    case 'header': body = <>
      <Field label={t('designer.f.text')}><input value={block.text} onChange={(e) => onPatch({ text: e.target.value })} /></Field>
      <AssetPicker kind="image" value={block.imageUrl} onPick={(a) => onPatch(a ? { imageUrl: a.url, imageAlt: a.name } : { imageUrl: undefined })} label={t('designer.f.logo')} />
      <ColorField label={t('designer.f.background')} value={block.background} fallback={DEFAULT_DESIGN_STYLE.accent} onChange={(v) => onPatch({ background: v })} />
      <ColorField label={t('designer.f.textColor')} value={block.color} fallback="#ffffff" onChange={(v) => onPatch({ color: v })} />
    </>; break;
    case 'heading': body = <>
      <Field label={t('designer.f.text')}><input value={block.text} onChange={(e) => onPatch({ text: e.target.value })} /></Field>
      <Field label={t('designer.f.size')}><select value={block.level} onChange={(e) => onPatch({ level: Number(e.target.value) as 1 | 2 })}><option value={1}>{t('designer.f.large')}</option><option value={2}>{t('designer.f.medium')}</option></select></Field>
      <AlignField value={block.align} onChange={(align) => onPatch({ align })} />
    </>; break;
    case 'text': body = <>
      <Field label={t('designer.f.text')}><textarea rows={8} value={block.text} onChange={(e) => onPatch({ text: e.target.value })} /></Field>
      <small className="pe-muted">{t('designer.formatHint')} <code dir="ltr">{'{{ contact.first_name }}'}</code></small>
      <AlignField value={block.align} onChange={(align) => onPatch({ align })} />
    </>; break;
    case 'image': body = <>
      <AssetPicker kind="image" value={block.src} onPick={(a) => onPatch(a ? { src: a.url, alt: block.alt || a.name.replace(/\.[^.]+$/, '') } : { src: '' })} label={t('designer.f.image')} />
      <Field label={t('designer.f.alt')}><input value={block.alt} onChange={(e) => onPatch({ alt: e.target.value })} /></Field>
      <Field label={t('designer.f.width', { n: block.width })}><input type="range" min={20} max={100} step={5} value={block.width} onChange={(e) => onPatch({ width: Number(e.target.value) })} /></Field>
      <Field label={t('designer.f.link')}><input dir="ltr" placeholder="https://" value={block.href ?? ''} onChange={(e) => onPatch({ href: e.target.value || undefined })} /></Field>
      <AlignField value={block.align} onChange={(align) => onPatch({ align })} />
    </>; break;
    case 'button': body = <>
      <Field label={t('designer.f.label')}><input value={block.label} onChange={(e) => onPatch({ label: e.target.value })} /></Field>
      <Field label={t('designer.f.link')}><input dir="ltr" value={block.href} onChange={(e) => onPatch({ href: e.target.value })} /></Field>
      <ColorField label={t('designer.f.background')} value={block.background} fallback={DEFAULT_DESIGN_STYLE.accent} onChange={(v) => onPatch({ background: v })} />
      <ColorField label={t('designer.f.textColor')} value={block.color} fallback="#ffffff" onChange={(v) => onPatch({ color: v })} />
      <AlignField value={block.align} onChange={(align) => onPatch({ align })} />
    </>; break;
    case 'spacer': body = <Field label={t('designer.f.height', { n: block.height })}><input type="range" min={8} max={96} step={4} value={block.height} onChange={(e) => onPatch({ height: Number(e.target.value) })} /></Field>; break;
    case 'columns': body = <>
      <Field label={t('designer.f.left')}><textarea rows={5} value={block.left} onChange={(e) => onPatch({ left: e.target.value })} /></Field>
      <Field label={t('designer.f.right')}><textarea rows={5} value={block.right} onChange={(e) => onPatch({ right: e.target.value })} /></Field>
      <small className="pe-muted">{t('designer.formatHint')} <code dir="ltr">{'{{ contact.first_name }}'}</code></small>
    </>; break;
    case 'footer': body = <Field label={t('designer.f.text')}><textarea rows={4} value={block.text} onChange={(e) => onPatch({ text: e.target.value })} /></Field>; break;
    case 'divider': body = <p className="pe-muted">{t('designer.noSettings')}</p>; break;
  }
  return (
    <fieldset className="pe-stack pe-fieldset" disabled={readOnly}>
      <legend>{t(`designer.block.${block.type}`)}</legend>
      {body}
    </fieldset>
  );
}

function StyleProps({ design, readOnly, onChange }: { design: EmailDesign; readOnly: boolean; onChange: (d: EmailDesign) => void }) {
  const { t } = useTranslation();
  const s = design.style;
  const set = (p: Partial<EmailDesign['style']>) => onChange({ ...design, style: { ...s, ...p } });
  return (
    <fieldset className="pe-stack pe-fieldset" disabled={readOnly}>
      <legend>{t('designer.style')}</legend>
      <ColorField label={t('designer.s.background')} value={s.background} fallback={DEFAULT_DESIGN_STYLE.background} onChange={(v) => set({ background: v })} />
      <ColorField label={t('designer.s.content')} value={s.content} fallback={DEFAULT_DESIGN_STYLE.content} onChange={(v) => set({ content: v })} />
      <ColorField label={t('designer.s.text')} value={s.text} fallback={DEFAULT_DESIGN_STYLE.text} onChange={(v) => set({ text: v })} />
      <ColorField label={t('designer.s.accent')} value={s.accent} fallback={DEFAULT_DESIGN_STYLE.accent} onChange={(v) => set({ accent: v })} />
      <Field label={t('designer.s.font')}><select value={s.font} onChange={(e) => set({ font: e.target.value as 'sans' | 'serif' })}><option value="sans">{t('designer.s.sans')}</option><option value="serif">{t('designer.s.serif')}</option></select></Field>
      <Field label={t('designer.s.radius', { n: s.radius })}><input type="range" min={0} max={24} value={s.radius} onChange={(e) => set({ radius: Number(e.target.value) })} /></Field>
      <small className="pe-muted">{t('designer.styleHint')}</small>
    </fieldset>
  );
}
