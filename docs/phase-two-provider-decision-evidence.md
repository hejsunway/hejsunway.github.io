# Phase 2 provider decision evidence

> Reviewed: 2026-07-20
> Status: v13 fail-closed atomic/truncation contract passes offline; no v13 provider request; route remains unapproved
> Scope: OpenAI Responses API, completed `gpt-5.4-mini-2026-03-17` and `gpt-5.6-luna` staging comparisons

This note records the owner's staging decisions without asserting that the
model has passed Aido's quality gate. The route must remain unapplied until a
developer-owned real brief/rubric passes the versioned extraction evaluation.
Current pricing and product claims must be rechecked when the configuration is
approved.

## Current first-party evidence

- OpenAI identifies `gpt-5.6-luna` as its cost-sensitive, high-volume GPT-5.6
  tier. The current model page lists USD 1.00 input, USD 0.10 cached input,
  and USD 6.00 output per one million tokens. Cache writes cost 1.25 times
  uncached input. Source: [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

- OpenAI's current model page identifies `gpt-5.4-mini-2026-03-17` as the
  current snapshot, with Responses API and Structured Outputs support. The
  standard pricing page lists USD 0.75 input, USD 0.075 cached input, and USD
  4.50 output per one million tokens. No separate cache-write price is listed
  for this model. Sources: [API pricing](https://developers.openai.com/api/docs/pricing),
  [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini).
- OpenAI states that API data is not used to train its models without explicit
  consent. Responses are stored for 30 days by default; `store: false` disables
  response-object storage, subject to the separate abuse-monitoring rules.
  Default abuse-monitoring logs can contain prompts and responses and are kept
  for up to 30 days unless a longer period is required for the documented legal
  or safety reasons. Zero Data Retention and Modified Abuse Monitoring require
  approval. Source: [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data).
- Singapore supports regional storage for the Responses API but not regional
  processing. The current table says Singapore regional storage requires
  Modified Abuse Monitoring or Zero Data Retention. Source:
  [OpenAI regional support](https://developers.openai.com/api/docs/guides/your-data#support-by-region).

## Approved staging policy

- Controlled comparison target: `gpt-5.6-luna` through the Responses API,
  with `reasoning.effort: none` to preserve the old mini route's effective
  baseline. The prior `gpt-5.4-mini-2026-03-17` route remains a manual
  technical fallback only; it is not quality-approved.
- Developer-owned staging documents only; no customer or copied production
  documents.
- Send `store: false`. The owner accepts that default abuse-monitoring logs may
  still retain prompts/responses for up to 30 days.
- Do not claim Singapore processing or storage. Singapore regional storage
  requires approved MAM/ZDR controls and does not provide regional processing.
- Maximum 30 pages, 40,000 input tokens, and 4,000 output tokens.
- No tools, web search, file search, or provider-side file storage.
- Timeout 120 seconds, at most one retry, one concurrent job per user, and a
  2,000-credit daily user cap.
- Global staging OpenAI budget: USD 10.00 per day.
- Budget exchange rate MYR 5.00/USD, provider-cost target 20%, quote safety
  multiplier 35%, payment-risk reserve 5%, and net revenue floor RM0.008 per
  credit.

At the hard token limits, the current standard provider price is USD 0.048
before the 35% quote buffer and USD 0.0648 after it. A 250-credit minimum quote
has a RM2.00 internal net-revenue basis and an USD 0.08 provider-cost ceiling at
the approved exchange rate, so the buffered maximum remains inside the 20%
target. The intended reservation remains below the approved 400-credit per-job
maximum.

## Unresolved exit evidence

1. **Quality:** provider marketing and feature support are not Aido quality
   evidence. The selected snapshot must pass a versioned extraction evaluation
   on developer-owned real briefs/rubrics, including source-anchor accuracy,
   invalid-output behavior, and the PRD's critical-requirement thresholds.
2. **Credential and call evidence:** an OpenAI project key must be configured in
   the staging server environment, then one real response must record token
   usage, latency, request ID, actual cost, validation, reservation, and
   settlement lineage.
3. **Invoice/export evidence:** the corresponding real OpenAI usage or billing
   export must be imported by hash and reconciled with the recorded response.

Until the quality evaluation passes, no OpenAI route should have `approved:
true` in the applied staging billing configuration.

## Staging quality evaluation result

The developer-owned staging brief/rubric pair was evaluated on 2026-07-20 with
`store: false`, no tools or search, the fixed model snapshot, and the approved
token/time limits. Raw documents and extracted private content were not written
to Git or application logs.

The gate did **not** pass:

- A completed response (`resp_00c39d5d22c7a212016a5dc95324bc819b883caef39d244510`)
  returned 20 requirement rows and 27 anchors. Local PDF validation proved both
  source PDFs contain one page, while seven returned anchors claimed page 2;
  one additional excerpt was not present on its cited page. The response used
  2,699 input tokens (2,304 cached), 2,831 output tokens, took 22,249 ms, and
  had an estimated provider cost of 13,209 microusd.
- A subsequent source-ID/page-constrained corrective request returned HTTP 200
  but did not reach `completed` within the fixed 4,000-output-token limit. It is
  therefore also a failed evaluation, not successful evidence.
- The final compact source-ID evaluation completed as
  `resp_0b90a83660fd75d4016a5dcde1fef481988e32f88ee60d5cd9` with 15
  requirement rows and 18 anchors. Every source ID and page number bound to a
  real uploaded file/page, but four purported evidence excerpts were not
  present on the cited PDF page even after conservative PDF punctuation,
  line-break hyphenation, and explicit-ellipsis normalization. The response
  used 2,720 input tokens, 1,833 output tokens, took 12,724 ms, and had an
  estimated provider cost of 10,289 microusd. Invented or paraphrased evidence
  cannot pass Aido's anchor gate.
- An earlier validator-development request is retained only as failed staging
  evidence. It cannot be used to approve the route because its source labels
  were not canonical and its page/excerpt anchors were not fully verified.

The operator evaluator now supports offline revalidation of a saved private
report so validator changes do not trigger another provider call. No further
quality requests should be made on this model/prompt combination without a new
reviewed evaluation approach.
The OpenAI route remains `approved: false`; human checklist scoring and the PRD
recall/anchor thresholds remain pending.

### Approved anchored-text retry

After explicit owner approval, the evaluator changed to deterministic local
anchoring. `pdftotext` extracted the two hash-verified PDFs, split them into 16
immutable blocks, and sent 2,548 characters of block-labelled text. The model
could return only schema-enumerated block IDs; application code then attached
the canonical document ID, filename, page, exact excerpt, and text hash. Raw
document text remains only in the private outside-repository report and review
package.

Response `resp_0323cbff88239b93016a5dd12a6bec8198bfa0169d10014900`
completed with:

- prompt `phase2-requirement-extraction-v4-anchored-blocks`;
- schema `aido.requirement-extraction.v4`;
- `store: false`, no tools, and no search;
- 1,486 input tokens and 1,158 output tokens;
- 8,410 ms latency and estimated provider cost of 6,326 microusd;
- 10 requirement rows, one ambiguity, and 16 total materialized anchors;
- zero schema, missing-anchor, source, page, excerpt, or materialization errors.

Automatic grounding therefore passes. It does not establish semantic recall or
prove that each chosen block supports the model's interpretation.

### Human semantic review result

The private side-by-side review completed on 2026-07-20 and **failed** the
quality gate:

- critical-requirement recall: 37.5% (minimum 95%);
- anchor accuracy: 90% (minimum 95%);
- nine critical requirements were missing;
- three returned rows were only partly correct; and
- required coverage was incomplete.

The anchored input contained four explicit learning outcomes that the model
omitted. More importantly, the visible rubric contains four criteria and their
performance descriptors, but the local `pdftotext` stage did not preserve the
table, so those requirements never reached the provider. The review also found
an instruction outcome missing, two rows that misuse the rubric-weight field
for overall assessment weight, one contextual fact presented as a requirement,
and one displayed evidence excerpt that truncates before its supporting text.

The decisions-only review file is stored outside the repository with the
private evaluation package. The provider route and all related controls remain
disabled. Before another paid evaluation, the parser must preserve rubric
tables and the evaluator must re-run with a complete anchored source set.

### Offline table-preserving corrective preparation

The evaluator now prepares a new, not-yet-executed
`phase2-requirement-extraction-v5-table-aware-anchors` approach. Each PDF page
is checked locally with OCR after layout-preserving text extraction. OCR text is
added only when it contains materially more content than the PDF text layer;
the extraction method is retained in the private anchor registry. This local
OCR check is limited to the developer-owned Phase 2 evaluation and does not
approve or substitute for the separately governed managed OCR service planned
for Phase 3.

A secret-safe dry run detected one OCR supplement page, produced 31 anchored
blocks and 5,130 characters of anchored input, and made no provider request.
The revised prompt explicitly requires all learning outcomes, rubric criteria,
and performance descriptors, separates overall assessment weight from rubric
criterion weights, and rejects contextual facts as standalone requirements.
Full local no-demo, configuration-boundary, provider-adapter, lint, typecheck,
and production-build checks pass.

### Approved v5 table-aware retry result

After explicit owner approval, one v5 request completed as
`resp_0a373bc7041ee23e016a5dd7b737bc819bad4826b6a0df2c59`:

- requested and returned model `gpt-5.4-mini-2026-03-17`;
- `store: false`, no tools, and no search;
- 2,499 input tokens and 2,875 output tokens;
- 35,164 ms latency and estimated provider cost of 14,812 microusd;
- 26 requirement rows, two ambiguities, and 41 materialized anchors; and
- zero automatic schema, source, page, excerpt, or materialization errors.

The subsequent human review **failed**: 66.7% critical-requirement recall and
54.8% anchor accuracy, both below the required 95%. Four critical extraction
items were missing and seven rows were partly correct. V5 recovered the four
learning outcomes and the rubric content, but eight rubric descriptor rows cite
only a row-header fragment rather than the descriptor text in the next OCR
block. The preventive-measures criterion is mislabeled, its excellent
descriptor adds unsupported wording, and the main case-study-versus-reflective-
report conflict was not recorded.

The decisions-only review is stored outside the repository. The provider route
and all controls remain disabled. Do not make another paid request until a
reviewed evaluator revision preserves each rubric row as one complete anchor
and validates that every cited block semantically supports the returned row.

### Offline v6 row-aware corrective preparation

The evaluator now contains a not-yet-executed
`phase2-requirement-extraction-v6-row-aware-anchors` revision with schema
`aido.requirement-extraction.v6`. Local OCR groups each visible rubric criterion
with its descriptors into one `local_ocr_table_row` anchor. Returned rubric
requirements are rejected unless they cite one of those complete row anchors.
The structured result also has a required assignment-metadata section for the
assessment type, overall weight, word count, citation style, file format,
submission destination, and deadline; a non-null metadata value must cite a
real anchor.

A secret-safe staging dry run against the same hash-verified developer-owned
brief/rubric produced 28 source blocks, including four complete rubric-row
anchors, and 5,253 characters of anchored input. The private human checklist is
locked to the staging project, exact document hashes, prompt version, and schema
version; its recorded SHA-256 is
`4510e3048ad3158282b1f7b3bbbf728c62cafe1913440ef56d007938d704ce08`.
The evaluator refuses a paid request without a matching outside-repository
checklist. Its contract self-test proves that a complete row anchor passes and
a header-only rubric anchor fails.

No provider request was made for v6. No raw private document content was added
to Git or logs. The no-demo scan, staging boundary tests, provider adapter
tests, lint, typecheck, production build, and `git diff --check` pass. V6 is
therefore ready for one separately approved controlled staging evaluation; it
is not quality approval. The route and all controls remain disabled until the
saved output passes both automatic validation and the locked human checklist.

### Approved v6 row-aware retry result

After explicit owner approval, one v6 request completed as
`resp_08d9256f180e83d0016a5ddd18fc44819bb9a836e60deb3a5f`:

- requested and returned model `gpt-5.4-mini-2026-03-17`;
- `store: false`, no tools, and no search;
- 4,147 input tokens and 2,704 output tokens;
- 12,946 ms latency and estimated provider cost of 15,279 microusd;
- 25 requirement rows, two ambiguities, and 48 materialized anchors; and
- zero automatic schema, metadata, source, page, excerpt, complete-row, or
  materialization errors.

The locked semantic checklist review **failed**. Critical requirement recall
was 58.8% (10 of 17), below the required 95%. Requirement-anchor accuracy was
96.4% (27 of 28), but the gate also prohibits any partial or invented row.
Six brief/learning-outcome requirements were omitted. The model also missed the
ambiguity created by the visibly truncated preventive-measures descriptor,
completed that truncated descriptor with an unsupported interpretation, and
promoted the Learning Support and assessment-extension notices into assignment
requirements even though they are contextual help information. The main
case-study-versus-reflective-report ambiguity, assignment metadata, citation
rules, integrity signals, and complete rubric-row anchors were correctly
recovered.

The decisions-only review is stored outside the repository with mode `0600`.
The route and all four controls remain disabled. Do not make another paid
quality request until a materially different reviewed evaluation approach can
prove recall without treating contextual notices or incomplete OCR text as
requirements.

### Offline v7 source-coverage corrective preparation

The next evaluator revision is prepared offline as
`phase2-requirement-extraction-v7-source-coverage` with schema
`aido.requirement-extraction.v7`; it has not made a provider request. The local
parser now gives each bulleted learning outcome and numbered instruction its
own immutable anchor. A private dry run confirmed one distinct anchor for each
of the four learning outcomes and each of the three numbered instructions.

V7 also requires a source-coverage receipt for all 27 canonical PDF-text and
complete rubric-row blocks. Every block must be classified exactly once. A
block classified as an assignment or rubric requirement must be cited by an
output requirement; context-only or unusable blocks cannot be cited as
requirements. A block marked as truncated or incomplete must be cited in an
ambiguity, and the prompt explicitly treats learning-support and extension
notices as context rather than assessed work.

The staging dry run produced 35 total anchors, including four complete rubric
rows, and 5,372 characters of anchored input. It is locked to the exact staging
project/document hashes and the private checklist SHA-256
`2d24c7bb748a49de14cb84fab13e06d622e0f9912be55cc57c8145b169cf4b6e`.
Contract tests cover a valid receipt, missing receipt, incomplete text without
an ambiguity, and header-only rubric citation. No-demo, boundary, provider
adapter, lint, typecheck, and production-build checks pass. V7 is ready for
review, but another paid evaluation still requires separate explicit approval.

### Approved v7 source-coverage retry result

After explicit owner approval, one v7 request completed as
`resp_0a048d74f256c690016a5de51a2a0081988661d2798238b148`:

- requested and returned model `gpt-5.4-mini-2026-03-17`;
- `store: false`, no tools, and no search;
- 5,062 input tokens and 3,639 output tokens;
- 18,131 ms latency and estimated provider cost of 20,172 microusd;
- 27 requirements, two ambiguities, and 38 materialized anchors; and
- complete coverage of all 27 required source blocks.

The model repeated four source-coverage classifications identically. The first
automatic pass correctly rejected the duplicates and created no review package.
A deterministic offline canonicalizer was then added: it removes only duplicate
rows with the same anchor, classification, and incomplete-text flag, while
conflicting duplicates remain validation failures. Revalidating the saved
response removed four identical duplicates and passed every automatic check;
no second provider request was made.

The locked semantic review nevertheless **failed narrowly**. Critical-
requirement recall reached 94.1% (16 of 17), just below the required 95%, and
requirement-anchor accuracy reached 96.3% (26 of 27). V7 correctly recovered
all learning outcomes, numbered instructions, metadata, citation rules,
integrity signals, both required ambiguities, and context-only notices. However,
one preventive-measures rubric row completed visibly truncated source text with
the unsupported phrase “promote integrity.” The gate prohibits any invented or
partly supported row, so the route cannot be approved.

The private decisions and both raw/canonical saved reports remain outside the
repository with mode `0600`. The route and all four controls remain disabled.

### v8 GPT-5.6 Luna comparison and result

The owner selected GPT-5.6 Luna after rejecting Sol's materially higher cost.
The evaluator now targets `gpt-5.6-luna`, preserves the exact v7 prompt and
schema, sends `reasoning.effort: none`, uses `store: false`, and enables no
tools or search. This isolates the model change from the already reviewed
parser, prompt, anchors, output contract, and human checklist.

The evaluator records cached reads and GPT-5.6 cache writes separately. Its
cost calculation uses USD 1.00 per million ordinary input tokens, USD 0.10 per
million cached-input tokens, USD 1.25 per million cache-write tokens, and USD
6.00 per million output tokens. The last v7 usage shape would cost about USD
0.0269 on Luna before any cache-write adjustment, compared with USD 0.0202 on
GPT-5.4 mini.

A read-only staging dry run against the same two hash-verified documents and
locked checklist passed: 35 anchors, four complete rubric rows, 27 required
coverage blocks, and 5,372 anchored-text characters. No provider request was
made. The private anchor registry remains outside the repository with mode
`0600`.

After explicit owner approval, exactly one paid v8 request was sent. It
completed as
`resp_06c1e9d4b746d6a9016a5deccb72148199b671a4c4fc14afae` with the requested
and returned model `gpt-5.6-luna`; automatic fallback was disabled and not
used. The response took 14,527 ms and used 5,062 input tokens, 5,059 reported
cache-write input tokens, and 3,492 output tokens. The recorded estimate is
27,279 microusd (about USD 0.0273 or RM0.14 at the approved budget rate).

Automatic schema and anchor validation passed with 24 requirement rows, 34
anchors, two ambiguities, and all 27 required source blocks covered. Human
review against the locked checklist nevertheless failed. Every returned row
was source-supported, giving 100% anchor accuracy, and the prior unsupported
completion of truncated rubric text was removed and represented as an
ambiguity. However, the two source blocks containing all four learning
outcomes were incorrectly classified as context-only, so none of those four
critical outcomes appeared in the requirement set. Critical-requirement
recall was therefore 76.5% (13 of 17), below the required 95%. The private
evaluation and review decisions remain outside the repository with mode
`0600`.

### Post-v8 structural guards and incomplete Luna attempt

The v8 failure exposed a validator gap: source coverage was complete, but the
automatic contract trusted the model's `context_only` classification for two
numbered, student-directed assessed-action blocks. The evaluator now derives a
conservative `candidate_student_action` structural hint from the local source
text. Every such block must produce a requirement or automatic validation
fails. The same staging documents produce exactly two guarded blocks, matching
the two blocks omitted by v8. A regression self-test proves the previous
context-only result can no longer pass.

After explicit owner approval, one post-fix Luna request was sent with
automatic fallback still disabled. OpenAI returned HTTP 200, but the response
did not have `status: completed`, so the evaluator rejected it and did not
create a success report or review package. The older error path did not retain
the provider response ID or incomplete reason; it has now been changed to
surface those non-secret fields on any future failure. No retry and no mini
request occurred.

The next offline contract also guards visibly incomplete source blocks. Any
requirement citing one must use low confidence, require student confirmation,
and be accompanied by an ambiguity; otherwise automatic validation fails.
This catches the unsafe confidence/confirmation state in mini's v7 partial row
without relying on the model to police itself. A fresh private checklist keeps
the same 17 locked requirement expectations and is ready for review, but no
further provider request is authorized by this evidence.

GPT-5.4 mini is retained only as a manual technical fallback. Its v7 semantic
review already failed, so neither a Luna quality failure nor a provider error
may silently convert mini into an approved route. No fallback call occurred;
any future fallback call requires a separate reviewed decision.

For the next controlled comparison, GPT-5.4 mini is the stronger candidate on
the evidence currently available. Mini's v7 result reached 94.1% critical
recall and 96.3% anchor accuracy, while Luna v8 reached 76.5% recall and then
failed to complete the post-fix attempt. Mini's comparable completed request
cost about USD 0.0202 versus Luna's USD 0.0273, although Luna was about 3.6
seconds faster. OpenAI also describes Luna as roughly corresponding to the
older nano tier, while GPT-5.4 mini is its strongest mini model. This is a
recommendation for the next evaluation only, not route approval.

### Guarded GPT-5.4 mini result

After explicit owner approval, exactly one guarded mini request was sent using
the pinned `gpt-5.4-mini-2026-03-17` snapshot, `reasoning.effort: none`,
`store: false`, no tools/search, and no fallback. It completed as
`resp_06fcee220af28018016a5dfcf830d481978b02c9597156e245` in 21,371 ms with
5,421 input and 3,737 output tokens. The recorded estimate is 20,883 microusd
(about USD 0.0209 or RM0.10 at the approved budget rate).

The new safety guards worked: both candidate student-action blocks produced
requirements, and no incomplete-source requirement lacked low confidence or
student confirmation. The response still failed automatic coverage validation.
It returned 28 coverage rows representing only 26 unique anchors against 27
required anchors: `rubric-p1-b005` was absent, while `rubric-p1-b010` and
`rubric-p1-b011` each appeared twice with conflicting assignment-versus-rubric
classifications. Because source coverage must be exact before semantic review,
the evaluator saved the private report with mode `0600` but correctly refused
to create a human-review package. No retry occurred.

This result does not approve mini. It shows that mini remains the more
economical and empirically stronger candidate, while the array-shaped coverage
receipt is still too permissive to guarantee exactly one decision per anchor.
That contract must be made structurally unique before another paid evaluation.

The next contract now implements that fix offline. `source_coverage` is a
strict object whose 27 property names are the 27 known required anchor IDs;
every property is required and additional properties are forbidden. The model
can therefore neither omit an anchor nor return the same anchor twice. Local
application code converts the receipt to the canonical array only after strict
provider-schema validation. The prompt is versioned as
`phase2-requirement-extraction-v10-unique-coverage-receipt`, the schema as
`aido.requirement-extraction.v8`, and the unchanged 17-item private checklist
has a new locked hash. Contract self-tests and a staging dry run pass; no
provider request had been made for this new contract at that point.

### v11 unique-coverage GPT-5.4 mini result

After explicit owner approval, exactly one v11 request was sent using the
pinned `gpt-5.4-mini-2026-03-17` snapshot, `reasoning.effort: none`,
`store: false`, no tools/search, and no fallback. It completed as
`resp_054f11f70b8b18016a5e004d81c08190a0884f0602aca198` in 24,412 ms with
6,926 input and 3,944 output tokens. The recorded estimate is 22,943 microusd
(about USD 0.0229 or RM0.11 at the approved budget rate).

The strict receipt fixed the coverage defect: all 27 required anchors were
returned exactly once, both candidate student-action guards passed, and all
incomplete-source safeguards passed. The first automatic pass found one
shape-only mismatch: a metadata field with a `null` value still carried one
source anchor. A deterministic offline canonicalizer now removes anchors only
from explicitly null metadata fields. Its regression test passes, it removed
one anchor without adding or changing content, and offline revalidation of the
saved response passed every automatic schema, source, page, hash, structural,
and coverage check. No second provider request was made.

The locked semantic review still **failed**. Critical-requirement recall was
88.2% (15 of 17), below the required 95%, while requirement-anchor accuracy
was 96.3% (26 of 27). One student-directed instruction retained the reading
action but omitted its required country-impact purpose. One preventive-
measures rubric row also completed a visibly truncated source fragment with
unsupported wording despite being marked low-confidence and requiring student
confirmation. The gate permits neither a missing critical requirement nor an
invented or partly supported row.

The private raw/revalidated reports, review package, checklist, and decisions
remain outside the repository with mode `0600`. GPT-5.4 mini remains the more
economical completed candidate, but v11 proves it is not good enough under the
current extraction contract. The route and all four controls remain disabled
and unapplied. No further provider request is authorized by this evidence.

### v12 atomic-clause and incomplete-text guards

V11 proved that strict Structured Outputs can enforce the shape and uniqueness
of Aido's receipt, but shape adherence alone cannot prove that a model retained
every source clause or avoided unsupported wording. This matches OpenAI's
guidance to use strict Structured Outputs while still performing application-
side suitability validation. Source:
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs#structured-outputs-vs-json-mode).

The next contract now closes both v11 semantic gaps offline:

- A deterministic parser extracts five atomic action clauses from the two
  numbered student-action blocks. Each clause has a stable ID and source hash.
- The strict `atomic_clause_coverage` object requires exactly one receipt for
  each clause and maps it to a returned `requirement_id`.
- Application validation requires the mapped requirement to cite the same
  source block and contain the exact visible clause text in its requirement,
  verb, deliverable, or constraint fields. A requirement that retains only the
  reading action while dropping either purpose clause now fails automatically.
- Local parsing independently marks the one truncated OCR rubric block. The
  provider must also mark it incomplete, attach an ambiguity, use low
  confidence, and require student confirmation.
- Any requirement citing that incomplete block must be a contiguous verbatim
  span of visible source text. Non-empty verbs, deliverables, and constraints
  must also be visible contiguous spans. Completing the trailing fragment or
  paraphrasing unsupported content now fails automatically.

The prompt is versioned as
`phase2-requirement-extraction-v12-atomic-extractive-guards`, the schema as
`aido.requirement-extraction.v9`, and the unchanged 17-item private checklist
as `phase2-human-checklist-v6-atomic-extractive-guards` with SHA-256
`0986462640fdb4f5a7366a22ec610d9a7e3a5376ec3b6dab91a3ba47b7cf4569`.
Regression tests prove that two omitted purpose clauses and a guessed
truncated-text completion are rejected. An isolated-staging dry run found 35
anchors, 27 required source blocks, five atomic clauses, and one locally
incomplete block. The dry run was ready and made no provider request.

The private checklist and anchor registry remain outside the repository with
mode `0600`. V12 is ready for review, not quality approval. A paid v12 request
still requires a new explicit owner approval; there is no automatic retry or
fallback.

### v13 fail-closed atomic coverage and truncation prohibition

V12 still allowed multiple atomic clauses to point to one returned requirement,
and it allowed a requirement derived from an incomplete block when the visible
fragment was copied verbatim. Those allowances were too permissive for the
failed v11 patterns. V13 now enforces the stronger contract offline:

- Each complete atomic clause has a required receipt containing its exact
  source text and SHA-256. The strict schema fixes both values to the locally
  derived clause.
- Each receipt must map to a different requirement ID. The mapped requirement
  must contain exactly that one complete clause, cite only its source block,
  and use no command verb, deliverable, or constraint outside the visible
  clause. Merging two clauses or dropping a purpose clause fails validation.
- Locally incomplete blocks produce no atomic clauses. They must be classified
  `unusable_or_incomplete` and cannot anchor requirements, assignment metadata,
  citation rules, or integrity-policy signals.
- Each incomplete block may appear only in one neutral ambiguity using fixed
  text that says no requirement was extracted and asks for the complete source.
  A model-generated guess about the missing ending fails validation.

The prompt is versioned as
`phase2-requirement-extraction-v13-atomic-no-truncated-completion`, the schema
as `aido.requirement-extraction.v10`, and the anchoring contract as
`pdftotext-structural-lists-row-aware-ocr-atomic-clauses-v7`. Regression tests
pass for exact receipts, one-clause/one-requirement mapping, merged-clause
rejection, missing-clause rejection, truncated semantic-output rejection, and
neutral ambiguity enforcement. The isolated-staging dry run again found 35
anchors, 27 required source blocks, five complete atomic clauses, and one
locally incomplete block. It made no provider request.

The v13 private anchor registry is stored outside the repository with mode
`0600`. Because the prompt and schema versions changed, the human checklist
must be reviewed and version-bound to v13 before any paid evaluation. V13 is
offline contract evidence only; it is not provider quality approval and does
not authorize an automatic retry or fallback.

The evaluator now fails closed unless the private checklist also contains an
explicit `provider_request_approval` section for the exact staging project,
model, prompt version, schema version, anchoring version, and reviewed document
hashes. A matching checklist file by itself is no longer enough to permit a
provider request; the reviewer must mark that exact scope approved first.

At Luna's ordinary hard-limit prices, 40,000 input plus 4,000 output tokens
costs USD 0.064, just under the current USD 0.0648 route ceiling. GPT-5.6 cache
writes can raise that exposure to USD 0.074. The Phase 2 billing schema does
not yet have a distinct cache-write price/token field, so the Luna route must
remain unapproved until this accounting gap is closed or cache writes are
provably excluded. The configuration and all model controls remain disabled
and unapplied.
