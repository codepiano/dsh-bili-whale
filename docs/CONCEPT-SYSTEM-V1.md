# 概念系统第一版使用与验证

开发分支上的实现，不代表已安装或发布。观察、学习数据保存在 `~/.bili-ai/concept-system/`，可以用 `BILI_CONCEPT_HOME` 指向独立测试目录。不要把此目录放进公开仓库。

## 观察与版本

```bash
node tools/bili.mjs observe status
node tools/bili.mjs observe integrity
node tools/bili.mjs observe capture
node tools/bili.mjs observe events '{"type":"prompt.prepared","limit":20}'
node tools/bili.mjs observe versions persona
node tools/bili.mjs observe diff persona <旧版本ID> <新版本ID>
node tools/bili.mjs observe object <内容哈希>
```

`capture` 会读取固定范围的人设、personal、两本日记和白名单配置；不接受任意文件路径。对象在写入前脱敏，因此脱敏版本只用于观察，不能用于原样恢复凭据或宣称完整输入复现。`diff` 返回两个版本的内容与元数据，首版不提供自动恢复和外部动作重放。

宿主自动观察默认关闭。将配置中的 `conceptSystem.observe` 设为 `true`，在明确发布并重新加载插件后启用，首次采集当前版本，以后轮询关键文件并在提交提示时保存确定的人设输入。此开关在调度器启动时读取，修改后需要重新加载插件。它不改变现有账号和发送保护。

记录 `prompt.prepared` 与 `prompt.accepted`；后者只表示宿主接收。通过已安装 DSH 的 `session/event` 事件接口捕获新会话事件，只观察插件跟踪的会话。完全匹配的用户消息文本与已准备提示关联；其他用户消息创建独立 trace，无匹配时记录未关联状态。首版不补读整个旧会话，也不承诺跨重启恢复未完成 trace 的关联。

宿主保存的 assistant/message 及其中实际返回的 reasoning 内容会作为脱敏证据对象保存；可用的 request/header 和模型来源也保留在宿主事件中。没有事件接口或没有 reasoning 内容时，保留不可用标记，不能把简短决策理由冒充原始推理。显式导入响应也可以用 `observe response <JSON文件>`，必须提供能对应到 prepared 提示的 trace_id 与 session_id，并声明 reasoning_kind。

存储使用 SQLite 数据库 `observations.sqlite3` 和独立的 `objects/` 内容哈希快照。数据库启用 WAL、FULL 同步和写锁等待；事件、版本索引、幂等回执、预演、学习元数据及各类概念实体分别建表，学习实体按类型和 ID 单独存行。一次学习提交的状态变化与事件在同一事务中提交或回滚，不再用回环端口作为存储锁。

事件查询按 trace、决策、会话、类型和时间建立索引，支持序号分页。事件追加与文件版本记录不加载学习图；学习事务仍读取当前学习状态进行计算与版本检查，但只更新变化的实体行，不重写全部历史事件。`read()` 保留完整导出兼容接口，日常查询不经过它。快照仍按内容哈希独立保存，事务失败可能留下未引用的快照，不会产生部分提交的学习状态。

概念存储使用内置 `node:sqlite`，需要无需实验开关即可加载该模块的 Node 22.13+。观察关闭时普通插件功能不加载此模块，保留原有运行时兼容性；启用观察和运行概念 MCP 时，宿主与 CLI 均须支持 SQLite。本机已分别在 Node 26 与 DSH 内置 Node 24 验证，不增加原生扩展编译依赖。

### 从旧日志迁移

首次打开尚未初始化的数据库时，如同目录存在 `journal.json`，会校验结构、事件序号及版本和预演引用的快照，再在同一 SQLite 事务中导入事件、版本、幂等回执、预演与学习状态。导入来源哈希记录在 metadata 表中；成功后只使用数据库，不反复导入旧文件。原 JSON 和快照文件原样保留，不自动删除或改写。

迁移失败会回滚建表与导入，原文件保留；数据库损坏、应用标识不符或不支持的 schema 版本会拒绝操作，不静默清空重建。迁移应在旧 JSON 写入进程停止后进行，避免旧程序继续写入已经停用的日志。本次开发只迁移临时测试数据，不打开或迁移真实用户目录。

`observe status` 显示数据库位置、事件数和迁移信息；`observe integrity` 执行 SQLite quick_check。WAL 模式下可能存在 `observations.sqlite3-wal`、`observations.sqlite3-shm`，不要在运行中手动删除。备份应包含数据库与 objects 快照，并在所有写入进程停止后复制；不要只复制运行中的主数据库文件。

关键文件检查覆盖删除和再次出现；一个轮询周期内发生且恢复原状的短暂编辑可能无法观测。人设、聊天、日记、原始推理均不进入项目 Git，默认也不向外上传。

## 验证边界

