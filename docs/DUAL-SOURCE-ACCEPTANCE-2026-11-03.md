# 双来源探索发布验收（2026-11-03）

## 发布内容

- 默认同一步并行执行 B 站检索与 DSH 已注册的 `deepseek-search-api`，不额外调用聊天模型；合并候选后统一评估相关度。
- 常规响应只提供当前动作与必要字段，候选/评估/原始结果按需由 `feed_details` 获取。CLI 等待管道 JSON 写完再退出，避免尾部丢失。
- 一个 cycle 按实际成功阅读预算继续；本次默认上限5条、最多3轮，不以第一条完成作为 complete 条件。
- 正文精确回执使用脱敏前的可信宿主事件；归档与学习仍只接收脱敏内容。中断后恢复首个缺页。
- 截断、抓取失败、明显短挑战页跳过；失败 progress 不更新问题进展，不消耗阅读配额。失败/跳过材料不再进入待写 Mem 队列，也不允许保存为有效阅读知识。

## 真实业务回执

原生鱼会话执行同一个 `night-dual-live-20261103-release1`，没有重开 cycle、指定主题/关键词/URL 或调整种子、权重与相关度门槛。验收期间发现回执和失败分支问题后暂停修复，再从同一 cycle 恢复；不是一次无中断运行。

三轮均使用 `deepseek-search-api`：每轮3次成功非空请求，共9次；每轮取得8条网页和8条 B 站候选，B站与DS状态均为 ok。统一候选池仅保留8条供评估，原结果单独归档，不表示搜索 API 响应被意外截断。

| 轮次 | 实际阅读 | 来源 | Mem ID（实际保存并读回校验） |
|---|---|---|---|
| 1 | datasea.cn/go0227513243.html | 网页 | fish-web-526abacef7fdfcf250c2f7ebc6d236ec |
| 1 | aiknowledge.cn/article/58575 | 网页 | fish-web-a7f60ec65b7202c8669598b7e4e23bcd |
| 1 | BV13MpCzjEa3 | B站字幕 | fish-video-f493a70ad6bc34803d985a6387d2ce19 |
| 2 | pi.dev/packages/pi-shepherd | 网页 | fish-web-3554f75a49f6ed91bbc66730065fe3e3 |
| 3 | lwn.net/Articles/1104255/ | 网页评论 | fish-web-0ee7b6700d80064ecbabb22276bf9aba |

5条存储记录均为 reading_complete=true、knowledge.status=saved；保存接口在写入后比较读回的来源身份、版本和完整内容，再记录 saved。每条阅读后实际执行概念维护，新增5个相关概念及后续问题。

最终：`status=complete`，`next_action=stop`，`reading_budget={limit:5,completed:5,remaining:0}`，`stop_reason=reading_limit`。第一条后剩余4条，继续同一轮；第一轮读完3条后自动进入第二、第三轮。

GitHub CHANGELOG 截断、PyPI Client Challenge、InfoQ仅标题等失败材料没有计入这5条，也未写入 Mem。阅读指实际交付的网页内容或完整字幕，不能据此声称观看视频、读完整站点/仓库或核验作者结论。鱼明确保留低可信文章及评论缺乏数据的限制。

验收仅对平台执行读取；正常本地概念维护和 Mem 保存已授权，未执行评论、收藏、点赞、私信、转发或通知。

## 验证与运行

- 开发、测试在独立工作树完成，临时数据与在线数据隔离。
- 回执修复后全量337项通过；后续完整338项检查有5项并发时序失败，涉及4个测试文件，降低并发串行复测44项全部通过。
- 失败分支回归23项通过；最后的失败材料 Mem 防护及网页/知识回归20项通过。
- main 已合入并通过原生组件重载、MCP worker重载交付。真实宿主持续运行；未为验证重启整个应用。
- 通用 Web Fetch 的 DS Search/Fetch 是 common-mcp 中另一个提交（ba637d4），已用独立回环网关验证真实 MCP/HTTP→CLI→DS API；尚未替换其线上发布快照，不混同为鱼本次发布。
