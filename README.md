# SnapWall

Shared event albums that live in **your own Google Drive**. Create an event, share a QR code, and guests add photos and videos from their phones: no app, no account. SnapWall never keeps a copy of any media.

```
GitHub Pages (web/)  ──JSON──▶  Cloudflare Worker + D1 (api/)  ──Drive API──▶  Admin's Google Drive
       └──────────── photo/video bytes go straight to Google via a one-time upload URL ─────────▲
```

- **web/**: Svelte + Vite static site, deployed to GitHub Pages. Hash routing, so no server rewrites are needed and link secrets stay in the URL fragment.
- **api/**: Cloudflare Worker (Hono) with a D1 database holding metadata only: events, settings, upload records and encrypted Google tokens.
- **shared/**: API types used by both.

## How privacy works

| | |
|---|---|
| Storage | Files are uploaded by the guest's browser directly into a resumable Drive upload session that the Worker opens for that one file. Media bytes never pass through or rest on SnapWall when uploading. |
| Drive scope | `drive.file` only: SnapWall sees the folders and files it created, nothing else in the Drive. |
| Viewing | Drive files are never shared publicly. The wall loads them through the Worker using HMAC-signed URLs that expire within an hour, and every request re-checks the event's live state (disabled, hidden item, view/download off). |
| Links | Guest link (24 random bytes) and admin link (32 random bytes) are separate. Only their hashes are used for lookup; the admin link is shown once. Either can be replaced at any time. |
| Tokens at rest | Google refresh/access tokens and guest tokens are AES-GCM encrypted with `TOKEN_KEY`. |
| Location data | GPS/EXIF/XMP/IPTC is stripped from JPEG and PNG in the browser before upload (lossless, orientation kept). |
| Abuse | Per-event, per-IP rate limits (the IP is kept only as a salted hash), type allowlist (no SVG/HTML), size limits, optional PIN, optional approval queue. |
| Analytics | Page loads are counted with GoatCounter (no cookies, no IP addresses kept). Only the path `/snapwall/` and a fixed title are sent; event names and link tokens never leave the browser. |
| Removal | Disable an event (links show "closed"), delete it (optionally trashing the Drive folder), or disconnect Google, which revokes access and erases the account. |

## Known limits

- HEIC and video files keep their embedded metadata (only JPEG/PNG are stripped). iOS usually converts photos to JPEG when uploading from Safari.
- Thumbnails are cached with the Cache API, which only works once the Worker has a custom domain; on `*.workers.dev` every thumbnail is fetched from Drive.
- Large or heavily watched videos stream through the Worker. For very big events, consider keeping guest download on and the slideshow photo-only (it already skips videos).