测试使用临时目录、模拟宿主及独立子进程；不访问真实 B 站接口、不改写真实人设、聊天和学习记录。宿主事件接口来自本机安装版本的源码，真实在线运行验收需等用户明确发布后完成。

## 概念与决策接口

MCP stdio 入口是 `node tools/concept-mcp.mjs`，采用官方 MCP SDK，标准输出只传协议消息。传输行为参见 [MCP stdio 规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。`tools/templates/concept-mcp.example.json` 对应已检查的 DSH `dsh-mcp-client` 插件配置字段；绝对路径需按实际安装填写，通过宿主现有插件管理注册。生成示例不代表已写入当前 DSH 配置，也不代表在线连接已验收。

CLI 使用同一核心和输入校验：

```bash
node tools/bili.mjs concept help
node tools/bili.mjs concept concept_propose --input candidate.json
node tools/bili.mjs concept concept_review --input review.json
node tools/bili.mjs concept concept_query --json '{"subject":"fish","status":"accepted"}'
node tools/bili.mjs concept decision_preview --input decision.json
node tools/bili.mjs concept decision_commit --input commit.json
node tools/bili.mjs concept decision_feedback --input feedback.json
node tools/bili.mjs concept decision_replay --json '{"preview_id":"预演返回的ID"}'
node tools/bili.mjs concept personal_render --json '{"scene":"general","budget":400}'
```

`concept_propose` 的最小输入：

```json
{
  "key": "propose-session1-msg7-kant",
  "source": {
    "id": "session1-msg7",
    "actor": "user",
    "type": "conversation",
    "ref": "session1/message7",
    "excerpt": "最近想了解康德"
  },
  "subject": "fish",
  "content": "康德",
  "tags": ["topic"],
  "interpretation": "explicit"
}
```

`actor` 表示谁提供素材；`subject` 表示正在建模谁的倾向，二者分开。候选的 subject 为 fish 表示从用户话语产生鱼的学习线索，不能据此写成用户已经具有相同偏好。tags 可以包含 topic、belief、motive、word、phrase、idiom、sentence_pattern；interpretation 区分 explicit、mention、negated、quoted、uncertain。原文中的否定和引用要由当前 DS 评估，程序不靠词频自行认定喜欢。

评估输入如下，候选 ID 从上一步获取：

```json
{
  "key": "review-session1-msg7-kant",
  "candidate_id": "上一步返回的id",
  "status": "accepted",
  "reason": "明确表达了探索意向，保留来源",
  "collections": [{"name": "哲学"}, {"name": "待探索主题"}]
}
```

决策输入如下，group ID 和 member ID 通过 `concept_query` 获取：

```json
{
  "trace_id": "可选，观察记录中的当前trace ID",
  "question": "今晚先看什么",
  "scene": "watch",
  "seed": "session1-night1",
  "options": [
    {
      "label": "学习",
      "reason": "继续探索尚未解决的问题",
      "contributions": [{"collection_id":"学习集合ID","member_id":"康德成员ID","relevance":0.9,"strength":0.8,"reason":"本次问题与该兴趣相关"}]
    },
    {
      "label": "娱乐",
      "reason": "休息也有价值",
      "contributions": [{"collection_id":"娱乐集合ID","member_id":"动漫成员ID","relevance":0.8,"strength":0.7,"reason":"最近接触较少"}]
    }
  ]
}
```

支持负 strength 表示反对，范围为 -1 到 1；relevance 为 0 到 1。`eligible:false` 的候选不会胜出，但程序评分不替代平台权限、额度和账号检查。上下层决策通过 parent_decision_id 关联，须指向同一 trace 下已提交的父决策。

提交输入是 `{"key":"唯一幂等键","preview_id":"预演ID","selected":"学习","reason":"实际选择及理由"}`。selected 可省略以采用建议；选择不同于建议时记录覆盖。状态已改变或预演超过 15 分钟时拒绝提交，需要重新预演。每个预演只可提交一次；同一幂等键的相同请求返回原结果，不重复累积疲劳。

反馈输入包含 key、decision_id、actor、outcome 和 reason。outcome 为 positive、negative 或 unknown。用户反馈还须提供 source_id，指向 actor=user 且 type=feedback 的已记录来源。同一决策重复使用同一反馈证据不会重复更新，来源和反馈解释仍标为调用方报告，不宣称程序已独立证实用户态度。

## 当前参数与语义

首版算法版本 `concept-v1`，参数与当时状态一并归档。集合强度由不同来源数、成员丰富度和反馈奖励决定，限制在 0.2–3。来源通过 actor、type、ref 或原文做粗去重；同一来源的成员丰富度贡献有上限，不实现语义层面的证据独立性判断。

各候选对独立证据的贡献取均值，不因堆成员数量无限放大；同一来源在一个候选中只计一次。疲劳按场景保存，每次提交实际选择后增加 0.2，最多 0.9，半衰期为 6 小时。预演得分在顶部 0.1 范围内才加入最大正负 0.05 的种子扰动。没有有效证据也可能形成探索性平局，不能把这种结果称为有充分论据。

明确正负反馈的奖励增量：用户为正负 0.1，鱼的自评为正负 0.05，总奖励限制在正负 0.5。unknown 不更新奖励；内部竞争胜负不直接赏罚。第一版参数保存在学习状态中，不提供在线调参工具；变更算法时应保留旧版本的重放能力。

兴趣保留 familiarity、affinity、curiosity、confidence 和场景疲劳。当前 familiarity、confidence 从有效成员与来源计算，curiosity 根据已评估的提及或明确探索意向做粗更新；affinity 暂保留为中性，不从简单提及推断认同。还未实现自动反思或复杂兴趣演化。

## 影子模式与关键版本

配置默认是 `{"conceptSystem":{"observe":false,"learning":true,"mode":"shadow","renderBudget":400}}`。observe=true 且 learning=true 时，宿主自动入队和评估新消息，并在每次模型调用前记录候选渲染及 personal_rendered 版本。shadow 更新学习状态并记录素材，不把素材交给日常模型；active 才通过 system-prompt/assemble 提供动态 context，由宿主原生上下文投影负责保留、更新和去重，覆盖直接聊天及工具续轮。pre-step 原样返回消息，不改变回合结束条件。动态素材不再写进调度器用户消息，不受人设去重影响。完整流程、重试与边界见 [宿主自动学习](AUTOMATIC-LEARNING.md)。

concept_state 版本在提议、评估、决策提交和反馈更新的同一事务中记录。磁盘上的 personal.json 如存在仅作为观察来源；实际生成的 personal 段落来自 journal 状态，使用独立角色 personal_rendered，避免二者混淆。不自动覆盖用户的 persona.md、personal.json 或旧 pref 原型。

宿主现在使用 DSH 已有模型服务自动评估鱼会话中的新用户消息、实际模型正文及监听器收到的主人私信/评论原话；评估是有超时、无工具的独立调用，返回结果由程序校验并通过共享核心收录，不要求日常 DS 主动调用 MCP。MCP/CLI 仍可用于显式查询和操作，MCP 尚未自动注册。没有全历史导入、视频工具输出自动学习或直播混合输出学习。视频和表达的选择仍由当前 DS 发起，尚未接入选题竞争或外部动作入口约束。

trace_id 由调用方从 `trace_get` 或 `observe events` 的 prepared 记录中明确传入；未知时留空，不凭时间猜测。版本、事件摘要和证据对象都能通过同一 MCP 读取；另提供下述本地观察页面；尚未提供自动文件恢复和历史 zstd 会话导入。

## Mantine 本地观察页面

开发工作树中先安装开发依赖并构建页面，再手动启动：

```bash
npm ci
npm run build:observer
node tools/bili.mjs observe serve
# 或指定一个空闲端口
node tools/bili.mjs observe serve --port 4399
```

不指定端口时由系统选择空闲回环端口，终端打印实际 URL。服务只监听 `127.0.0.1`，Ctrl+C 停止；不会自动打开浏览器、注册后台服务或更改正在运行的 DSH。要查看独立数据，可先设置 `BILI_CONCEPT_HOME`。不要在在线插件目录执行 npm ci 或构建验证；使用独立开发副本。

前端使用 React 19 与 Mantine 9，提供三个视图：

- 概念集合：按归属主体和名称筛选，分页查看集合强度、奖励、成员状态、适用场景及原始来源。
- 决策过程：区分预演和已提交决策，查看当时的候选、分项贡献、疲劳、扰动、实际选择、覆盖原因和反馈变化；还可展开关联事件、提示与响应证据。历史名称和成员正文来自归档状态，不用当前状态替代。
- 人格与版本：选择人格文件、学习注入或其他关键角色，比较任意两个已载入版本，跨页保留选择，逐行显示增删。缺失、删除、不可读取、脱敏与大内容降级均明确标记。

页面只读打开已有 SQLite，不自动建库或迁移、不生成示例数据、不恢复文件、不提交决策、不更新权重。未创建数据库或仅有旧 JSON 日志时显示说明；由用户通过原观察 CLI 明确执行采集或迁移。页面依靠手动刷新获取新记录，不自行调用模型。

静态资源由项目本地打包，不从 CDN 加载。`npm pack` 会先构建并把产物纳入包；已构建发布包运行页面不需要 Mantine、React 或 esbuild 的开发依赖。未构建时命令会明确提示构建步骤。

验证使用临时 SQLite 与快照、独立回环端口和全新浏览器存储。桌面宽度 1440 与较窄桌面 1050 检查了概念详情、决策分数、版本差异、普通及长选项、焦点和禁用状态；不包含移动端验收。
