#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConceptEngine } from "./lib/concept-system/engine.mjs";
import { schemas } from "./lib/concept-system/schemas.mjs";
import { frameToolContent } from "./lib/video-frames.mjs";
import { redact } from "./lib/concept-system/store.mjs";
const engine = new ConceptEngine(),
  server = new McpServer({ name: "bili-whale-concepts", version: "0.1.0" });
const descriptions = {
  resource_unavailable:'仅在宿主原生web_search/web_fetch未注册或无法执行时报告原因，标为调用者报告而非提供方实际故障。不产生阅读或曝光，继续正常预算。',
  resource_assess:'评估宿主原生web_search实际返回的当前网页候选；按URL匹配完整立场，原文引述标题/摘要，相关度低于0.5不选。仅记录选题判断，不接受调用者提交网页正文或冒充已读。',
  resource_read_page:'按实际read_id重读已交付网页的一页正文。来源含URL、版本和页数；不代表整个站点或仓库。',
  resource_knowledge_save:'将完整交付的网页、仓库页面或文章的总结和想法保存到Mem并读回验证；使用真实read_id与原文引文，不接受搜索摘要作为已读正文。',
  resource_knowledge_get:'按真实网页read_id读回Mem知识和来源版本。',
  concept_enrich:'为已有成员补充短关键词和可验证来源，label可将主名称修成已有关键词之一，旧长句保存在description与历史，不创建新成员、不改原始来源或曝光奖励。keywords须出现在所附来源正文或完整已读材料原始标题/简介中（元信息仅用于名称交叉核对，不冒充正文）；replace_keywords=true可修正旧关键词，保留历史事件。证据用已有source_id+quote或完整已读read_id+page+quote。复用candidate_id，保持原始历史；补录和日常阅读后均可调用。',
  video_knowledge_save:'把实际完整读完的视频内容总结、鱼自己的理解/想法和疑问保存到 Nowledge Mem 知识库。必须带真实 read_id 和来源逐字引文；按视频内容版本幂等写入并实际读回验证，返回 memory_id；不修改概念群、曝光、奖励或主人偏好。',
  video_knowledge_get:'按真实已读 read_id 从 Nowledge Mem 读回知识总结及 memory_id；不把本地概念群当知识正文。',
  persona_revision_retry:'用原始已完成来源重新排队一次已耗尽的反思，必须给出 attempt_id、当前 persona 哈希和理由。原失败记录保留，不接收伪造经历或指定修改内容，由正常后台重新判断。',
  persona_revision_history:'查看 persona 当前文件、哈希、自动修订/回滚版本、来源与修改理由；不修改文件。',
  persona_revision_rollback:'将指定修订恢复到修改前；必须携带当前文件 expected_hash 和理由。保留新回滚版本与原历史，拒绝覆盖未知外部修改。',
  concept_catalog:'概念群目录索引。可按主体、关键词分页检索；包含定义、归属边界、别名、代表成员及原始来源。先查目录，用群ID归类，缺少定义会显式标记。',
  concept_catalog_update:'补充概念群的定义、边界、别名和关联群。必须引用本群已有来源并说明理由；不合并、移动或删除成员。',
  feed_details:'按 run_id 读取已归档规划明细，不重跑竞争、不产生曝光。按 section 分页查看兴趣评分、群内评分、问题、回访群、目标成员、立场或候选；stage=web 可查网页 candidates/assessments/decisions/reads。member_competitions 用 competition_index 选择一场竞争，再用 offset/limit 翻页。日常先执行 exploration_next 默认关键数据，需要更多依据才调用。',
  exploration_next:'日常自动探索状态机。依次返回搜索规划、候选判断、实际选片、字幕优先、缺字幕云端音频转写、完整正文逐页阅读、问题进展，按实际阅读预算继续清单与后续检索，最多三轮；第一条读完不结束，达到night.maxVideos或三轮结束才complete/exhausted。默认只返回当前步骤的关键数据，详情用返回的 feed_details 指针按需读取。始终沿用 cycle_id，不手工伪造阅读状态。',
  video_audio_status:'查询 read_id 已关联的云端语音任务；pending 时至少30秒后再查或下次作息继续，不重交。不把任务受理当已读，完成后仍须 video_read_page 实际交付正文。',
  video_read_frames:'仅在画面信息确有必要时补充指定 read_id 的 1–6 个时间点截图并直接返回图片；需写 reason。记录 BV/CID、时间、图片哈希和原阅读关联，生成图片不等于已看懂全片。',
  video_read_page:'读取指定真实 read_id 的一页完整字幕或云端音频转写正文（非简介），按 total_pages 逐页调用；仅原生工具结果实际含完整正文时记录该页，全部读完才计曝光。',
  feed_run: "执行真实只读平台检索与选片流程，固定参数由插件服务运行，不需要会话终端写入学习目录。按 search_plan_required / judgment_required 完成规划和判断后，重复相同参数恢复同一 run-id。不会评论、收藏或发送。",
  debrief_read: "字幕优先读取已选视频并返回物料回执；缺字幕时调用 common-mcp speech HTTP 服务云端转写，不使用本地模型。audio=always 用于核实口述，never 禁用转写；context=true 才补封面/弹幕/热评。画面另用 video_read_frames；无任意命令或路径参数。",
  feed_search_plan:
    "为 feed 的 search_plan_required 阶段提出符合探索路径的查询词与理由，并选择source=bilibili或web；文章、文档、论文、仓库README/issue/commit用web，状态机随后要求宿主原生web_search/web_fetch；不修改概念标签。随后恢复原 run-id 真实检索。",
  feed_assess:
    "评估 feed 当前返回的候选；自动 cycle 每次一个候选，完整覆盖全部立场，逐字引用候选原文。探索相关度低于0.5不入选，同名词误命中给0。立场strength表示对选择阅读的支持：读为正、跳过为负、无关为0。清单允许不足或为空。只记录判断，不伪造观看；使用回执的exploration_next续接。",
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
    "记录携带来源的待评估概念/代表性关键词。topic的content须是1-40字名词/名词短语；解释放description，检索词放keywords；同名成员复用。像论文关键词一样提炼名词或名词短语；历史事件、理论、人物、现象、效应、模式等具体对象可直接作为 topic 参与兴趣与探索，不必抽象成大类。明确主体，mention 不等于认同或事实核验。",
  concept_review: "先用concept_catalog查目录；复用群使用collection_id并记录reason，新群使用name与定义/边界。评估候选并关联集合，保留成员和原始证据；不直接改变人设。",
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
  "feed_details",
  "resource_read_page",
  "resource_knowledge_get",
  "video_knowledge_get",
  'persona_revision_history',
  'concept_catalog',
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
        openWorldHint: ["feed_run","debrief_read","video_audio_status","video_read_frames","exploration_next","video_knowledge_save","video_knowledge_get","resource_knowledge_save","resource_knowledge_get"].includes(name),
      },
    },
    async (args, extra) => {
      try {
        const result = await engine.call(name, args, {signal:extra.signal});
        if(result?.type==='bili.video_frames.v1') {
          return {content:frameToolContent(result)};
        }
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
