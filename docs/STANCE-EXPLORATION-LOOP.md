# 立场、探索与真实上下文闭环

立场是判断依据，不改成检索话题。active 模式下，只要存在已接受的鱼立场或探索配置，feed 必须先完成探索搜索规划和候选判断，才会输出实际阅读清单。普通话题仍可提供搜索线索；用户偏好不反推为鱼的立场。

## 实际选片协议

沙箱会话优先调用 `feed_run` 与 `debrief_read`：它们在已配置的插件 MCP 服务内执行固定业务参数，平台访问只读，保留原账号与流量保护，不接受任意可执行文件、环境或输出路径。CLI 仍可使用。

沿用同一组 `--run-id`、`--seed`、`--n`、`--per`、`--pool`、`--source` 参数重跑 feed：

1. `search_plan_required`：程序按配置比例、有效问题与真实曝光欠额选定 deep / revisit / discover。模型调用 `feed_search_plan`，提交 1–4 条针对该路径的短查询词及理由。程序真实检索这些词，并保留少量原配置查询作为补充。
2. `judgment_required`：返回最多 8 个真实候选、目标问题/集合及最多 8 条有效鱼立场。模型调用 `feed_assess`，对每个候选逐项判断全部给定立场（支持/反对强度 -1 到 1，无关为 0），并给出探索相关度。所有引文必须逐字来自该候选的标题/简介。discover 还须从材料逐字提取尚未接纳的新词。
3. `selected`：恢复相同 run-id，程序校验候选、引文、主体、状态版本和完整覆盖，使用有符号贡献算分并提交实际清单。判断不合格、状态冲突或没有合适候选时明确失败/空清单，不悄悄回到旧排序。清单只是待读，不表示已观看。

准备、查询规划、候选判断和最终清单分别留有幂等回执。恢复已准备的候选不重新联网；恢复已提交清单不重复增加疲劳。新规则不从内部胜负自动奖励，判断阶段不把中性项解释为负兴趣。

`feed.judgment_recorded` 归档当前模型给出的解释和原始引文；`decision.previewed`、`decision.committed` 与 `feed.selected` 对应真正被选中的内容。新决策通过 `feed_judgment.assessment_object`、`stance_ids` 追溯到判断与来源。候选材料不被当作事实核验或观看证据。

### 旧偏好如何参与

旧 pref 的原始 weight、wins、losses 和来源仍原样保留。`stance-prior-v1` 只把有限正值 weight 作为立场贡献的弱先验：

```text
先验系数 = 1 + clamp(log(旧 weight), -0.25, 0.25)
立场贡献 = 新系统证据权重 × 先验系数 × 相关度 × 有符号强度 × (1 − 场景疲劳)
```

系数限制在 0.75–1.25，不把旧胜负转成新 reward，也不重新执行“赢家加分/输家扣分”。先验版本、旧权重、系数和来源 ID 随分项归档；该分支只用于带 `stance-prior-v1` 标记的新 feed 判断，原有决策重放保持原语义。模型只评价材料与立场的关系，不再次手工乘权重。通用判断立场不因每次被引用而全部累积疲劳，探索目标集合单独记录该场景的使用。

## 探索与实际阅读

探索决策沿用 watch 场景，使它与问题线及原探索配置共用曝光窗口。deep 绑定真实活跃问题；revisit 绑定实际稀疏群；discover 只建立带真实候选材料来源的 pending 新词。

`debrief <BV> --feed-run-id <run-id>` 产生物料回执；新 feed 必须通过 video_read_page 将全部正文页实际交给宿主，才自动追加 `exploration.exposed`，并把字幕来源写入同一库。下载成功、简介、待阅清单或模型自述都不会触发这项曝光。重复回执只计一次。它表示字幕材料实际进入宿主，不声称完整播放或理解了整个视频。

模型随后调用 `exploration_progress`，引用已记录的实际来源，记录回答、剩余问题和下一步。自动曝光不占用这份反思记录，也不导致反思再次计数。需要继续深入时，用 `exploration_question` 建立有来源的问题线；不把旧历史决策自动改成未解决的新问题。

## 上下文与回执

宿主继续使用原生 `system-prompt/assemble` 和 RuntimeContextProjection。预算只分配给有可用素材的主体；空的用户资料不再拿走鱼的一半预算。紧凑的工作流提示和立场正文一起受总预算约束，明确记录被选和省略的成员。

- `learning.context_prepared`：只证明程序准备了候选上下文，含 selected / omitted 成员 ID。
- `learning.context_admitted`：只有真实原生 runtime-context 消息的段落与准备内容匹配，才证明宿主接收，附 session、原生消息序号和成员 ID。
- `learning.context_delivered`：只有真实 DeepSeek 会话日志送达确认的 throughSeq 覆盖已接收上下文消息，才记录提供方送达；其他提供方未返回这类凭证时不伪造。
- `request/header`、实际模型响应及工具结果：用于把注入与真正的一轮执行对应起来。

