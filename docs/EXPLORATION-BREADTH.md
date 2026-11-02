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
