# 基于真实经历的 persona 自主修订

仅在概念系统 observe/learning 开启、mode=active、conceptSystem.personaRevision=true 时自动工作。默认 personaRevision=true，observe 默认关闭；可在共享配置中将 personaRevision 设为 false 停止自动修改，无须扩大会话文件权限。此次更新不修改其他角色、配置权限、旧 pref、已归档会话或任意路径。

## 触发与证据

宿主空闲时每 30 秒检查一次已完成学习来源，正常回合结束后也会检查。首次可反思当前绑定会话最近 20 条已完成来源；更早记录原样保留，记录有界回顾的来源清单，不按旧记录倒序反复修改。之后没有新来源不重复推理；有新经历时可带入最近两条已处理的鱼反思作为交叉支持，不把它们重新记为新经历。明确的用户反馈可单条支持修订；鱼自己的反思需要至少两条内容不同的真实来源。字幕可作接触背景，但不能独自变成人格、喜好或事实背书。常见验收包装被排除，模型还需排除工具统计、测试口令及普通业务任务。

辅助模型调用无工具，与前台会话分离。它收到当前 persona 原文/哈希和具体来源，返回最多三处局部修订、每处理由、原文引文和 source_id；也可返回空修改。不为验收成功强制产生改动。语义上是否值得固化仍由模型判断，机械校验并不证明每项判断都正确。

## 落盘、版本与冲突

宿主只写固定 ~/.bili-ai/persona.md。来源引文必须逐字存在；替换片段必须恰好匹配一次，新段落不能重复。每次保存完整前后快照、局部差异、原因、来源和反思请求/响应。文件上限 20000 字，含被识别为凭据的内容时拒绝自动处理，不悄悄用脱敏文本覆盖原文件。

写入使用固定文件锁、原文哈希比较、SQLite prepared 记录、原子文件替换和 applied 记录。崩溃后根据前后哈希恢复；遇到无法识别的外部修改保留现场并记录冲突。设置页保存使用同一文件锁。并发反思有持久租约；推理期间开始的前台回合会延后应用，已验证结果保留，停机取消未完成请求。无修改的反思不生成文件版本。三次失败后保留失败记录，等待新来源再评估。history 同时列出已耗尽反思；修复推理协议后可用 persona_revision_retry 携带 attempt_id、expected_hash、reason，将原始已完成来源重新排队。保留 retry_of 与旧失败，不重置计数、不添加伪造经历、不接受指定修改文本。

```sh
node tools/bili.mjs concept persona_revision_history --json '{"limit":20}'
node tools/bili.mjs concept persona_revision_rollback --json '{"revision_id":"修订ID","expected_hash":"history 返回的当前哈希","reason":"恢复此前的表达方式"}'
```

回滚恢复该次修订之前的完整 persona，同时新增 rollback 版本，保留原修订及证据；expected_hash 防止覆盖查询后发生的修改。

## 后续实际注入

调度消息仍读取最新文件。同时每次原生请求组装加入独立的 bili-whale-persona-context，明确取代旧版，包含实际文件哈希。这样直接对话也能收到改动，不必等下次定时唤醒。该注入不作为新的学习来源，不形成自我学习循环。

persona.context_prepared 仅说明生成候选上下文；原生 runtime-context 接纳后记录 admitted。DeepSeek 提供方 delivery-accepted 的 throughSeq 覆盖接纳序号后才记录 persona.context_delivered。回执包含修订 ID、文件哈希及实际宿主序号。其他提供方没有这项明确确认时不声称已得到等价送达证据。