不通过手工插入“已注入”事件验收；不在空 pre-step 中增加消息维持循环。shadow 不改变清单与模型上下文，observe=false 保留原功能且不创建学习数据库。

## 隔离验证

测试使用独立依赖、临时数据库、临时配置、模拟 GET 请求和宿主原生协议。覆盖立场影响实际清单、历史先验、探索路径/查询词/真实候选的对应、引文和主体校验、状态冲突、重试幂等、描述与字幕回执区别、曝光去重、问题关联，以及上下文预算。真实运行验收须在发布后另取实际宿主、模型、feed 和 debrief 回执，不能用测试结果代替。

## 宿主会话身份

Desktop 的 create 可能返回不同于请求值的正式 sessionId。插件使用返回值投递、跟踪并持久化；已有会话在重启时直接由 prompt 恢复，不再次 create 一个新的空会话。这样动态学习钩子、模型请求与工具结果使用同一个实际身份。

固定业务 MCP 的客户端超时应为 240000ms（示例配置已更新），以覆盖实际检索和字幕读取；取消信号继续传递到子进程，不扩大终端或文件系统权限。

后台学习在原生 turn/start 到 turn/end 之间不领取该会话任务；已开始的评估可以完成，但其验证结果延迟到会话空闲时应用，避免使正在进行的选片判断反复失效。带工具调用的模型消息仅保留原始审计，不把过程说明送入概念学习；独立的最终认识和实际字幕来源仍参与学习。

## 日常调度与完整正文（subtitle-pages-v1）

日常 `wakePrompt` 与手动业务调用共用 `exploration_next(cycle_id)` 状态机。cycle ID 由真实作息计划稳定生成，重试沿用，不拼接验收专用提示。状态机依次要求搜索规划、候选判断、实际清单、物料读取、正文分页、问题进展和回访后续问题；缺字幕、失败或截断会推进下一条，清单耗尽会继续新的真实搜索，最多三轮。预算耗尽记 `exploration.cycle_exhausted`，不伪造成功；成功记 `exploration.cycle_completed`。重启保留当前轮次和每条阅读状态。

新 feed 决策带 `read_policy=subtitle-pages-v1`。`debrief_read` 的 marker 只证明取得/接收物料；不会计字幕曝光、加入已读排除集或提前将字幕送去学习。`video_read_page(read_id,page)` 返回固定来源对象里的完整正文，不接受任意文件路径；所有页都必须在原生成功工具结果中实际包含与对象逐字一致的正文及摘要校验值。伪造文本、只有 marker、截断输出、跨会话、漏页和重复页不能完成阅读。全部页实际接收后，DeepSeek 会话还须等真实提供方 delivery-accepted 的 throughSeq 覆盖最后一页正文，才记 `video.subtitle_read_completed` 和一次 `exploration.exposed`；之后才能提交引用同一字幕来源的 `exploration_progress`。deep 更新原问题的回答、未决点、下一步与来源；revisit 建立有字幕来源的后续问题后 cycle 才能完成。

旧阅读、决策与历史事件保留原有语义，不回填新的“读完”回执。独立未绑定 feed 的旧 CLI 阅读兼容原协议；日常自动探索必须使用上述 feed 绑定协议。

`night.readOnly` 默认 false；true 时普通日常唤醒仍完成探索、阅读与本地问题进展，但跳过收藏及对外消息/推送。shadow/disabled 保留原有非主动概念选片流程，不伪称完成主动探索闭环。

自动 cycle 的返回值附带完整 feed_arguments 和 continue_with；嵌套 packet.instructions 同步改为回到 exploration_next，不再残留手动 feed 协议的“原参数重跑 feed”指引，避免模型用 feed_run 默认 n/pool 导致指纹冲突并误入源码排查。
`feed_search_plan`、`feed_assess` 自身的回执也识别归属 cycle，返回相同的 exploration_next 续接工具与参数，避免紧邻工具回执重新覆盖成手动 feed 指引；独立手动 run-id 保持原协议。

自动 cycle 将候选判断拆成逐条：返回当前一个候选、完整立场列表和精确幂等 key；合格的单候选判断先归档，全部候选完成后再聚合算分。漏填立场、假引文不会被补成中性，也不能产生部分清单。独立手动 feed 保留原来的全量判断协议。active 日常提示与人设注入另加工具协议边界：旧 pref 仅作历史存档只读，原人设文件不修改，新选择和问题进展统一由学习库 MCP 记录。
