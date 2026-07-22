# Phase 3 vendor and architecture gate

Status: **Gate 3.0 complete for isolated staging implementation**
Reviewed: **2026-07-22**
Scope: AidoFor.me Phase 3 document ingestion and requirement confirmation
Production authority: **not granted**

This gate records current official terms and the implementation boundary for the durable document pipeline. It does not claim that the external staging services have been provisioned or that the Phase 3 exit gate has passed. Live service evidence remains required before Phase 3 can exit.

## Decision

The Phase 3 staging architecture is approved for implementation with these fixed boundaries:

1. **Vercel Queues in `sin1`** carries only opaque job, document-version, and idempotency identifiers. No filename, document text, extracted requirement, prompt, or user content may enter a queue message.
2. **Supabase Storage and Postgres in `ap-southeast-1`** remain the canonical private file and job-state stores. Supabase Realtime may signal that a job row changed, but the browser must refetch authorized state and must be able to fall back to polling.
3. **Local Node parsers** handle text-bearing PDF, DOCX, and UTF-8 text. Images and scanned or text-poor PDFs route to **Google Cloud Document AI Enterprise Document OCR v2.1** in `asia-southeast1`.
4. **Amazon GuardDuty Malware Protection for S3** in `ap-southeast-1` scans a disposable encrypted copy before parsing. The copy is deleted immediately after a terminal scan result and has a one-day lifecycle failsafe. GuardDuty data-use opt-out is mandatory before the first student document is scanned.
5. Requirement extraction may call only the Phase 2 metered provider gateway. Every call requires a durable credit reservation, provider request trace, usage/cost event, prompt version, input/output schema version, and validation result.

The privacy tradeoffs are acceptable because canonical content stays in Singapore, queue payloads are content-free, Google synchronous OCR does not persist the document to disk, and the AWS scanning environment is isolated in the same region and deletes its temporary scan copy. Aido must expose the external processors in its privacy notice before any public pilot.

## Vercel Queues

### Verified terms

- Queues is a managed beta service available on all plans, with at-least-once delivery. Consumers must therefore be idempotent.
- Accepted messages are synchronously written to three availability zones. During a regional outage, Vercel may temporarily store regional queue data in a neighboring region and relocate it after recovery.
- Message retention is configurable from 60 seconds through 7 days; the default is 24 hours. Visibility timeout is 0 through 3,600 seconds. Maximum message size is 100 MB.
- Messages are charged in 4 KiB operation units. An idempotent send is billed at two units. In Singapore the documented on-demand rate is **USD 0.8544 per 1,000,000 operations**; Singapore managed-infrastructure pricing is documented for Pro-plan projects.
- The `@vercel/queue` package is MIT licensed.
- Vercel's DPA permits processing to provide the service, uses subprocessors, and allows international processing. It prohibits customers from placing sensitive/special-category data in Customer Data. This reinforces the IDs-only message contract.

### Aido configuration

- Region: `sin1`, set explicitly rather than relying on the SDK's fallback region.
- Topic: one versioned ingestion topic; one push consumer group for the current worker contract.
- Retention: 24 hours. Database state, not the queue, is the durable source of truth.
- Message body: schema version, job ID, document-version ID, attempt ID, and random correlation ID only.
- Send idempotency key: immutable ingestion job ID plus attempt generation.
- A message is acknowledged only after the database checkpoint is committed.
- A delivery after a crash leases the same durable job; it never increments usage, reserves credits, or creates derived rows twice.
- After bounded retries, the database job enters a visible failed state and the event is retained for operator review. Queue expiration must never be presented as success.

Official sources:

