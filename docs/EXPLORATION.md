# 探索路径与问题进展

探索机制复用概念系统 SQLite、CLI、MCP、脱敏事件及状态版本，不访问真实账号，不自行发送、检索或播放。当前 DS 通过工具执行下述循环；需在宿主连接概念 MCP 后使用。配置探索或建立问题后，general/watch 场景的学习素材会在字数预算允许时加入探索流程提示；shadow 仅归档，active 才随现有学习段注入，不强行替换宿主选片或自动触发外部操作。

## 路径与比例

默认领域深挖 `deep=0.60`、稀疏群回访 `revisit=0.25`、新词发现 `discover=0.15`。通过 MCP 或 CLI 配置：

```bash
node tools/bili.mjs concept exploration_configure --json '{"key":"explore-ratios-1","ratios":{"deep":0.6,"revisit":0.25,"discover":0.15},"history_window":40,"reason":"保留深入学习，同时补充稀疏概念和陌生线索"}'
node tools/bili.mjs concept exploration_plan --json '{"subject":"fish","scene":"watch","seed":"watch-1"}'
node tools/bili.mjs concept exploration_query --json '{"subject":"fish","scene":"watch","limit":30}'
```

比例均为 0–1 且总和为 1；0 完全禁用该路径。窗口可设为 10–500 次实际曝光。配置保存在概念数据库的 `concepts.exploration.config`，不改写宿主配置或真实人设，修改附带原因与状态版本。测试须设置独立 `BILI_CONCEPT_HOME`。

算法 `exploration-v1` 在同一主体、同一场景的最近实际曝光窗口中，计算各路径相对配置比例的欠额，再用归档种子进行加权抽样。先选择路径，再在该路径内沿用原有证据、疲劳与有界扰动评分。允许连续深挖，不要求固定轮换；比例是长期目标，不是精确配额保证。无活跃问题则暂不可深挖，无有效集合则暂不可回访；不可用路径临时排除并对其余正比例路径归一化。所有正比例路径都不可用时明确报错，不能启用零比例路径兜底。

预演和提交选择均不计探索曝光；只有带已记录来源的 `engaged` 或 `completed` 进展计一次。失败、跳过、用户沉默不当作负兴趣，实际接触也不自动奖励或接纳新词。

## 执行循环

1. 调用 `exploration_plan`，读取路径、状态版本、候选问题、回访优先级和新词检索方向。
2. 根据路径检索真实内容。深挖围绕待解决问题寻找前置解释、例子、不同观点或反例；回访补薄弱概念的解释和关联；新词既沿当前内容的边界查找，也主动检索近期少见领域。
3. 用 `concept_propose` 保存来源原句与陌生词，新词先保持 pending；需要稳定概念参与评分时经过 `concept_review`。新词候选的存在不证明理解、喜欢或认同。
4. 新来源、问题或配置改变了状态后，重新调用 `exploration_plan`，使用返回的最新路径与版本。检索本身不消耗曝光预算。
5. 调用 `decision_preview`，携带 `exploration` 和各候选的 `target`。所有可用候选须属于本次路径，不能用强势主题跨路径抢占。
6. `decision_commit` 保存实际选择及理由，可在同一路径的可用候选中覆盖建议；覆盖理由沿用必填 `reason`。
7. 实际阅读或观看后调用 `exploration_progress`，携带来源、收获、剩余问题和下一步。没读到材料则记录 skipped/failed，不虚构问题进展。

规划返回的稀疏群优先级由独立来源不足、距离上次实际接触的时间、实际曝光次数共同形成，不使用原始成员数做反比奖励。独立证据按来源 actor/type/ref 或原文粗去重；相同证据的改名集合共用曝光历史和一个推荐位置。当前不宣称具备语义去重或自动判断概念理解深度的能力。回访候选由 DS 依据优先级与当前问题提出，排序是建议，不能取代内容质量判断。

## 问题线

```json
{
  "key": "question-1",
  "collection_id": "已接纳的集合ID",
  "question": "自由意志与因果律怎样相容？",
  "next_step": "先找出不同解释及其反例",
  "source_ids": ["已记录来源ID"],
  "reason": "当前理解存在明确缺口"
}
```

将此输入交给 `exploration_question`，返回稳定问题 ID。默认主体 fish、场景 watch、状态 active。更新时传 question_id；主体、场景和所属集合不能挪动。可将状态更新为 paused 或 resolved；恢复探索时显式改为 active。保留原始问题，以进展记录积累回答与剩余疑问，避免把反复看同类入门内容当作深入。问题修改、每次阅读进展均保留事件与状态版本，当前问题保存最新进展。

