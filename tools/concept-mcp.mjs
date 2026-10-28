#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConceptEngine } from "./lib/concept-system/engine.mjs";
import { schemas } from "./lib/concept-system/schemas.mjs";
import { redact } from "./lib/concept-system/store.mjs";
const engine = new ConceptEngine(),
  server = new McpServer({ name: "bili-whale-concepts", version: "0.1.0" });
const descriptions = {
  exploration_next:'日常自动探索状态机。依次返回搜索规划、候选判断、实际选片、无字幕续找、完整字幕逐页阅读、问题进展，最后 complete/exhausted。始终沿用 cycle_id，不手工伪造阅读状态。',
  video_read_page:'读取指定真实 read_id 的一页完整字幕正文（非简介），按 total_pages 逐页调用；仅原生工具结果实际含完整正文时记录该页，全部读完才计曝光。',
  feed_run: "执行真实只读平台检索与选片流程，固定参数由插件服务运行，不需要会话终端写入学习目录。按 search_plan_required / judgment_required 完成规划和判断后，重复相同参数恢复同一 run-id。不会评论、收藏或发送。",
  debrief_read: "读取已选视频的真实简介/字幕并返回 debrief 物料回执；由插件服务执行，只读平台，不评论或收藏；固定 no-frames，无任意命令或路径参数。",
  feed_search_plan:
    "为 feed 的 search_plan_required 阶段提出符合程序所选探索路径的查询词和理由；不修改概念标签。随后恢复原 run-id 真实检索。",
  feed_assess:
    "评估 feed 返回的全部候选：逐项引用真实候选材料，判断所给立场的支持/反对与探索相关性。仅记录当前模型判断，不能伪造观看；之后恢复同一 feed run-id 让程序决定实际清单。",
  exploration_configure:
    "配置深挖、稀疏群回访、新词发现比例（总和为 1）和实际曝光窗口；记录理由与版本。",
  exploration_plan:
    "先规划探索路径：按实际曝光欠额及种子选择，返回问题、稀疏集合和新词检索线索；不计曝光。检索并记录新证据后重新规划。",
  exploration_query: "查询探索配置、问题进展、路径选择与实际曝光记录。",
  exploration_question:
    "建立或更新带集合来源的问题线，记录下一步、状态与理由。",
  exploration_progress:
    "选择后记录实际阅读/观看证据、回答、剩余问题及下一步；只有 engaged/completed 计曝光，不自动奖励。",
  concept_propose:
    "记录携带来源的待评估概念。明确 subject=user 或 fish，提及不等于喜欢。",
  concept_review: "评估候选并关联集合，保留成员和原始证据；不直接改变人设。",
  concept_query: "按主体、场景、用途、状态检索成员和集合。",
  decision_preview:
    "影子决策预演：记录分项分数、疲劳、扰动种子和状态快照；不更新学习状态。探索决策需携带 exploration_plan 的版本、种子、路径以及各选项 target。",
  decision_commit:
    "按幂等键固化一次选择与覆盖理由，只更新本地疲劳；不发送任何外部消息。",
  decision_feedback:
    "记录明确结果反馈并更新有界奖励。用户反馈必须引用用户来源。内部胜负不赏罚。",
  decision_replay: "从归档状态、时间和种子重算分数，不修改状态或重发外部动作。",
  personal_render:
    "渲染有字数预算的学习倾向，返回已选和排除素材；不覆盖 persona.md。",
  trace_get: "查询脱敏事件摘要和证据引用。用 after 序号翻页，最多 500 项。",
  version_list: "列出一个关键文件角色的版本；不读取任意路径。",
  version_diff: "读取两个版本及其脱敏内容；不自动恢复文件。",
  observation_capture: "采集固定范围的关键文件，记录内容变化、删除或不可读取。",
  observation_object: "按内容哈希读取本地脱敏证据。",
  observation_response:
    "显式归档已返回的 DS 正文和可用推理；必须指向已准备提示，不伪造推理。",
};
const readonly = new Set([
  "exploration_plan",
  "exploration_query",
  "concept_query",
  "trace_get",
  "version_list",
  "version_diff",
  "observation_object",
  "decision_replay",
]);
for (const [name, inputSchema] of Object.entries(schemas))
  server.registerTool(
    name,
    {
      description: descriptions[name],
      inputSchema,
      annotations: {
        readOnlyHint: readonly.has(name),
        destructiveHint: false,
        openWorldHint: ["feed_run","debrief_read","exploration_next"].includes(name),
      },
    },
    async (args, extra) => {
      try {
        const result = await engine.call(name, args, {signal:extra.signal});
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text", text: String(redact(e.message)) }],
        };
      }
    },
  );
await server.connect(new StdioServerTransport());
