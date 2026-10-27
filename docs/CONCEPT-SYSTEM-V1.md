# 概念系统第一版使用与验证

开发分支上的实现，不代表已安装或发布。观察、学习数据保存在 `~/.bili-ai/concept-system/`，可以用 `BILI_CONCEPT_HOME` 指向独立测试目录。不要把此目录放进公开仓库。

## 观察与版本

```bash
node tools/bili.mjs observe status
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

存储使用私有目录和内容哈希对象；单个原子替换的 `journal.json` 保存事件、版本清单与状态，同一跨进程锁串行化 CLI、MCP 和宿主写入。事务中断只可能留下尚未引用的内容对象，不会留下已更新学习状态却没有事件的部分提交。日志损坏时拒绝更新，不重建空白状态。首版面向本地低频使用，尚未分段压缩，事件量大时需要后续增加索引和归档。

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

配置默认是 `{"conceptSystem":{"observe":false,"mode":"shadow","renderBudget":400}}`。observe=true 时记录候选渲染及 personal_rendered 版本，shadow 不把这些学习素材追加进提示。active 才把渲染段附加到显式人设后；有效内容哈希包含这段文本，学习素材发生变化会重新注入，即使 persona.md 没有改。

concept_state 版本在提议、评估、决策提交和反馈更新的同一事务中记录。磁盘上的 personal.json 如存在仅作为观察来源；实际生成的 personal 段落来自 journal 状态，使用独立角色 personal_rendered，避免二者混淆。不自动覆盖用户的 persona.md、personal.json 或旧 pref 原型。

当前 DS 通过 MCP 或 CLI 进行候选提取和评估；没有额外后台模型，也没有全历史自动导入。新工具要在宿主中显式连接后才可使用。视频和表达的选择仍由当前 DS 发起，程序记录建议、实际提交与覆盖，不自动触发浏览、评论、私信或词句替换。

trace_id 由调用方从 `trace_get` 或 `observe events` 的 prepared 记录中明确传入；未知时留空，不凭时间猜测。版本、事件摘要和证据对象都能通过同一 MCP 读取；尚未提供可视化观察页面、自动文件恢复和历史 zstd 会话导入。
