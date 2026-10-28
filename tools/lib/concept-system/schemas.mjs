import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (v) => !["__proto__", "constructor", "prototype"].includes(v),
    "Reserved identifier",
  );
const text = z.string().trim().min(1).max(12000);
const unit = z.number().finite().min(0).max(1);
const key = z.string().min(1).max(200);
const links = { trace_id: id.optional() };
const source = z
  .object({
    id,
    actor: z.enum(["user", "fish", "third_party"]),
    type: z.enum(["conversation", "video", "feedback", "manual"]),
    excerpt: text,
    ref: z.string().max(2000).optional(),
    occurred_at: z.string().datetime().optional(),
    video: z.object({
      bvid:z.string().regex(/^BV[0-9A-Za-z]{10}$/),
      cid:z.string().regex(/^\d+$/),
      section:z.enum(['subtitles','description']),
      part:z.number().int().min(1).max(24),
      parts:z.number().int().min(1).max(24),
      content_hash:z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().optional(),
  })
  .strict();
export const schemas = {
  concept_propose: z
    .object({
      key,
      ...links,
      source,
      subject: z.enum(["user", "fish"]),
      content: text,
      tags: z
        .array(
          z.enum([
            "topic",
            "belief",
            "motive",
            "word",
            "phrase",
            "idiom",
            "sentence_pattern",
          ]),
        )
        .min(1)
        .max(7),
      scene: id.default("general"),
      triggers: z.array(z.string().max(300)).max(20).default([]),
      exclusions: z.array(z.string().max(300)).max(20).default([]),
      interpretation: z
        .enum(["explicit", "mention", "negated", "quoted", "uncertain"])
        .default("mention"),
    })
    .strict(),
  concept_review: z
    .object({
      key,
      ...links,
      candidate_id: id,
      status: z.enum(["accepted", "deferred", "rejected"]),
      reason: text,
      collections: z
        .array(
          z
            .object({
              name: z.string().trim().min(1).max(100),
              related: z.array(id).max(20).default([]),
            })
            .strict(),
        )
        .max(10)
        .default([]),
    })
    .strict(),
  concept_query: z
    .object({
      subject: z.enum(["user", "fish"]).optional(),
      scene: id.optional(),
      tag: z.string().max(100).optional(),
      query: z.string().max(300).optional(),
      status: z
        .enum(["pending", "accepted", "deferred", "rejected"])
        .optional(),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  decision_preview: z
    .object({
      ...links,
      question: text,
      scene: id,
      subject: z.enum(["user", "fish"]).default("fish"),
      parent_decision_id: id.optional(),
      seed: z.string().min(1).max(200),
      options: z
        .array(
          z
            .object({
              label: z.string().trim().min(1).max(200),
              eligible: z.boolean().default(true),
              reason: text,
              contributions: z
                .array(
                  z
                    .object({
                      collection_id: id,
                      member_id: id,
                      relevance: unit,
                      strength: z.number().finite().min(-1).max(1),
                      reason: text,
                    })
                    .strict(),
                )
                .max(50),
            })
            .strict(),
        )
        .min(2)
        .max(20),
    })
    .strict(),
  decision_commit: z
    .object({
      key,
      preview_id: id,
      selected: z.string().min(1).max(200).optional(),
      reason: text,
    })
    .strict(),
  decision_feedback: z
    .object({
      key,
      ...links,
      decision_id: id,
      actor: z.enum(["user", "fish"]),
      source_id: id.optional(),
      outcome: z.enum(["positive", "negative", "unknown"]),
      reason: text,
    })
    .strict(),
  personal_render: z
    .object({
      subject: z.enum(["user", "fish"]).default("fish"),
      scene: id.default("general"),
      budget: z.number().int().min(100).max(2000).default(400),
    })
    .strict(),
  trace_get: z
    .object({
      trace_id: id.optional(),
      decision_id: id.optional(),
      session_id: id.optional(),
      type: z.string().max(100).optional(),
      after: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  version_list: z.object({ role: id }).strict(),
  version_diff: z.object({ role: id, from: id, to: id }).strict(),
  observation_response: z
    .object({
      trace_id: id,
      session_id: id,
      turn_id: id.optional(),
      response_id: id.optional(),
      text: z.string().max(500000),
      reasoning: z.string().max(500000).optional(),
      reasoning_kind: z
        .enum(["provider_reasoning", "host_summary", "unavailable"])
        .default("unavailable"),
      partial: z.boolean().default(false),
      source: z.string().max(200).default("explicit_import"),
    })
    .strict(),
  observation_capture: z.object({}).strict(),
  observation_object: z
    .object({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict(),
  decision_replay: z.object({ preview_id: id }).strict(),
};
