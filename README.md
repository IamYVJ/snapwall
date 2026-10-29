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
| Location data | Removed in the browser before upload, losslessly. JPEG, PNG and WebP lose EXIF/XMP/IPTC (JPEG orientation kept). HEIC/HEIF/AVIF and MP4/MOV address data by byte offset, so location is overwritten in place: the HEIF Exif item is cut to its orientation, video `©xyz`/`loci` boxes and Apple location keys are cleared, and XMP GPS and place fields are blanked. Hosts can turn this off per event. |
| Abuse | Per-event, per-IP rate limits (the IP is kept only as a salted hash), optional per-guest file and storage limits (keyed by a random per-browser ID, kept only as a salted per-event hash), type allowlist (no SVG/HTML), size limits, optional PIN, optional approval queue. |
| Analytics | Page loads are counted with GoatCounter (no cookies, no IP addresses kept). Only the path `/snapwall/` and a fixed title are sent; event names and link tokens never leave the browser. |
| Removal | Disable an event (links show "closed"), delete it (optionally trashing the Drive folder), or disconnect Google, which revokes access and erases the account. |

## Checks

`npm run check` type-checks both packages and `npm test` runs the tests. The API tests run the real Worker against an in-memory local D1 with every migration applied, without calling Google. Both deploy workflows run these before deploying, and the Checks workflow runs them on pull requests and other branches.

## Known limits

- Location removal covers the standard places cameras and phones write it. Formats not listed (GIF, WebM, 3GP without ISO boxes) pass through unchanged, and a file whose structure can't be read is uploaded as it is.
- Thumbnails are cached with the Cache API, which only works once the Worker has a custom domain; on `*.workers.dev` every thumbnail is fetched from Drive.
- Per-guest limits count per browser, so a guest who clears their browser data or switches browsers starts again. They stop a guest filling the Drive by accident, not a determined one.
- "Download all" writes the ZIP straight to disk in Chrome and Edge on desktop. Other browsers build it in memory first, which can fail for very large events; downloading the Drive folder works everywhere.
- Large or heavily watched videos stream through the Worker. For very big events, consider keeping guest download on and the slideshow photo-only (it already skips videos).
