# Exploration breadth

`domain-breadth-v1` keeps the configured deep/revisit/discover ratios. Domain
coverage is a separate concern: changing paths or software tools alone does not
mean entering a new domain.

- Accepted `topic` members may declare `interest_role: content | method`.
  Method records remain available as evidence, context and decision constraints,
  but cannot become content interests or exploration evidence. Conservative
  legacy rules exclude operation records without deleting or rewriting them.
- Catalog `domain` is an optional shared label, maintained through the existing
  sourced/versioned catalog API. Legacy name/definition hints are explicitly
  marked as inferred; unknown collections share one bucket. These hints are a
  fallback, not verified semantic classifications. Fish should correct them
  against actual material. Do not create one domain per tool/collection.
- `feed` and `watch` share the maximum decayed collection fatigue. Separately,
  only host-confirmed full reading adds a decaying domain penalty to interest
  scores. A shortlist, search, failed page or preview adds no reading penalty.
  A completed reading therefore also lowers sibling collections in the same
  domain. No new scheduled model invocation is introduced.
- Interest terms first cover distinct domains, then fill remaining slots by score.
  Legacy explanations use their collection label rather than action-like trigger
  sentences; sourced member keywords still take priority.
- Deep ranks active questions by underread domain and oldest actual question
  reading, not latest edit. If every active question is software, deep stays
  software rather than inventing a question or faking broad coverage.
- Revisit uses content groups when available, keeping expression-only and
  principle-only groups out of the content pool (belief-only cold starts retain
  their existing testable-question fallback). It ranks underread domains before source scarcity/neglect; identical
  evidence still shares one slot. Discovery carries an underread target domain,
  recent-domain counts and a cross-domain query instruction into the normal
  compact search packet. Relevance requirements stay unchanged.

The archived interest packet includes excluded member IDs/reasons, reading
penalties and keyword/domain provenance. Exploration decisions retain coverage
and planned domain; actual read receipts retain domain attribution. Discovery's
planned domain is not claimed as actual coverage: sourced member placement can
supply its actual domain later. Failed progress is excluded from coverage.

## Acceptance boundary

Isolation checks cover operation exclusion, watch/feed fatigue, reading-only
penalties, within-domain propagation, question rotation, revisit and discovery
prompt delivery, catalog overrides, replay/idempotence and existing reading
receipts. A read-only production snapshot is used only to compare rankings.

Deployment is not autonomous acceptance. Wait for the existing scheduler, do not
change its time/seed/ratios or send a special prompt. Verify scheduler request,
archived interest and search packets, real choices, delivered complete body,
exposure, progress and Mem readback. If it stops early or remains narrow, retain
that as a failed/pending acceptance item; a specially resumed run cannot satisfy
this check.

## Reading-domain budget

The November 3 ordinary cycle demonstrated the remaining gap: all three query
rounds were tied to software questions. Diverse interest keywords were advisory;
weighted path sampling allowed deep three times, and one slate could spend the
whole nightly reading allowance. Keyword diversity alone is not acceptance.

`reading-domain-budget-v1` now applies at path, query, candidate and slate stages:

- Keep the original path draw, seed and ratio values in the receipt. After two
  consecutive actual readings in one known domain, prefer an available,
  positive-ratio route targeting a different, no-more-read domain. The effective
  route and reason are recorded alongside the original draw. A zero-ratio path
  cannot be revived by this rule. If no alternative is available, record the
  limitation rather than inventing material or silently changing configuration.
- A single target can preselect at most two readings by default; with one slot
  left in a domain streak it can select only one. Then the ordinary state machine
  replans within the existing total reading allowance and three-round limit.
  Failed pages spend no actual-reading allowance. The limit is an upper bound,
  not a requirement to read irrelevant material.
- The compact ordinary search packet and required arguments carry the required
  domain. `feed_search_plan.domain` must match it; the model still chooses useful
  queries and explains why. Candidate judgments use `exploration.domain`, based
  on their actual title/summary. Unknown or other-domain candidates cannot enter
  the constrained slate even with high relevance, stance or popularity scores.
  This gate applies to both Bilibili and web selections.
- Candidate domain is a model judgment from metadata, explicitly recorded as
  such, not proof of body reading or a verified fact. Full original body,
  delivery, progress, sourced concept maintenance and Mem readback remain
  separate requirements. A public preview cannot bypass a required target domain.

Optional `exploration_configure.breadth` fields are `enabled` (default true),
`max_consecutive_domain_reads` (default 2), and `max_readings_per_target` (default
2). Existing config calls preserve these settings; unconfigured stores use the
same defaults without rewriting their ratios/history or old records.

Isolation regression uses the real failure's concentration shape and unchanged
seeds, both candidate gates, native host body/delivery receipts and a five-reading
cycle. Production acceptance must still wait for the existing scheduler. Do not
change its seed/time or send a special prompt or continuation to obtain a pass.
