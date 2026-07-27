# US-E05: Attachment extraction and R2 upload

*2026-07-27T19:46:00Z by Showboat 0.6.1*
<!-- showboat-id: 6ec878a1-a3fa-4d7a-be96-74bcc1ed74d5 -->

Inbound attachments are now downloaded from Resend's Attachments API, streamed into the private R2 bucket under a key namespaced by the received-email id, and recorded one row per file in `attachments` (filename, content type, size, R2 key — never a URL, since the bucket is private and download links are presigned on demand).

A failing attachment is logged and omitted: the email itself is already stored and acknowledged, so throwing would make Resend redeliver a message whose duplicate check short-circuits — the retry could never repair the attachment and every attempt would be a 500 no-op.

```bash
git --no-pager diff --stat main -- src
```

```output
 src/lib/server/db/attachments.ts                  |  34 +++++
 src/lib/server/email/resend.ts                    |  43 +++++++
 src/lib/server/inbound/attachments.ts             | 138 ++++++++++++++++++++
 src/lib/server/inbound/verify-inbound-parse.mts   | 150 ++++++++++++++++++++++
 src/routes/api/webhooks/resend-inbound/+server.ts |  35 ++++-
 5 files changed, 396 insertions(+), 4 deletions(-)
```

The provider hops are **injected**, not imported: `server/email/resend.ts` and `server/r2` both read env at module scope, so keeping them out of `inbound/attachments.ts` leaves it drivable from a standalone tsx script (same rule as `parse.ts`/`store.ts`). The endpoint wires the real ones.

```bash
sed -n '1,20p' src/lib/server/inbound/attachments.ts
```

```output
// Attachment extraction for inbound ingestion (US-E05,
// tasks/prd-feature-inbound-processing.md).
//
// The `email.received` webhook carries attachment *metadata* only, and so does
// the fetched received-email record — the bytes live behind Resend's
// Attachments API. So each attachment is a separate download, and each download
// is streamed straight into R2; nothing is ever written to a database column
// (FR-5).
//
// The two provider-facing operations (fetch the bytes, put them in R2) are
// **injected** rather than imported: `server/email/resend.ts` and `server/r2`
// both read env, and keeping them out of this module means it stays drivable
// from a standalone `tsx` script with stubs, like `parse.ts` and `store.ts`.
import { insertAttachment, type Attachment } from '../db/attachments';
import type { Database } from '../db/types';
import type { ReceivedEmailRecord } from './parse';

export type InboundAttachmentMetadata = ReceivedEmailRecord['attachments'][number];

export type AttachmentBytes = { bytes: Uint8Array; contentType?: string | null };
```

### Verification

The ingestion smoke test (`verify-inbound-parse.mts`) grew two sections: pure key/filename derivation, and a live-Turso run of `storeInboundAttachments` with the download and upload stubbed — real R2-key derivation, real `attachments` insert, one attachment deliberately failing. Filtered to the US-E05 checks (the run's per-row cleanup counts and its hrtime-derived stamp are non-deterministic).

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/inbound/verify-inbound-parse.mts 2>/dev/null | sed -E "s/us-e05-[0-9]+/us-e05-STAMP/g" | grep -E "^(attachment|storeInboundAttachments|  ok   (a plain|a path|a windows|a null|a filename|control|an absurdly|the key|two attach|the failing|the other|only success|exactly two|filename is|content type|size comes|the R2 key|a nameless))|checks passed"
```

```output
  ok   a null message_id falls back to the Resend email id
attachmentFilename / attachmentObjectKey
  ok   a plain filename survives
  ok   a path-traversal filename is reduced to its last segment
  ok   a windows path is reduced too
  ok   a null filename falls back to the attachment id
  ok   a filename that is only path punctuation falls back too
  ok   control bytes are stripped
  ok   an absurdly long name is truncated
  ok   the key is namespaced by the received-email id and the attachment id
  ok   the key never carries a sender-chosen path
  ok   two attachments sharing a filename get different keys
storeInboundAttachments — live DB
  ok   the failing attachment is reported, not thrown
  ok   the other two are stored
  ok   only successful uploads hit R2
  ok   exactly two attachment rows exist for the email
  ok   filename is stored
  ok   content type is stored
  ok   size comes from the downloaded bytes
  ok   the R2 key is stored, not a URL
  ok   a nameless attachment still gets a filename
118/118 checks passed
```

The R2 leg itself (put → presign → fetch → delete against the real bucket) is already covered by `src/lib/server/r2/verify.mts`; nothing about that changed, so it is re-run here only as a regression check that the upload target the endpoint now writes to still works.

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/r2/verify.mts 2>&1 | sed -E "s/[0-9]{4}-[0-9]{2}-[0-9]{2}T[^ ]*//g"
```

```output
upload: ok
presigned url is https: true
fetch via presigned url status: 200
fetched body matches: true
delete: ok
fetch after delete status (expect 4xx): 404
```

### Quality checks

```bash
npm run check 2>&1 | grep -oE "COMPLETED [0-9]+ FILES [0-9]+ ERRORS [0-9]+ WARNINGS [0-9]+ FILES_WITH_PROBLEMS"
```

```output
COMPLETED 1489 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```

```bash
npm run lint 2>&1 | tail -n 2
```

```output
Checking formatting...
All matched files use Prettier code style!
```
