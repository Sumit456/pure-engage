# ADR-0008: Content Builder (files, content blocks, push and WhatsApp authoring)

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

Marketers need one place, like SFMC Content Builder, for everything they make:
- emails, SMS, push and WhatsApp messages;
- reusable content blocks;
- the files those messages use: images, PDFs, video, audio and Office documents.

Until now the console had a list of email and SMS templates, and a 2 MB image library used only by the email designer.

## Decisions

### One library, many types
The console's **Content** section (`/content`) lists every kind of content and file together. A single API
(`GET /api/content`) unions templates, content blocks and assets, returning metadata only. Content can be filtered
by type, folder, name and tag.

### Folders and tags for everything
- Folders form a tree in `content_folders`, shared by templates, blocks and files.
- A folder can only be deleted when it is empty, and it can't be moved inside itself.
- Tags are lower-case strings stored as jsonb.
- Moving several items at once uses `POST /api/content/move`.

### Files are checked from their bytes
`sniffFile` accepts these types:
- PNG, JPEG, GIF and WebP images;
- PDF;
- MP4 and WebM video;
- MP3 audio;
- DOCX, XLSX and PPTX, which must be a ZIP containing the matching folder *and* have the matching file extension;
- CSV and TXT, which must be valid UTF-8 with no markup.

SVG and HTML are refused because they can carry script. Each kind has its own size limit:

| Kind | Limit |
|---|---|
| Images | 5 MB |
| Documents | 10 MB |
| Video and audio | 20 MB |

The library uploads raw bytes (`POST /api/assets/upload`) with per-file progress. The email designer keeps its
base64 route, which accepts images only.

### Storage sits behind an interface
File bytes live in `asset_blobs`, separate from their metadata, behind `AssetStore` (`services/storage.ts`). This
keeps listings light and lets an S3-compatible store replace the database later without touching the rest of the
app.

The database is the store for now because Render's free disk is wiped on every deploy. The library shows how much
space is used, and the free database holds 1 GB in total.

### Public delivery
`/a/:id` serves files publicly, because email clients and apps fetch them without a session. The URLs are random
UUIDs. Responses have:
- `nosniff`;
- a sandboxed CSP;
- immutable caching;
- `inline` disposition only for media, PDF and plain text; everything else downloads.

Single HTTP ranges are supported so video can seek. The range is cut in SQL.

### A file can't be deleted while it's in use
A file can't be deleted while the current version of a template, or a content block, refers to it by id or by URL.
The error names where it is used.

### Content blocks are inserted as copies
Designer blocks saved as a content block appear in every email's designer. Inserting one adds a copy, so editing the
saved block later never changes an email that has already been built or sent. Live-linked blocks would need a render
step at send time, which is a separate decision. HTML and text blocks are stored for reuse as well.

### Push and WhatsApp are authored now and sent later
`templates.channel` now accepts `push` and `whatsapp`, validated and versioned like email and SMS:
- **Push:** title, body, an image from the library, a deep link, and data.
- **WhatsApp:** header (text, image, video or PDF), body, footer, up to 3 buttons, the Meta category, and an approval
  status entered by hand.

Liquid is checked on save and rendered in previews. `assertSendable` refuses these channels in delivery, campaigns
and journeys until their providers (Firebase, a WhatsApp Business sender) are connected. That will need a new ADR
covering consent for `whatsapp`.

### AI assistants
With `drafts:write`, assistants can create push and WhatsApp drafts. With a read scope they can browse the library
(`list_content`). They still cannot send.

## Consequences

- `/templates` URLs redirect to `/content/<channel>/<id>`. The template API is unchanged apart from the new channels
  and the `folder_id` and `tags` fields.
- Sending WhatsApp later needs a `whatsapp` consent channel, Meta template sync, and per-template approval tracking
  from the provider instead of by hand.
