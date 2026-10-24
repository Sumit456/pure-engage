import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { sniffFile } from '../src/services/assets.ts';
import { parseRange } from '../src/routes/assets.ts';
import { emailTemplate, loginAs, makeContact, makeTemplate, testApp, truncateAll } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => { ctx = await testApp(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await truncateAll(ctx.db); });

// Synthetic test files: just enough bytes for each format's signature.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4), Buffer.from('isommp41'), Buffer.alloc(1000, 7)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 1)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100, 2)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml ... word/document.xml')]);

const upload = (who: Awaited<ReturnType<typeof loginAs>>, name: string, data: Buffer, folder?: string) =>
  who.request({ method: 'POST', url: '/api/assets/upload', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), ...(folder ? { 'x-folder-id': folder } : {}) }, payload: data });

test('files are typed by their bytes; scripts and disguised files are refused', () => {
  expect(sniffFile(PDF, 'x.bin')).toMatchObject({ type: 'application/pdf', kind: 'document' });
  expect(sniffFile(MP4, 'clip')).toMatchObject({ type: 'video/mp4', kind: 'video' });
  expect(sniffFile(WEBM, 'clip')).toMatchObject({ type: 'video/webm', kind: 'video' });
  expect(sniffFile(MP3, 'a')).toMatchObject({ type: 'audio/mpeg', kind: 'audio' });
  expect(sniffFile(DOCX, 'Brief.docx')).toMatchObject({ kind: 'document', type: expect.stringContaining('wordprocessingml') });
  expect(sniffFile(DOCX, 'Brief.xlsx')).toBeNull(); // a Word file renamed to .xlsx
  expect(sniffFile(Buffer.from('member,city\nMBR-TEST-1,Dubai\n'), 'list.csv')).toMatchObject({ type: 'text/csv' });
  expect(sniffFile(Buffer.from('<html><script>alert(1)</script></html>'), 'page.txt')).toBeNull();
  expect(sniffFile(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg')).toBeNull();
  expect(sniffFile(Buffer.from('MZ\x90\x00'), 'setup.pdf')).toBeNull();
  expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
  expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
  expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  expect(parseRange('bytes=2000-', 1000)).toBe('invalid');
});

test('raw uploads into folders, ranges for video, inline vs download, and size limits per kind', async () => {
  const m = await loginAs(ctx.app, 'marketer');
  const folder = (await m.request({ method: 'POST', url: '/api/folders', payload: { name: 'Campaign assets' } })).json();
  const pdf = await upload(m, 'Health guide.pdf', PDF, folder.id);
  expect(pdf.statusCode).toBe(201);
  expect(pdf.json()).toMatchObject({ name: 'Health guide.pdf', kind: 'document', content_type: 'application/pdf', folder_id: folder.id });
  const video = (await upload(m, 'Intro.mp4', MP4)).json();
  expect(video.kind).toBe('video');

  const ranged = await ctx.app.inject({ method: 'GET', url: `/a/${video.id}`, headers: { range: 'bytes=0-7' } });
  expect(ranged.statusCode).toBe(206);
  expect(ranged.headers['content-range']).toBe(`bytes 0-7/${MP4.length}`);
  expect(ranged.rawPayload.equals(MP4.subarray(0, 8))).toBe(true);
  expect((await ctx.app.inject({ method: 'GET', url: `/a/${video.id}`, headers: { range: 'bytes=99999-' } })).statusCode).toBe(416);
  const full = await ctx.app.inject({ method: 'GET', url: `/a/${pdf.json().id}` });
  expect(full.headers).toMatchObject({ 'content-type': 'application/pdf', 'content-disposition': 'inline', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' });
  const docx = (await upload(m, 'Brief.docx', DOCX)).json();
  expect((await ctx.app.inject({ method: 'GET', url: `/a/${docx.id}` })).headers['content-disposition']).toBe('attachment; filename="Brief.docx"');

  expect((await upload(m, 'evil.svg', Buffer.from('<svg/>'))).statusCode).toBe(400);
  expect((await upload(m, 'big.pdf', Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]))).statusCode).toBe(413);
  expect((await upload(m, 'x.png', PNG, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(400);
  // The designer's inline upload stays images-only.
  expect((await m.request({ method: 'POST', url: '/api/assets', payload: { name: 'g.pdf', data: PDF.toString('base64') } })).statusCode).toBe(400);

  const usage = (await m.request({ method: 'GET', url: '/api/assets/usage' })).json();
  expect(usage).toMatchObject({ files: 3, bytes: PDF.length + MP4.length + DOCX.length, limits: { video: 20 * 1024 * 1024 } });
  const viewer = await loginAs(ctx.app, 'viewer');
  expect((await upload(viewer, 'x.png', PNG)).statusCode).toBe(403);
});

test('folders: tree, no loops, only empty folders can be deleted; items move between folders', async () => {
  const m = await loginAs(ctx.app, 'marketer');
  const top = (await m.request({ method: 'POST', url: '/api/folders', payload: { name: 'Ramadan 2027' } })).json();
  const sub = (await m.request({ method: 'POST', url: '/api/folders', payload: { name: 'Images', parent_id: top.id } })).json();
  expect((await m.request({ method: 'PATCH', url: `/api/folders/${top.id}`, payload: { parent_id: sub.id } })).statusCode).toBe(400);
  const img = (await upload(m, 'hero.png', PNG, sub.id)).json();
  const tpl = await makeTemplate(ctx.app, emailTemplate());
  expect((await m.request({ method: 'DELETE', url: `/api/folders/${sub.id}` })).statusCode).toBe(409);
  await m.request({ method: 'POST', url: '/api/content/move', payload: { folder_id: top.id, items: [{ type: 'image', id: img.id }, { type: 'email', id: tpl.id }] } });
  const folders = (await m.request({ method: 'GET', url: '/api/folders' })).json().data;
  expect(folders.find((f: { id: string }) => f.id === top.id).items).toBe(2);
  expect(folders.find((f: { id: string }) => f.id === sub.id).items).toBe(0);
  expect((await m.request({ method: 'DELETE', url: `/api/folders/${sub.id}` })).statusCode).toBe(204);
});

test('push and WhatsApp content: validated, files must match, previewed, never sent (yet)', async () => {
  const m = await loginAs(ctx.app, 'marketer');
  const img = (await upload(m, 'offer.png', PNG)).json();
  const pdf = (await upload(m, 'guide.pdf', PDF)).json();
  const push = await m.request({ method: 'POST', url: '/api/templates', payload: {
    name: 'Check-up reminder', channel: 'push', purpose: 'care',
    content: { en: { title: 'Hi {{ contact.first_name }}', body: 'Your check-up is due.', image_asset_id: img.id, deep_link: 'pura://appointments', data: { screen: 'booking' } }, ar: { title: 'مرحبًا', body: 'موعد فحصك.' } },
  } });
  expect(push.statusCode).toBe(201);
  expect((await m.request({ method: 'POST', url: '/api/templates', payload: { name: 'Bad', channel: 'push', purpose: 'care', content: { en: { title: 'x', body: 'y', image_asset_id: pdf.id } } } })).statusCode).toBe(400);
  expect((await m.request({ method: 'POST', url: '/api/templates', payload: { name: 'Bad', channel: 'push', purpose: 'care', content: { en: { title: '{{ broken', body: 'y' } } } })).statusCode).toBe(400);

  const wa = await m.request({ method: 'POST', url: '/api/templates', payload: {
    name: 'Guide on WhatsApp', channel: 'whatsapp', purpose: 'marketing', tags: ['Wellness', 'wellness'],
    content: { en: { header: { type: 'document', asset_id: pdf.id }, body: 'Hello {{ contact.first_name }}, here is your guide.', footer: 'Reply STOP to opt out', category: 'marketing',
      buttons: [{ type: 'url', text: 'Book', url: 'https://example.com/book' }, { type: 'quick_reply', text: 'Not now' }] } },
  } });
  expect(wa.statusCode).toBe(201);
  expect(wa.json()).toMatchObject({ tags: ['wellness'] });
  expect(wa.json().content.en).toMatchObject({ approval: 'draft' });
  expect((await m.request({ method: 'POST', url: '/api/templates', payload: { name: 'Bad', channel: 'whatsapp', purpose: 'care', content: { en: { header: { type: 'image', asset_id: pdf.id }, body: 'x' } } } })).statusCode).toBe(400);
  expect((await m.request({ method: 'POST', url: '/api/templates', payload: { name: 'Bad', channel: 'whatsapp', purpose: 'care', content: { en: { header: { type: 'none' }, body: 'x', buttons: [1, 2, 3, 4].map(() => ({ type: 'quick_reply', text: 'a' })) } } } })).statusCode).toBe(400);

  const preview = await m.request({ method: 'POST', url: '/api/templates/preview', payload: { channel: 'push', content: push.json().content, locale: 'en' } });
  expect(preview.json()).toMatchObject({ fields: { title: 'Hi Test', body: 'Your check-up is due.' } });

  // Referenced files can't be deleted from under the content.
  const del = await m.request({ method: 'DELETE', url: `/api/assets/${pdf.id}` });
  expect(del.statusCode).toBe(409);
  expect(del.json().error).toContain('Guide on WhatsApp');
  expect((await m.request({ method: 'GET', url: `/api/assets/${pdf.id}` })).json().used_in).toEqual([{ type: 'whatsapp', id: wa.json().id, name: 'Guide on WhatsApp' }]);

  const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-9001', first_name: 'Test', phone: '+971500000901', consent: { push: { care: 'granted' } } });
  await expect(ctx.app.services.delivery.enqueue({ contact: c, templateId: push.json().id, source: 'test' })).rejects.toThrow('can be authored but not sent yet');
  const seg = await ctx.app.services.segments.create({ name: 'All', rules: { type: 'group', op: 'and', rules: [] } }, { type: 'system' });
  expect((await m.request({ method: 'POST', url: '/api/campaigns', payload: { name: 'Push blast', template_id: push.json().id, segment_id: seg.id } })).statusCode).toBe(400);
});

test('content blocks and the one library listing across every type', async () => {
  const m = await loginAs(ctx.app, 'marketer');
  const folder = (await m.request({ method: 'POST', url: '/api/folders', payload: { name: 'Shared' } })).json();
  const block = await m.request({ method: 'POST', url: '/api/content-blocks', payload: { name: 'Clinic footer', kind: 'design', folder_id: folder.id, tags: ['footer'], content: { blocks: [{ id: 'b1', type: 'footer', text: 'Synthetic Clinic' }] } } });
  expect(block.statusCode).toBe(201);
  expect((await m.request({ method: 'POST', url: '/api/content-blocks', payload: { name: 'Empty', kind: 'html', content: { html: '' } } })).statusCode).toBe(400);
  const updated = await m.request({ method: 'PUT', url: `/api/content-blocks/${block.json().id}`, payload: { content: { blocks: [{ id: 'b1', type: 'footer', text: 'Updated' }] } } });
  expect(updated.json().content.blocks[0].text).toBe('Updated');
  await makeTemplate(ctx.app, emailTemplate({ name: 'Welcome email' }));
  await upload(m, 'Welcome banner.png', PNG, folder.id);

  const all = (await m.request({ method: 'GET', url: '/api/content' })).json();
  expect(all.total).toBe(3);
  expect(all.data.map((i: { type: string }) => i.type).sort()).toEqual(['block', 'email', 'image']);
  const inFolder = (await m.request({ method: 'GET', url: `/api/content?folder_id=${folder.id}` })).json();
  expect(inFolder.data.map((i: { name: string }) => i.name).sort()).toEqual(['Clinic footer', 'Welcome banner.png']);
  expect((await m.request({ method: 'GET', url: '/api/content?folder_id=root' })).json().data.map((i: { name: string }) => i.name)).toEqual(['Welcome email']);
  expect((await m.request({ method: 'GET', url: '/api/content?q=welcome&type=image' })).json().data).toHaveLength(1);
  expect((await m.request({ method: 'GET', url: '/api/content?tag=footer' })).json().data[0].name).toBe('Clinic footer');
  await m.request({ method: 'DELETE', url: `/api/content-blocks/${block.json().id}` });
  expect((await m.request({ method: 'GET', url: '/api/content?type=block' })).json().total).toBe(0);
});
