# Phase 2 provider decision evidence

> Reviewed: 2026-07-20
> Status: pricing/privacy/limits approved; quality evaluation and API evidence pending
> Scope: OpenAI Responses API, `gpt-5.4-mini-2026-03-17`

This note records the owner's staging decisions without asserting that the
model has passed Aido's quality gate. The route must remain unapplied until a
developer-owned real brief/rubric passes the versioned extraction evaluation.
Current pricing and product claims must be rechecked when the configuration is
approved.

## Current first-party evidence

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

- Model snapshot: `gpt-5.4-mini-2026-03-17` through the Responses API.
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