- [Queues overview](https://vercel.com/docs/queues)
- [Queues concepts and residency](https://vercel.com/docs/queues/concepts)
- [Queues pricing and limits](https://vercel.com/docs/queues/pricing)
- [Singapore regional pricing](https://vercel.com/docs/pricing/regional-pricing/sin1)
- [Vercel DPA](https://vercel.com/legal/dpa)
- [`@vercel/queue` package](https://www.npmjs.com/package/@vercel/queue)

## Supabase Storage and Realtime

### Verified terms

- Staging project `vokjkogzvtohdinhxhkk` is in Singapore (`ap-southeast-1`). The existing `aido-assignment-files` bucket is private, RLS-controlled, and capped at 25 MiB.
- Supabase Free projects allow at most 50 MB per file. The current Aido bucket limit is intentionally lower.
- Free Storage includes 1 GB. Paid overage is documented as USD 0.0213 per GB-month after the plan quota.
- Free Realtime limits include 200 concurrent connections, 100 messages/second, 100 joins/second, 100 channels/connection, 256 KB Broadcast payloads, 1 MB Postgres-change payloads, and 72-hour Broadcast replay.
- Supabase's current DPA says region-directed data is stored and primarily processed in that region, subject to law, customer instructions, and services requested. It requires deletion after the contractual retention period and binds subprocessors to protective terms.

### Aido configuration

- Canonical file bytes remain in the existing private bucket; derived text and anchors remain in RLS-protected Postgres tables.
- Service-only workers receive narrowly scoped object paths after a database lease is acquired. Browser clients never receive a service-role credential.
- Realtime sends row-change notification metadata only. Raw document text and extracted chunks are never Broadcast payloads.
- Polling remains available because Realtime is an experience enhancement, not the processing authority.
- Job events are append-only and content-minimal. Operational logs contain IDs, stages, durations, byte/page counts, error codes, and cost references, never document content.

Official sources:

- [Private Storage buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- [Storage upload limits](https://supabase.com/docs/guides/storage/uploads/file-limits)
- [Storage pricing](https://supabase.com/docs/guides/storage/pricing)
- [Realtime limits](https://supabase.com/docs/guides/realtime/limits)
- [Supabase pricing](https://supabase.com/pricing)
- [Supabase DPA dated 2026-06-01](https://supabase.com/downloads/docs/Supabase%2BDPA%2B260601.pdf)

## OCR: Google Cloud Document AI

### Selected service

Use Enterprise Document OCR processor version `pretrained-ocr-v2.1-2024-08-07`, the stable GA version available in `asia-southeast1`. Do not silently move to the release-candidate model or a US/EU multi-region processor.

### Verified terms and cost

- Enterprise Document OCR costs **USD 1.50 per 1,000 pages** for the first 5,000,000 pages/month, or **USD 0.0015 per page**. Failed `4xx` and `5xx` requests are not billed.
- Online requests allow 40 MB and 15 pages. Enterprise OCR batch requests allow 1 GB and 500 pages. Single-region online processing has a documented default quota of 6 requests/minute per project and processor type.
- `asia-southeast1` is Singapore and supports Enterprise Document OCR v2.1.
- Online document bytes are processed in memory, encrypted in transit, and are not persisted to disk. Batch input may remain in encrypted temporary storage with a one-day failsafe TTL.
- Google states that customer documents and predictions are private customer data, are not used to train Document AI models, and are not shared except as needed to provide the service.
- Enterprise OCR provides page, block, paragraph, line, token, language, and optional image-quality outputs. Low image-quality results must remain visible uncertainty, not be converted to confident text.

### Aido configuration

- Use online processing only for Phase 3. A scanned PDF longer than 15 pages is split locally into immutable segments of at most 15 pages, processed sequentially under the regional quota, and remapped to original 1-based page numbers.
- Checkpoint after each segment. A later retry reuses completed segments by input hash, processor/version, and options hash.
- Maximum Aido PDF length is 200 pages. Larger files fail honestly before a provider call with instructions to split the document.
- OCR is invoked only when local extraction shows no usable text or the user uploaded an image. Digital PDFs and DOCX files do not incur OCR cost by default.
- Store exact provider processor/version, regional endpoint, billed page count, response checksum, page mapping, and quality signals. Do not store provider credentials or raw response bodies in logs.
- OCR output is evidence for parsing, not truth. Illegible/low-confidence text is anchored and marked for student review.

Official sources:

- [Document AI pricing](https://cloud.google.com/document-ai/pricing)
- [Document AI limits](https://docs.cloud.google.com/document-ai/limits)
- [Document AI quotas](https://docs.cloud.google.com/document-ai/quotas)
- [Regional support](https://docs.cloud.google.com/document-ai/docs/regions)
- [Enterprise Document OCR](https://docs.cloud.google.com/document-ai/docs/enterprise-document-ocr)
- [Document AI security and retention](https://docs.cloud.google.com/document-ai/docs/security)

## Malware scanning: GuardDuty Malware Protection for S3

### Selected service

Use a dedicated, non-public S3 quarantine bucket in `ap-southeast-1` with GuardDuty Malware Protection enabled only for the Aido staging prefix. The bucket is a scanning transport, not a second canonical document store.

### Verified terms and cost

- GuardDuty is a fully managed file scanner for new S3 objects. It scans in an isolated VPC with no internet access in the same AWS region, encrypts its temporary copy with AWS KMS, deletes that copy after scanning, and cleans the environment between scans.
- Terminal results are `NO_THREATS_FOUND`, `THREATS_FOUND`, `UNSUPPORTED`, `ACCESS_DENIED`, and `FAILED`. Only `NO_THREATS_FOUND` permits parsing. Every other result blocks processing and remains visible.
- At-least-once result delivery can duplicate notifications; AWS bills an object scan once. Aido therefore keys scan evidence by bucket, object key, version/ETag, and content hash.
- GuardDuty attempts objects up to 100 GB, up to 100,000 extracted files, and up to 100 nested levels. Aido's 25 MiB and decompression guardrails are much stricter.
- The service includes 1,000 requests and 1 GB scanned per month. AWS documents the US East reference rate after that as **USD 0.09/GB plus USD 0.215 per 1,000 objects**; actual `ap-southeast-1` regional charges and S3 request/storage charges must be captured from the staging AWS bill before Phase 3 exits.
- AWS currently says GuardDuty does not collect detected malware for service improvement, but may do so in the future. AWS provides an Organizations opt-out policy. Aido requires that opt-out before any student document is sent.

### Aido configuration

- Upload the exact verified bytes under a random non-identifying key. Do not place the original filename, user ID, project title, or email in the object key or metadata.
- Use SSE-KMS or SSE-S3 at rest, block all public access, least-privilege upload/tag/read/delete access, no access logging that captures filenames, and a one-day deletion lifecycle.
- Poll the managed `GuardDutyMalwareScanStatus` tag with bounded delay or receive a signed EventBridge callback. The database remains authoritative and validates the object identity before accepting a result.
- Delete the quarantine object immediately after persisting a terminal result. Deletion failure becomes a critical cleanup event and is retried; it is never hidden.
- Password-protected, unsupported, access-denied, failed, or timed-out scans fail closed. There is no bypass for a student or browser request.
- VirusTotal public API is explicitly rejected: it is non-commercial, rate-limited, and submitted files may be shared with premium customers and the security community.

Official sources:

- [How GuardDuty Malware Protection for S3 works](https://docs.aws.amazon.com/guardduty/latest/ug/how-malware-protection-for-s3-gdu-works.html)
- [Scan statuses](https://docs.aws.amazon.com/guardduty/latest/ug/monitoring-malware-protection-s3-scans-gdu.html)
- [GuardDuty S3 quotas](https://docs.aws.amazon.com/guardduty/latest/ug/malware-protection-s3-quotas-guardduty.html)
- [GuardDuty pricing](https://aws.amazon.com/guardduty/pricing/)
- [GuardDuty data-use opt-out](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty-opting-out-using-data.html)
- [VirusTotal public API restrictions](https://docs.virustotal.com/docs/api-overview)
- [VirusTotal submission sharing](https://docs.virustotal.com/docs/how-it-works)

## Parser and dependency licensing

The implementation may use these permissively licensed packages, pinned through `pnpm-lock.yaml` and recorded in third-party notices:

| Component | Purpose | License |
|---|---|---|
| `pdfjs-dist` | Read PDF pages, text items, and coordinates | Apache-2.0 |
| `pdf-lib` | Split scanned PDFs into bounded online-OCR segments | MIT |
| `mammoth` | Extract DOCX structure and text | BSD-2-Clause |
| `file-type` | Best-effort binary signature detection | MIT |
| `@vercel/queue` | Queue send/consumer SDK | MIT |
| Google Document AI Node client | Regional OCR API client | Apache-2.0 |
| AWS SDK for JavaScript v3 | S3/tag/delete integration | Apache-2.0 |

`file-type` is only a hint and cannot establish safety. The pipeline must combine declared MIME, extension, magic bytes, structural parse, decompression limits, hash verification, and managed malware scan. Legacy binary `.doc` is not a Phase 3 supported input even though the Phase 1 bucket currently allows its MIME type; the Phase 3 migration and server validation must remove/reject it.

Package sources:

- [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist)
- [`pdf-lib`](https://www.npmjs.com/package/pdf-lib)
- [`mammoth`](https://www.npmjs.com/package/mammoth)
- [`file-type`](https://www.npmjs.com/package/file-type)

## Product limits and failure policy

These are Aido limits, intentionally lower than vendor maximums:

| Input | Aido limit | Anchor rule |
|---|---:|---|
| PDF | 25 MiB and 200 pages | Original 1-based page plus text/geometry offsets |
| DOCX | 25 MiB; 100 MiB total expanded content; 10,000 ZIP entries | Heading path plus stable paragraph/block ordinal |
| PNG/JPEG | 25 MiB and 40 megapixels | Image page 1 plus OCR polygon/text offsets |
| UTF-8 text | 5 MiB | 1-based line and character offsets |

All files additionally require:

- SHA-256 calculated from downloaded bytes and matched to the immutable document version;
- exact extension/MIME/magic/structure agreement;
- no encrypted or password-protected containers;
- no nested archive extraction outside the bounded parser path;
- a terminal `NO_THREATS_FOUND` scan before parsing;
- timeouts and memory/expanded-size limits;
- no raw content in application, queue, provider, or error logs.

Malformed, suspicious, over-limit, malware-positive, unsupported, or uncertain documents receive a durable failed or review-required state with a stable error code. They never receive extracted placeholder requirements, synthetic anchors, or a success state.

## External staging prerequisites

These are deferred provisioning gates, not secrets to paste into chat:

1. Confirm the linked Vercel staging project is on a plan that permits `sin1` Queues, then enable Queues for the project.
2. Create a billed Google Cloud staging project, enable Document AI, and create a stable Enterprise OCR v2.1 processor in `asia-southeast1`. Grant only processor invocation permissions to the staging identity.
3. Create a dedicated AWS staging quarantine bucket in `ap-southeast-1`, enable GuardDuty Malware Protection with managed result tags, set the one-day lifecycle rule, block public access, enable encryption, and apply the GuardDuty service-improvement opt-out policy.
4. Put only the resulting identifiers and credentials in `.env.staging.local` and the corresponding encrypted Vercel staging environment. Never commit, print, or paste them in chat.

Implementation can proceed through schema, RLS, adapters, and fail-closed contract tests before these prerequisites exist. Real OCR and malware evidence—and therefore the Phase 3 exit gate—cannot pass until the owner provisions them.

## Gate conclusion

Gate 3.0 is complete because the current terms, privacy behavior, regional constraints, limits, licensing, and unit costs have been reviewed and bounded. The owner has already authorized implementation of the full plan. This conclusion authorizes isolated-staging implementation only; it does not authorize paid provisioning, production data, public launch, or production promotion.
