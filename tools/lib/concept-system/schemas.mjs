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
    video: z
      .object({
        bvid: z.string().regex(/^BV[0-9A-Za-z]{10}$/),
        cid: z.string().regex(/^\d+$/),
        section: z.enum(["subtitles", "audio_transcript", "description"]),
        part: z.number().int().min(1).max(24),
        parts: z.number().int().min(1).max(24),
        content_hash: z.string().regex(/^[a-f0-9]{64}$/),
        transcription:z.object({engine:z.literal('whisper.cpp'),model:z.string().min(1).max(200),model_hash:z.string().regex(/^[a-f0-9]{64}$/),audio_hash:z.string().regex(/^[a-f0-9]{64}$/),chunk_seconds:z.number().positive()}).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const explorationRatios = z
  .object({
    deep: unit,
    revisit: unit,
    discover: unit,
  })
  .strict()
  .refine(
    (v) => Math.abs(v.deep + v.revisit + v.discover - 1) < 1e-9,
    "Exploration ratios must sum to 1",
  );
const subject = z.enum(["user", "fish"]);
const explorationPath = z.enum(["deep", "revisit", "discover"]);
const target = z
  .object({
    collection_id: id.optional(),
    question_id: id.optional(),
    candidate_id: id.optional(),
  })
  .strict();
export const collectionMetadata = {
  definition:z.string().trim().min(1).max(600),
  boundary:z.string().trim().min(1).max(600),
  aliases:z.array(z.string().trim().min(1).max(100)).max(12).default([]),
  related:z.array(id).max(20).default([]),
};
export const collectionPlacement = z.union([
  z.object({collection_id:id,reason:z.string().trim().min(1).max(1000)}).strict(),
  z.object({name:z.string().trim().min(1).max(100),...collectionMetadata,reason:z.string().trim().min(1).max(1000)}).strict(),
]);
export const schemas = {
  persona_revision_retry:z.object({attempt_id:id,expected_hash:z.string().regex(/^[a-f0-9]{64}$/),reason:text}).strict(),
  persona_revision_history:z.object({limit:z.number().int().min(1).max(100).default(20)}).strict(),
  persona_revision_rollback:z.object({revision_id:id,expected_hash:z.string().regex(/^[a-f0-9]{64}$/),reason:text}).strict(),
  concept_catalog:z.object({subject:subject.optional(),query:z.string().max(300).default(''),page:z.number().int().min(1).max(100000).default(1),limit:z.number().int().min(1).max(100).default(20)}).strict(),
  concept_catalog_update:z.object({key,...links,collection_id:id,...collectionMetadata,source_ids:z.array(id).min(1).max(20),reason:text}).strict(),
  exploration_next:z.object({cycle_id:id.refine(v=>v.length<=80,'Cycle id too long')}).strict(),
  video_read_frames:z.object({read_id:id,times:z.array(z.number().finite().min(0)).min(1).max(6),reason:text}).strict(),
  video_read_page:z.object({read_id:id,page:z.number().int().min(1).max(24)}).strict(),
  feed_run: z.object({run_id:id,seed:key.optional(),n:z.number().int().min(1).max(20).default(1),per:z.number().int().min(1).max(20).default(2),pool:z.number().int().min(1).max(200).default(20),source:z.enum(['search','popular','rank','following','all']).default('search')}).strict(),
  debrief_read: z.object({bvid:z.string().regex(/^BV[0-9A-Za-z]{10}$/),feed_run_id:id,audio:z.enum(['auto','never','always']).optional(),context:z.boolean().optional()}).strict(),
  feed_search_plan: z
    .object({
      key,
      run_id: id,
      queries: z.array(z.string().trim().min(2).max(40)).min(1).max(4),
      reason: text,
    })
    .strict(),
  feed_assess: z
    .object({
      key,
      run_id: id,
      assessments: z
        .array(
          z
            .object({
              bvid: z.string().regex(/^BV[0-9A-Za-z]{10}$/),
              exploration: z
                .object({
                  relevance: unit.describe('对当前探索目标的相关度：无关/同名词碰巧命中为0，弱关联低于0.5不入选，0.5至1为有材料支持的相关候选。'),
                  reason: text,
                  quote: z.string().min(1).max(500),
                })
                .strict(),
              discovered_term: z.string().trim().max(100).optional(),
              stances: z
                .array(
                  z
                    .object({
                      collection_id: id,
                      member_id: id,
                      strength: z.number().finite().min(-1).max(1).describe('该立场对选择阅读的支持方向：建议读为正，建议跳过为负，无关为0；不是立场一致度或确信程度。'),
                      reason: text,
                      quote: z.string().min(1).max(500),
                    })
                    .strict(),
                )
                .max(8),
            })
            .strict(),
        )
        .max(8),
    })
    .strict(),
  exploration_configure: z
    .object({
      key,
      ...links,
      ratios: explorationRatios,
      history_window: z.number().int().min(10).max(500).default(40),
      reason: text,
    })
    .strict(),
  exploration_plan: z
    .object({
      subject: subject.default("fish"),
      scene: id.default("watch"),
      seed: key,
      limit: z.number().int().min(1).max(50).default(10),
    })
    .strict(),
  exploration_query: z
    .object({
      subject: subject.default("fish"),
      scene: id.default("watch"),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  exploration_question: z
    .object({
      key,
      ...links,
      question_id: id.optional(),
      subject: subject.default("fish"),
      scene: id.default("watch"),
      collection_id: id,
      question: text,
      status: z.enum(["active", "paused", "resolved"]).default("active"),
      next_step: text,
      reason: text,
      source_ids: z.array(id).max(20).default([]),
    })
    .strict(),
  exploration_progress: z
    .object({
      key,
      ...links,
      decision_id: id,
      outcome: z.enum(["engaged", "completed", "skipped", "failed"]),
      source_ids: z.array(id).max(20).default([]),
      answered: z.string().trim().max(12000).default(""),
      remaining: z.string().trim().max(12000).default(""),
      next_step: z.string().trim().max(12000).default(""),
      question_status: z.enum(["active", "paused", "resolved"]).optional(),
      reason: text,
    })
    .strict(),
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
              name: z.string().trim().min(1).max(100).optional(),
              collection_id:id.optional(),
              reason:z.string().trim().min(1).max(1000).optional(),
              definition:collectionMetadata.definition.optional(),
              boundary:collectionMetadata.boundary.optional(),
              aliases:collectionMetadata.aliases.optional(),
              related: z.array(id).max(20).default([]),
            })
            .strict().refine(v=>!!v.name!==!!v.collection_id,'Use a collection_id or a new name').refine(v=>!!v.definition===!!v.boundary,'Definition and boundary must be supplied together'),
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
      exploration: z
        .object({
          path: explorationPath,
          seed: key,
          state_version: key,
          reason: text,
        })
        .strict()
        .optional(),
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
              target: target.optional(),
              reason: text,
              contributions: z
                .array(
                  z
                    .object({
                      collection_id: id,
                      member_id: id,
                      purpose: z.enum(["stance", "exploration"]).optional(),
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
