// Visual email designs: a list of blocks that renders to email-safe HTML (tables and inline styles, 600px wide,
// mobile-friendly). The console's designer edits the blocks; the rendered HTML is what's stored, rendered with
// Liquid and sent, so the delivery pipeline doesn't know or care that a design was used.

export type BlockAlign = 'start' | 'center' | 'end';
interface BlockBase { id: string }
export interface HeaderBlock extends BlockBase { type: 'header'; text: string; imageUrl?: string; imageAlt?: string; background?: string; color?: string }
export interface HeadingBlock extends BlockBase { type: 'heading'; text: string; level: 1 | 2; align: BlockAlign }
export interface TextBlock extends BlockBase { type: 'text'; text: string; align: BlockAlign }
export interface ImageBlock extends BlockBase { type: 'image'; src: string; alt: string; width: number; href?: string; align: BlockAlign }
export interface ButtonBlock extends BlockBase { type: 'button'; label: string; href: string; align: BlockAlign; background?: string; color?: string }
export interface DividerBlock extends BlockBase { type: 'divider' }
export interface SpacerBlock extends BlockBase { type: 'spacer'; height: number }
export interface ColumnsBlock extends BlockBase { type: 'columns'; left: string; right: string }
export interface FooterBlock extends BlockBase { type: 'footer'; text: string }
export type EmailBlock = HeaderBlock | HeadingBlock | TextBlock | ImageBlock | ButtonBlock | DividerBlock | SpacerBlock | ColumnsBlock | FooterBlock;
export type EmailBlockType = EmailBlock['type'];

export interface EmailDesignStyle { background: string; content: string; text: string; accent: string; font: 'sans' | 'serif'; radius: number }
export interface EmailDesign { version: 1; style: EmailDesignStyle; blocks: EmailBlock[] }

export const DEFAULT_DESIGN_STYLE: EmailDesignStyle = { background: '#f4f1ea', content: '#ffffff', text: '#1f2d2b', accent: '#0f6e6a', font: 'sans', radius: 12 };

