# 网页与仓库页面探索

鱼在原有 `exploration_next` 周期内选择来源，不改变 deep/revisit/discover 比例、相关度门槛或三轮上限。`feed_search_plan` 的可选 `source` 为 `bilibili` 或 `web`，省略时保留原 B 站行为。需要文档、文章、论文页面、仓库 README、issue 或 commit 的原文证据时可以选择 web，而不是继续用视频搜索替代原始材料。

```json
{"run_id":"状态机给定run_id","key":"本次规划键","source":"web","queries":["项目升级 返工工时 issue"],"reason":"问题需要带提交与问题记录的原始证据"}
```

## 使用 DSH 已有工具

网页请求由会话中的原生 `web_search({queries})` / `web_fetch({url})` 执行，沿用宿主选择的 provider、账号身份、超时及网络限制。本插件不复制 DeepSeek 凭据、不自行选择或更改搜索端点，也不把任意 shell 命令当搜索接口。

已检查的安装版 DSH 提供两条 DeepSeek 搜索实现：

- `@deepseek-ai/dsh-web-search-deepseek`，provider `deepseek-official`：通过 Anthropic Messages 原生 `web_search_20250305` 搜索。安装版基础配置选择此搜索 provider。
- `@deepseek-ai/dsh-web-deepseek-api`：独立 Search / Fetch API，provider 分别为 `deepseek-search-api`、`deepseek-fetch-api`，默认 `https://api.deepseek.com/v1/tools/search` / `fetch`。支持宿主 DeepSeek 账号身份或原有 API key 配置。

安装版同时注册独立 API adapter，不代表当前搜索使用它；是否能成功调用仍以宿主本次真实返回为准。无需为鱼新增搜索 key。当前安装版基础配置的网页抓取 provider 为 `http`，本功能同样复用它，不自动切换到 DeepSeek Fetch API。用户以后调整宿主 provider 后，鱼继续使用同一组原生工具。

## 自动流程与证据

1. `exploration_next` 返回 `web_search_required`，鱼执行原生 `web_search`。宿主只为鱼的跟踪会话、精确匹配待执行查询的真实工具结果归档最多 8 个候选。搜索摘要不计阅读或曝光。
2. 返回 `resource_judgment_required`，鱼用 `resource_assess` 逐条评估 URL。逐字引文必须来自该候选标题/摘要，完整覆盖所有立场；相关度低于 0.5 不选。程序沿用原有评分、疲劳与探索校验选入阅读清单，数量不超过原周期预算。无关结果允许全部拒绝。
3. 返回 `resource_read_required`，鱼执行原生 `web_fetch`。只接收被选 URL 对应的真实原生结果，记录请求 URL、最终 URL、正文版本、工具 call ID 和 session ID。非 2xx、空正文、有效输出截断或超限均为失败，不计曝光，继续其它候选或下一轮。
4. 实际抓取返回的渲染正文须匹配宿主原生工具消息；DeepSeek 会话还须等正常 provider 接收回执覆盖正文的宿主序号，才把 `web-...` 来源加入概念库并计曝光。搜索摘要、模型自行提交的正文、HTTP 成功以及不相干会话的回执均不能替代。
5. 重启中断发生在正文归档后、消息交付前时，状态机返回 `resource_read_page`，从原版本逐页恢复，全部页交付后才完成阅读，不重新抓取。已读页面也可用它按页重读。
6. `exploration_progress` 仅可引用本次真实网页来源，更新原问题的回答、缺口与下一步。revisit 仍需在原集合创建有来源的后续问题。阅读后分别完成概念查重/维护和 `resource_knowledge_save` / `resource_knowledge_get` 的 Mem 保存读回；Mem 以 URL 与内容版本幂等存储。

默认返回只携带当前步骤。需要完整网页候选、判断、选择依据或读取状态时，沿返回指针用 `feed_details({run_id,stage:"web",section:"candidates",offset,limit})`（其它 section 为 `assessments`、`decisions`、`reads`） 分页读取；实际正文重读仍用 `resource_read_page`。

`resource_unavailable` 用于原生工具未注册等无法执行的情况，明确标为调用者报告，不伪装成 provider 结果，也不计已读；仍沿用原三轮预算。网页分支不会自动评论、收藏、推送、登录其它站点或发送消息。

正文来源范围是“这次实际交付的页面渲染内容”。读取 README 不代表读完整个仓库，读取论文介绍页不代表读完论文 PDF；作者主张也不等于独立核验。第三方网页只能成为鱼的接触话题或表达，不能直接成为个人信念、动机或主人的偏好。其它文档格式可如实留下未完成项，不假称已读。

## 验证边界

发布时需要同时加载宿主插件的新 `tools/result` 观察器与概念 MCP 的新接口；只重连 MCP 不足以接收原生网页回执。开发验证不以更新在线插件或唤醒鱼作为测试手段。

自动测试使用独立 SQLite、临时数据、模拟原生工具结果和 Mem 后端，覆盖搜索、评分、正文交付、进展、概念维护、Mem 读回、断点恢复及失败路径。它们不消费真实 DeepSeek 搜索额度、不触发在线鱼会话，也不对在线知识库执行测试写入。真实账号搜索与阅读的验收需在用户要求发布后，通过正常业务回合核对真实回执。
