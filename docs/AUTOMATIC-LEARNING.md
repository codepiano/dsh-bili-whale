# 宿主自动学习：第一阶段

本文描述自动入队、回合结束后评估、每次模型调用前准备学习上下文。后续的 feed 选题接入见 [概念群与兴趣竞争](FEED-INTEREST-COMPETITION.md)。收藏、发送和 persona.md 修改仍不由本阶段自动执行。开发代码不代表已经安装或运行。

## 配置

```json
{
  "conceptSystem": {
    "observe": true,
    "learning": true,
    "mode": "active",
    "renderBudget": 400
  }
}
```

observe 默认 false，learning 默认 true，mode 默认 shadow。首次启用 observe 需要在正式交付后重新加载插件，本次开发不操作正在运行的宿主。observe=true 且 learning=true 才自动入队和调用模型。learning=false 暂停入队、后台处理及动态上下文准备，保留已有队列。已启动的单次评估可能先返回并保存证据，但不会继续应用候选。重新启用后恢复处理。

shadow 会评估、保存候选和概念群并记录候选上下文，但不把动态素材交给日常模型；active 才实际注入。该开关控制输入影响，不表示后台评估免费或完全不更新学习状态。

## 自动触发路径

1. **接收经历**：只跟踪鱼的专用会话、恢复的当前会话及本进程轮换出的会话。`session/event` 收到直接用户消息或模型实际发表的正文后，将脱敏来源写入 SQLite 的 `learning_jobs`，状态为 pending。同一会话和来源 ID 去重；源 ID 重用而内容不同会报错。一次来源最多取前 8000 字，完整会话事件仍由观察记录保存。
2. **外部主人消息**：私信监听器和评论监听器把已收到的主人原话独立传给投递入口。私信回执、评论 kind/id 用于去重；调度器包装的操作指令不作为主人原话。直播命中目前只有截断混合输出，暂不从中学习；未实现视频工具输出自动入队或全历史导入。
3. **回合结束**：`turn/end` 将该会话待评估来源置为 ready，后台工作器自动唤起。若宿主中断而没有观察到回合结束，pending 来源等该会话下次回合结束后处理；不会凭计时猜测一个回合已完成。
4. **独立评估**：通过 DSH 的 `llm.prepareCall` 使用该会话已观察到的 provider/model 路由；没有路由时保留任务，不猜模型、不消耗重试次数。评估不使用 `sessionController.prompt`，不进入日常聊天历史，不提供工具，不触发外部动作。单次超时 45 秒、最大输出 3000 tokens、最多六个候选。记录返回正文、服务实际返回的推理及路由证据；没有返回的推理无法补录。
5. **校验并应用**：严格校验 JSON、字段、数量、主体、来源原文引用及收录条件。提及可进入话题集合，但不推断喜欢或认同；非明确证据不能收录为 belief/motive；否定、引用、不确定只能暂缓或拒绝。主人用语可成为鱼的模仿表达，主人兴趣不能因此变成鱼的兴趣。校验后的结果先持久保存，再以稳定幂等键逐项调用共享的 propose/review 核心，创建概念状态版本。模型不能自行传入来源 ID、奖励或文件操作。
6. **每次调用前**：`system-prompt/assemble` 在正常模型调用及工具续轮之前重新读取最新概念状态，分别渲染关于鱼和关于主人的素材，明确主体区别，并保存 `personal_rendered` 版本。active 时提供带有独立名称和 `interpolate:false` 的动态 context；shadow 只记录。由 DSH 原生 `RuntimeContextProjection` 负责生成、保留和去重上下文快照，不往 pre-step 的消息数组里额外塞消息，也不修改磁盘人格文件。它不受“每会话只注入一次人设”影响。

`learning.context_prepared` 只表示组装候选，不声称模型已经收到。`agent/pre-step` 只记录版本、turn/step 和待提交的原生上下文消息 ID，原样返回宿主决策；`session/event` 观察到宿主真正写入 runtime-context 后，才记录 `learning.context_admitted`。后续未变化的上下文由宿主保留，不重复产生入场事件。原生快照会进入会话历史，并声明取代早期快照；本阶段不删除旧历史。

预算在鱼和主人之间分配；低于 200 字时优先鱼的素材。主体说明标签另占少量字符。当前使用 general 场景，没有语义相关性检索或自动场景分类。同一次 assembly 中只保留一个同名学习 context；文本不变时原生投影不追加快照，避免把“新素材”误当成一直有新消息而让回合无法结束。早期版本曾写入调度消息的学习段不会被改写或删除。

## 持久性与失败处理

- `learning_jobs` 是 schema 1 内的附加表，与事件、概念状态共用 observations.sqlite3，快照对象仍独立保存；旧只读观察页保持兼容。队列写入和对应事件在同一事务中完成。
- 工作器单进程串行；SQLite 事务领取任务并保存 90 秒租约，跨进程不能同时正常领取同一任务。仅处理本宿主跟踪的会话。到期后可恢复，旧租约持有者不能提交完成状态。
- 每次唤起最多处理四条来源；后台每 30 秒检查可处理任务。失败按 30、60 秒退避，最多尝试三次，之后保留 failed 任务和错误事件；本阶段没有手工重试界面。
- 已验证评估先保存，应用中断后复用同一结果，propose/review 的幂等回执避免重复增加概念证据。程序不把重复处理当成新经历。
- 模型未正常结束、输出截断、调用工具、无效 JSON、虚构原文引用均不能进入学习状态。上下文准备失败会记录错误并让日常模型沿用原输入，避免阻塞正常对话；取消信号继续向上抛出。
- 关闭插件会注销钩子和重试定时器，取消评估调用。没有恢复已执行外部动作的逻辑，因为本阶段不执行任何外部动作。

## 观察与验收

现有观察页的事件列表可查询 `learning.enqueued`、`learning.ready`、`learning.started`、`learning.request`、`learning.response`、`learning.validated`、`learning.applying`、`learning.completed`、`learning.retry`、`learning.failed`、`learning.context_prepared`、`learning.context_step`、`learning.context_admitted` 和 `learning.context_failed`。概念群与关键文件版本页继续使用同一套数据。记录决策过程摘要、来源和实际可用的推理，不声称能证明因果影响。

自动化测试使用临时 SQLite、模拟宿主事件和模拟模型流，覆盖从消息到学习、从学习到每次调用输入的闭环，以及租约、重试、恢复、来源排除和模式隔离。验证不读取真实聊天内容、不调用真实模型、不发送 B 站消息。未发布前不宣称真实会话端到端验收完成。

`tests/helpers/learning-host-contract.mjs` 可在独立 Electron Node 进程中加载本机安装包的原生 Cordis 和 SystemPrompt，验证事件接入、assembly/refresh/render、字面量上下文、会话隔离及空消息终止条件。通过 `BILI_DSH_ASAR` 指定安装包路径；它仅使用临时学习库和模拟评估，不连接正在运行的宿主或真实模型。