深挖默认优先返回近期更新的活跃问题，支持围绕同一问题连续推进。各次决策保留当时的问题快照；后来修改问题不改变历史选择依据。

## 预演与实际选择

普通 `decision_preview` 不传 exploration 时保持原有评分与重放行为。探索决策额外携带：

```json
{
  "exploration": {
    "path": "deep",
    "seed": "exploration_plan 使用的种子",
    "state_version": "exploration_plan 返回的版本",
    "reason": "前次已经理解基本论证，本次继续比较反例"
  }
}
```

每个 option 额外传入 target：

- deep：`{"collection_id":"集合ID","question_id":"活跃问题ID"}`。
- revisit：`{"collection_id":"集合ID"}`。
- discover：`{"candidate_id":"带来源的 pending 成员ID"}`，contributions 使用空数组。

深挖、回访的 contributions 必须引用目标集合内已接纳的有效成员；不得混入其他集合借权重抬分。新词使用真实来源的待评估候选，允许多个未形成集合的词竞争；证据不足时分数可打平，不能声称有充分的偏好依据。候选 reason 描述内容价值，exploration.reason 描述本次探索目的，commit.reason 描述实际选择，三者分别保留。

规划状态冲突要求重新规划；提交冲突和过期继续沿用现有检查。比例和实际曝光窗口、路径、抽样依据、当时目标、候选理由与覆盖理由均随决策归档。`decision_replay` 使用当时状态、时间和种子，不受后续调参影响。

## 实际接触与进展

```json
{
  "key": "progress-1",
  "decision_id": "已提交探索决策ID",
  "outcome": "completed",
  "source_ids": ["实际阅读材料的已记录来源ID"],
  "answered": "找到一种相容论解释，但尚未充分比较",
  "remaining": "这种解释如何回应决定论的反对意见？",
  "next_step": "寻找反对意见并比较前提",
  "question_status": "active",
  "reason": "实际阅读该材料后记录"
}
```

交给 `exploration_progress`。深挖实际接触须记录剩余问题和下一步；问题 resolved 时可省略 remaining。answered 可以为空，允许如实记录没有解决问题。进展是调用方报告，不宣称程序独立验证了观看或理解程度。

一次决策记录一份最终接触结果；同幂等键重试返回原记录，其他键重复提交拒绝，避免重复计数。持续推进同一问题时创建下一次决策。修订问题使用 exploration_question，不回写旧决策。source_ids 必须存在；engaged/completed 必须至少有一个来源。skipped/failed 不允许填写问题进展或改变问题状态。

`exploration_query` 返回配置、问题与近期探索决策；`trace_get` 可按 decision_id 查询完整进展事件和状态版本。观察页面的“决策过程”展示路径、当时比例、规划与选择理由、问题快照、实际收获、剩余疑问、下一步和来源。只读页面不提供配置写入。

## 本次验证

在独立工作树安装独立依赖并构建观察页；全部学习、问题和曝光数据使用临时 SQLite 与快照目录。串行全量 200 项测试通过，覆盖默认/自定义比例、零比例、冷启动、80 次曝光调度、来源去重、跨主体/场景隔离、规划失效、幂等进展、问题暂停、重放、MCP/CLI 共用配置和注入字数预算。默认并行全量曾出现一次既有文件观察器超时；该组单独复测 9 项通过，串行全量通过，未修改该观察器逻辑。

浏览器验收使用独立回环端口和全新 origin，在新标签页检查桌面 1280×720 的探索详情、目标、选择理由与实际进展，滚动检查候选评分布局；未测试移动端。没有向真实账号写入、迁移真实学习数据或重启在线宿主。真实 DS 检索/观看与宿主在线注入尚未验收。

## 部署与启用

本地 desktop profile 通过 link 加载插件的 main 工作目录。发布时先在隔离工作树完成依赖安装、测试及观察页构建，再将已验证提交合入 main，部署运行依赖和构建产物。宿主需连接 `bili-whale-concepts` MCP，使用与调度器一致的私有 `BILI_CONCEPT_HOME`；观察开关打开且 mode=active 时，探索流程提示才会加入学习上下文。初始化只保存 60% / 25% / 15% 的真实配置，不向在线学习库写入测试概念或模拟观看进展。运行版本、宿主连接和实际功能以发布验收记录为准。

## 自动选片与立场闭环

active feed 已增加探索查询规划和带引文的立场判断阶段，并与真实字幕回执及原生上下文接收回执关联。操作协议与旧权重先验见[立场、探索与真实上下文闭环](STANCE-EXPLORATION-LOOP.md)。
