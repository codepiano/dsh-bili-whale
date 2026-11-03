# 鱼自主选择正文工具

本规则取代此前“新正文必须固定 DS Fetch”的策略。鱼可以先用 `fish_fetch_backends` 查看配置，自行选择工具，失败后决定换后端或继续其他材料；程序不设后端优先级、不自动依次回退。状态机保留 `fish_web_fetch` 作为旧客户端的兼容 next_action，但 `agent_selects_fetch_tool=true` 和 `fetch_choices` 明确允许自主选择。

| 工具 | 选择 | 回执标识 |
|---|---|---|
| DSH 原生 `web_fetch` | DSH 当前设置的抓取能力 | dsh-native；原生工具没有证明子 provider 时明确标记未证明 |
| `fish_web_fetch` | 独立 DS Fetch API | deepseek-fetch-api |
| `fish_gateway_fetch` | backend=jina | common-mcp:jina |
| `fish_gateway_fetch` | backend=opencli | common-mcp:opencli |
| `fish_gateway_fetch` | backend=deepseek | common-mcp:deepseek |

OpenCLI 的支持范围、安装与登录前提沿 Web Fetch 的配置返回；configured 不代表登录或目标可读。OpenCLI 问题页的摘要限制、各后端完整性提示与截断标记会随回执保留。网关适配读取服务器私有 COMMON_MCP_ENV_FILE（默认既有 common-mcp 的 .runtime/http.env），通过本机固定业务 API 访问 Web Fetch，凭据不进入模型参数和输出。

失败后，鱼可在调用下一次 exploration_next 前换工具重试同 URL。最新尝试用于续步，之前失败证据仍在 feed_details 的 reads 中；已有正文优先继续交付。已经判定不适合作为材料并记录 failed progress 的阅读，可用 resource_retry 新建关联旧记录的明确重试。

原生工具的完整渲染正文沿真实宿主交付回执确认；精简抓取工具的正文归档后由 resource_read_page 逐页交付。搜索摘要、抓取成功元信息、挑战页、未读完或截断不能冒充已读。保留实际工具/provider、失败、源完整性提示、阅读与 Mem 回执；这不限制鱼选择哪种抓取能力。

## 2026-11-03 上线验收

- 全量354项通过，实际DSH Node24的28项针对性回归通过；两个新增工具的输入/输出通过宿主schema校验。
- 鱼在真实会话调用fish_fetch_backends，看到原生、独立DS、网关Jina/DeepSeek/OpenCLI五个选择，均已配置；OpenCLI登录未探测。
- 仅限定从三个旧失败链接中选一项，未指定具体链接或后端。鱼自主选择InfoQ，理由是内容值得阅读且旧工具只取得标题；选择fish_gateway_fetch(backend=jina)。
- 新cycle为retry-7ca034fba2db4bf0d6b12af2；read_id为4b6f32dc-ade9-4b6c-a578-54c9a6e191f4；真实回执provider=common-mcp:jina，provider_attempted=true，truncated=false，source_completeness=unverified及原警告均保留。
- 返回正文归档后2页全部交付；逐页拼接与归档正文一致。宿主交付through_seq=6112、ack host_seq=6113，reading_complete=true后记录completed progress。最终complete/reading_limit，成功预算1/1。
- Mem fish-web-33476d3720b8f9ed4607ca9cbeaf9983实际保存并再次读回，verified=true。鱼按来源维护概念，并保留页面是删减版实录、观点缺乏独立数据核验的限制。
- 本次只试一个目标；没有重新搜索、改URL或强制回退顺序，原先PyPI/CHANGELOG失败记录保留。未对平台评论、收藏、点赞、私信、转发或通知。
- 功能开发及测试在独立工作树完成。有一次依赖安装命令误落在线目录，已纠正；源码/锁文件未改变，当时宿主与MCP PID及启动时间未变。后续测试均在独立目录完成。发布阶段才按授权重载组件和MCP；最终真实回执证明在线功能可用。
