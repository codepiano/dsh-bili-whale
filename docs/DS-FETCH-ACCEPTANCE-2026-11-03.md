# 固定 DS Fetch 上线与真实阅读验收（2026-11-03）

## 版本与实际调用路径

- `2ca1c8c`：鱼新增原生 `fish_web_fetch`，在发起工具调用的 agent 上下文中直接选择注册项 `deepseek-fetch-api`；不调用受全局设置影响的 `ctx.web.fetch()`，不回退其它 provider，不复制凭据。
- 抓取只渲染精简回执，正文单独归档，必须通过 `resource_read_page` 逐页交付。正文上限2 MB，最多256页，每页约8000字符，保留完整性与真实宿主交付确认。
- `resource_retry` 只允许重试已选且已归档的旧链接；新幂等键创建关联旧 run/decision 的单条 cycle，复用原候选判断，不重置历史 cycle、不重新搜索或评分。
- 每个成功或失败的归档读取记录 `fetch_receipt`：provider、provider_attempted、tool、call_id、可得的 api_status/error_code。可通过 `feed_details(stage=web, section=reads)` 查阅。
- `5f6e34b`：实际 DS 返回的 PyPI 挑战文本没有标题，补充按短提示正文识别，并在阅读曝光前拒绝。

## 三个指定链接的线上重试

鱼的真实原生工具均返回 `provider=deepseek-fetch-api`、`provider_attempted=true`，未回退 `web_fetch`。

| 链接 | DS API 状态 | 实际内容/结果 | 归档 read_id |
|---|---|---|---|
| PyPI gatehouse-crunchtools 0.7.0 | 200 | 209字符挑战提示；失败 progress，未计成功阅读或写 Mem | 9052ece6-2160-4ece-bf1a-cad9a0b7b905 |
| raw.githubusercontent.com/.../CHANGELOG.md（原固定提交） | 404 | WEB_PROVIDER_ERROR，无正文；保留失败回执 | 1eea9b5b-42ac-4bb4-9740-7c1f355a5e59 |
| InfoQ DTZRRtodmCvpfYwbpWbF（保留原始 tracking 查询） | 404 | WEB_PROVIDER_ERROR，无正文；保留失败回执 | 66443ca3-1d26-4ee0-b950-69dc56d142a8 |

404是 DS Fetch API 的状态，不能据此断言原网站本身404。InfoQ 原始 URL 含 `&amp;`，本轮按原归档地址重试，未测试去除查询或其它地址，不能归因于这一参数。

三个独立重试 cycle 均 `exhausted / max_rounds`，成功预算 `0/1`；没有 Mem 或新概念，也没有改变原已完成的夜间 cycle。

### 挑战页修复后的真实回归

PyPI 新幂等键再次重试：`read_id=be907a82-906d-4267-8a71-0a4d88837aca`，同样是 `deepseek-fetch-api`、attempted=true、API 200，但宿主在分页读取前记录 `status=failed`、`error_code=CHALLENGE_PAGE`、`reading_complete=false`。没有页面送达记录、曝光、成功配额或 Mem。旧的失败证据保留。

## 成功流程独立对照

原三个页面没有实际正文，因此另用此前已选的 `https://datasea.cn/go0227513243.html` 验证成功分支，不能算作那三个页面成功。

- cycle：`retry-871ca178aaa796c067050784`。
- read_id：`7ab3211d-62ba-49a4-a91a-d43a6799a142`。
- 实际 provider：`deepseek-fetch-api`，provider_attempted=true，api_status=200。
- 原生抓取返回14,381字符，未截断；2页依次实际交付，`pages_presented=[1,2]`，拼接内容逐字等于归档正文。
- 实际宿主交付确认：through_seq=6008，ack host_seq=6009；`reading_complete=true` 后才记录 completed progress。
- 执行来源支持的进展与概念查重维护，保留文章低可信、混用语言及指标缺乏独立核验的限制。
- Mem：`fish-web-b5f355fd229b7a7b2a04775fc3d20110`；写入后真实读回校验通过，knowledge.status=saved。
- 最终 `complete / reading_limit`，预算 completed=1、remaining=0。

这验证的是此次 API 返回的网页正文完整交付，不证明远端页面全部内容、作者结论正确、读完整个网站或仓库。平台操作仅读取；正常本地概念/Mem 写入获授权，未评论、收藏、点赞、私信、转发或通知。

## 其它网页效果补测

通过已上线 common-mcp HTTP → Web Fetch CLI → 官方 DS Fetch 执行。它与鱼的原生 provider 是两个入口，不能把这些结果冒充鱼的阅读回执。

| URL | 结果 | 返回字符数 | 本服务截断 |
|---|---|---:|---|
| https://github.com/modelcontextprotocol/servers | 200 | 10,086 | false |
| https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise | 200 | 18,663 | false |
| https://docs.python.org/3/tutorial/index.html | 200 | 2,310 | false |
| https://zh.wikipedia.org/wiki/测试驱动开发 | DS API 404 | 无正文 | — |

另有此前线上 MCP/HTTP 均成功获取 DS 官方 Fetch 文档页的回执（1977字符）。这里只是页面样本，不能推导整个站点的成功率；未截断表示本服务未裁剪，不保证来源完整或最新。

## 测试与发布操作

- 独立工作树、独立依赖/临时数据验证；原功能全量342项通过，实际 DSH Node24 与宿主 schema 校验通过。
- 合并当前 main 的其它已提交改动后，相关25项通过；短挑战页补丁及知识/广度回归32项通过。
- 经原生组件停用/启用和鱼 MCP worker 重载交付；宿主持续运行。上述真实回执核验了新工具注册、固定 provider、失败分支、分页交付、progress与Mem，而不是只检查端点可达。
