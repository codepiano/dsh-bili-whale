# B站与独立 DeepSeek Search API 联合探索

鱼在同一个 `exploration_next` 周期里比较视频和网页材料，沿用 deep/revisit/discover 比例、0.5 相关度门槛和最多三轮检索。`night.maxVideos` 作为实际阅读总上限（默认 5），由视频和网页共用；第一条完成后继续剩余候选，下一轮只申请剩余条数。失败、简介、搜索摘要或截断不计已读，不抬分凑数。

## 来源与默认行为

新夜间周期默认 `night.searchSource="both"`。`feed_search_plan` 可显式选择：

- `both`：同一步并行执行现有 B 站检索与独立 DS Search API，合并候选统一判断。
- `bilibili`：原有视频流程。
- `web`：只用独立 DS Search API 找网页或其它原始资料。

自动周期创建时持久化默认来源，省略 source 时仍沿用它；独立的旧 feed 调用省略 source 则保留原 B 站兼容行为。参数示例：

```json
{"run_id":"状态机给定run_id","key":"本次规划键","source":"both","queries":["项目升级 返工工时 issue"],"reason":"同时比较视频讲解与项目原始记录"}
```

`both` / `web` 由状态机返回专用原生工具 `fish_web_search({queries})`。它在发起请求的 DSH agent 上下文中，直接使用宿主已注册的 `deepseek-search-api` provider；沿用原账号/密钥解析与已配置的可信端点，不复制凭据，不改变全局 web provider，不为搜索额外调用聊天模型，失败时也不退回模型搜索。仅跟踪的鱼会话可执行此专用工具。

联合模式同时启动原有固定 B 站命令，保留平台限流、排除已读与已评论视频等约束。一边失败时保留另一边实际取得的结果；两边都失败或结果为空则按剩余轮数继续。相同 run 的并发重试复用进行中的任务。

## 已检查的 DSH 搜索实现与费用

安装版 DSH 同时提供 `deepseek-official`（通过 Anthropic Messages 原生 web_search 服务端工具搜索）和独立 `deepseek-search-api` / `deepseek-fetch-api`。普通 `web_search` 的原有全局选择仍保留；鱼专用入口明确使用独立 Search API，避免把普通工具的 provider 当成独立 API。网页正文继续用原生 `web_fetch`，沿用宿主的 fetch provider；已检查的基础配置为 `http`，不自动切换到付费 Fetch API。

独立接口为 `POST https://api.deepseek.com/v1/tools/search` / `fetch`。根据 [DeepSeek 官方 Search & Fetch 文档](https://api-docs.deepseek.com/guides/search/)（2026-11-03 核对），Search 和 Fetch 各为每千次成功且有结果的请求 $0.75；空结果、失败和超时不计费，结果条数不影响单次费用。免费期于北京时间 2026-11-01 00:00 结束。

鱼每轮最多 4 个 DS 查询、每查询取 8 条短结果，`need_content=false`；最多三轮，搜索接口最坏约 $0.009/次夜间任务。每天一次、30天约 $0.27，这是计算值，不含模型 token、正文抓取或其它唤醒次数。网页抓取若以后由用户切到 DeepSeek Fetch API，则另按成功抓取次数计费。价格可变，实际以当时官方计费和账户账单为准。

## 候选、正文与回执

1. 原生联合搜索返回最小计数和提供方状态，宿主归档结构化原始结果。两边最多各 8 个结果，交错合并成最多 8 个待评估候选；同一 BVid/URL 去重并保留提供方标签。`candidate_pool` 明示保留范围，未显示的完整结果仍可查。
2. `resource_assess` 每次仅评估当前 URL，引文来自真实标题/摘要，完整覆盖全部立场。程序统一计算并选择视频/网页，不因提供方而抬分。discovery 的词须来自实际候选且尚未被接受；搜索摘要仅支持待评估接触线索，不计全文阅读。
3. 视频用 `debrief_read`、`video_read_page` 及原字幕/云转写流程；选片回执与原生正文交付要求不变。网页用宿主 `web_fetch`；原始请求、最终 URL、正文版本、call ID、session ID 均留痕，非2xx、空正文、截断和超限不能计已读。
4. 宿主只接收鱼会话、匹配待执行参数的真实原生结果；实际工具消息必须与归档渲染正文一致，DeepSeek 会话还须有正常 provider 接收回执覆盖消息序号。模型提交正文、其它会话的结果、HTTP成功、搜索摘要和未送达正文都不能替代。
5. 网页归档后、消息交付前若中断，可用 `resource_read_page` 从原版本逐页恢复，全部页交付后才计阅读，不重新抓取。正常网页抓取已完整交付时不重复输出整份正文。
6. `exploration_progress` 只能引用本次真实阅读来源。revisit 仍需在原集合建立有来源的后续问题；每条阅读后独立完成概念查重/维护和 Mem 保存读回。网页用 `resource_knowledge_save/get`，视频沿用原 `video_knowledge_save/get`，均按内容版本幂等。

默认只给当前步骤。需要更多资料时，用 `feed_details({run_id,stage:"web",section:"search_results",offset,limit})` 获取完整搜索结果；其它 section 包括 candidates、assessments、decisions、reads。正文按 read_id 用对应 page 工具重读，不把完整评分或全部候选反复塞进每个返回。

`resource_unavailable` 用于专用搜索或网页抓取工具未注册等无法执行的情况，明确标为调用者报告，不伪装成提供方结果；不产生阅读或曝光。联合探索不自动发评论、收藏、推送或登录其它站点。

来源范围是这次实际交付的页面或视频文字材料。README 不代表整个仓库，论文介绍页不代表论文 PDF 全文，作者主张也不是独立核验。第三方材料只作鱼的接触话题或表达，不能直接成为个人信念、动机或主人的偏好。

## 验证和发布

测试使用独立 SQLite、临时 HOME/DSH_HOME、真实 B站命令配合模拟网络、模拟 DS provider 与 Mem 后端，验证并行检索、源去重、降级保留、实际正文回执、混合阅读预算、进展、维护及恢复。不消费真实 DS 额度，不唤醒在线鱼会话，不向在线知识库写测试数据。

发布需同时加载宿主插件的新专用工具/观察器和 MCP 新接口，只重连 MCP 不足以接收网页回执。真实 DS 账号的搜索与阅读仍需在用户要求发布后，通过正常业务回合核对真实回执。
