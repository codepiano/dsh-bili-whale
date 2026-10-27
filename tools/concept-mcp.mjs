#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConceptEngine } from "./lib/concept-system/engine.mjs";
import { schemas } from "./lib/concept-system/schemas.mjs";
import { redact } from "./lib/concept-system/store.mjs";
const engine = new ConceptEngine(),
  server = new McpServer({ name: "bili-whale-concepts", version: "0.1.0" });
const descriptions = {
  concept_propose:
    "记录携带来源的待评估概念。明确 subject=user 或 fish，提及不等于喜欢。",
  concept_review: "评估候选并关联集合，保留成员和原始证据；不直接改变人设。",
  concept_query: "按主体、场景、用途、状态检索成员和集合。",
  decision_preview:
    "影子决策预演：记录分项分数、疲劳、扰动种子和状态快照；不更新学习状态。",
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
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const result = await engine.call(name, args);
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