let seq = 0;
export const newBlockId = () => `b${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A sensible starting point for each block type. */
export function newBlock(type: EmailBlockType): EmailBlock {
  const id = newBlockId();
  switch (type) {
    case 'header': return { id, type, text: '{{ brand.name }}' };
    case 'heading': return { id, type, text: 'A clear, friendly headline', level: 1, align: 'start' };
    case 'text': return { id, type, text: 'Hello {{ contact.first_name | default: \'there\' }},\n\nWrite your message here. Use **bold**, *italic* and [links](https://example.com).', align: 'start' };
    case 'image': return { id, type, src: '', alt: '', width: 100, align: 'center' };
    case 'button': return { id, type, label: 'Book now', href: 'https://example.com', align: 'start' };
    case 'divider': return { id, type };
    case 'spacer': return { id, type, height: 24 };
    case 'columns': return { id, type, left: '**Left column**\nShort supporting text.', right: '**Right column**\nShort supporting text.' };
    case 'footer': return { id, type, text: 'You are receiving this because you are a member of {{ brand.name }}.' };
  }
}

export function starterDesign(): EmailDesign {
  return { version: 1, style: { ...DEFAULT_DESIGN_STYLE }, blocks: [newBlock('header'), newBlock('heading'), newBlock('text'), newBlock('button'), newBlock('footer')] };
}

// ---------- rendering ----------

const LIQUID = /(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\})/g;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Escapes text but leaves Liquid tags intact so personalisation still works. */
const escText = (s: string) => s.split(LIQUID).map((part, i) => (i % 2 ? part : esc(part))).join('');
/** For attribute values: Liquid stays, but its double quotes become single quotes so the attribute isn't cut short. */
const escAttr = (s: string) => s.split(LIQUID).map((part, i) => (i % 2 ? part.replace(/"/g, "'") : esc(part))).join('');
const color = (c: string | undefined, fallback: string) => (c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : fallback);
const safeUrl = (u: string | undefined) => {
  const v = (u ?? '').trim();
  return /^(https?:\/\/|mailto:|tel:|\{\{)/i.test(v) ? v : '';
};

/** **bold**, *italic*, [label](url) and line breaks, on escaped text. */
function inline(text: string, accent: string): string {
  let html = escText(text);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const href = safeUrl(url.replace(/&amp;/g, '&'));
    return href ? `<a href="${escAttr(href)}" style="color:${accent};text-decoration:underline">${label}</a>` : label;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return html.replace(/\r?\n/g, '<br>');
}

export function renderEmailDesign(design: EmailDesign, { dir = 'ltr' }: { dir?: 'ltr' | 'rtl' } = {}): string {
  const s = { ...DEFAULT_DESIGN_STYLE, ...design.style };
  const accent = color(s.accent, DEFAULT_DESIGN_STYLE.accent);
  const text = color(s.text, DEFAULT_DESIGN_STYLE.text);
  const font = dir === 'rtl' ? "Tahoma,'Segoe UI',Arial,sans-serif" : s.font === 'serif' ? "Georgia,'Times New Roman',serif" : 'Arial,Helvetica,sans-serif';
  const radius = Math.max(0, Math.min(24, Math.round(Number(s.radius) || 0)));
  const align = (a: BlockAlign) => (a === 'center' ? 'center' : (a === 'start') === (dir === 'ltr') ? 'left' : 'right');
  const pad = 'padding:12px 32px';

  const row = (inner: string, style = pad) => `<tr><td style="${style}">${inner}</td></tr>`;
  const rows = design.blocks.map((b) => {
    switch (b.type) {
      case 'header': {
        const bg = color(b.background, accent);
        const fg = color(b.color, '#ffffff');
        const src = safeUrl(b.imageUrl);
        const inner = src
          ? `<img src="${escAttr(src)}" alt="${escAttr(b.imageAlt ?? b.text)}" height="40" style="display:block;border:0;height:40px;width:auto;margin:0 auto">`
          : `<span style="font-size:20px;font-weight:700;color:${fg};letter-spacing:0.2px">${escText(b.text)}</span>`;
        return row(inner, `padding:22px 32px;background:${bg};text-align:center;border-radius:${radius}px ${radius}px 0 0`);
      }
      case 'heading':
        return row(`<h${b.level} style="margin:0;font-size:${b.level === 1 ? 26 : 20}px;line-height:1.3;color:${text};text-align:${align(b.align)};font-weight:700">${escText(b.text)}</h${b.level}>`);
      case 'text':
        return row(`<p style="margin:0;font-size:16px;line-height:1.6;color:${text};text-align:${align(b.align)}">${inline(b.text, accent)}</p>`);
      case 'image': {
        const src = safeUrl(b.src);
        if (!src) return '';
        const w = Math.max(10, Math.min(100, Math.round(b.width || 100)));
        const img = `<img src="${escAttr(src)}" alt="${escAttr(b.alt)}" width="${Math.round(536 * w / 100)}" style="display:inline-block;border:0;width:${w}%;max-width:100%;height:auto;border-radius:${Math.min(radius, 12)}px">`;
        const href = safeUrl(b.href);
        return row(`<div style="text-align:${align(b.align)}">${href ? `<a href="${escAttr(href)}">${img}</a>` : img}</div>`);
      }
      case 'button': {
        const href = safeUrl(b.href) || '#';
        const bg = color(b.background, accent);
        const fg = color(b.color, '#ffffff');
        return row(`<div style="text-align:${align(b.align)}"><a href="${escAttr(href)}" style="display:inline-block;background:${bg};color:${fg};font-size:16px;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:${Math.max(6, radius - 2)}px">${escText(b.label)}</a></div>`, 'padding:16px 32px');
      }
      case 'divider':
        return row(`<div style="border-top:1px solid #e4e0d8;font-size:0;line-height:0">&nbsp;</div>`, 'padding:16px 32px');
      case 'spacer': {
        const h = Math.max(4, Math.min(120, Math.round(b.height || 24)));
        return row(`<div style="height:${h}px;font-size:0;line-height:0">&nbsp;</div>`, 'padding:0');
      }
      case 'columns': {
        const cell = (c: string) => `<td class="pe-col" width="50%" valign="top" style="padding:0 8px;font-size:15px;line-height:1.55;color:${text}">${inline(c, accent)}</td>`;
        return row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cell(b.left)}${cell(b.right)}</tr></table>`, 'padding:12px 24px');
      }
      case 'footer':
        return row(`<p style="margin:0;font-size:12px;line-height:1.6;color:#6b7b83;text-align:center">${inline(b.text, '#6b7b83')}</p>`, `padding:20px 32px 26px;border-top:1px solid #efece5`);
    }
  }).join('');

  const contentBg = color(s.content, '#ffffff');
  return `<div style="margin:0;padding:24px 12px;background:${color(s.background, DEFAULT_DESIGN_STYLE.background)}">`
    + `<style>@media (max-width:620px){.pe-col{display:block!important;width:100%!important;padding:6px 0!important}}</style>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${dir}"><tr><td align="center">`
    + `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${contentBg};border-radius:${radius}px;font-family:${font};border-collapse:separate">`
    + rows
    + `</table></td></tr></table></div>`;
}
