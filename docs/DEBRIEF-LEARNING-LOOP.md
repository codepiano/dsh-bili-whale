# debrief 的读取回执与学习回流

当前日常读取已切为[字幕优先与按需补充](SUBTITLE-FIRST-READING.md)：默认只取元信息/字幕，缺字幕时尝试speech 服务云端转写；context、画面均显式按需。下文旧 subtitle 专属表述的正文交付门槛同样适用于 audio_transcript，转写保留独立来源类型。

本阶段连接 `feed → debrief 材料 → 会话接收 → 回合后评估 → 概念群 → 下一轮 feed`。记录可验证的材料取得和概念评估，不把脚本取回字幕、备好图片等同于模型看完或看懂整条视频。

## 自动运行

沿用 `conceptSystem.observe`、`learning` 与 `mode`。observe=true 时，debrief 将读取尝试和材料快照写入观察库；观察关闭时保留原来备素材的行为，不创建学习数据库。learning=true 时，已接收的视频来源在回合结束后由已有宿主工作器自动评估。shadow 仍会学习但不改变 feed 的实际清单或日常上下文；active 才采用这些学习结果。

正常调用不需要新 skill 或主人逐次提醒：

```sh
node tools/bili.mjs debrief BV1234567890 --no-frames
```

命令成功备齐当次可用材料后，输出包含随机本地读取 ID 与材料哈希的 `BILI_DEBRIEF_RECEIPT`。鱼会话的 `tool/result` 自动识别回执，从同一观察库验证材料和来源对象，再绑定真实 session/trace，写入持久队列。不会从用户消息、模型发言、失败工具结果或其他会话中接收回执，也不使用回执文本传来的来源正文、模型路由或任意文件路径。未知 ID、哈希不符和已绑定到其他会话的回执不能导入来源。

仅在命令行手工运行时，也会有材料记录，但没有宿主会话接收回执就不自动选一个会话、不猜测模型路由，也不启动模型。完整自动回流发生在 DSH 的鱼会话工具执行路径。输出被截断而丢失回执时，材料保留 acquired 状态，不伪装成已接收。

## 读取的实际含义

SQLite 中保存 `video_reads` 与 `video_read_jobs`，材料正文和来源快照继续按内容哈希独立存放。阶段依次为：

| 阶段 | 依据 | 不表示 |
|---|---|---|
| started | 脚本开始一次有效 BV 读取尝试 | 网络或材料成功 |
| acquired | 可用材料与来源对象已经落盘 | 模型已接收、已看完 |
| presented | 真实鱼会话的成功工具结果引用了可验证回执 | 主模型已逐字读完字幕或看过图片 |
| assessed | 这次来源的全部文本分段通过概念评估 | 整片观看、事实核验、喜欢或奖励 |
| failed | 元信息/流程失败等可捕获错误 | 取得有效正文 |

材料 kind 单独区分 subtitles、audio_transcript、description、none。仅有标题、简介或图片路径不能冒充字幕正文。subtitle 接口、封面、评论或抽帧的失败与缺失分别保留；封面失败不阻止已经取得的字幕入库。中途终止且没有完成回执的尝试可保持 started，不自动补成成功。

新的 feed 会排除 kind=subtitles 且已经 presented/assessed 的 BV，即“字幕材料已取得并被鱼会话引用”。description-only、无文本、失败和未绑定回执不进入这个排除集合。原 feed run-id 的重试仍恢复原清单，以支持同一轮继续浅读/深读，不重新计算清单或额外增加选题疲劳。

## 视频内容的提取与来源

优先从有效字幕正文提取来源；没有取得字幕时可从简介形成降级线索。标题、UP 名、弹幕和评论不混入“视频正文”学习来源。记录字幕轨语言及是否 AI 轨、时间范围、有效行数、各材料通道状态、截断信息和产物路径。旧九宫格只记录产物；video_read_frames 则直接返回指定时间点图片，另存图片哈希、理由与原 read_id。生成图片不自动声称模型已看懂；纯画面语义不自动写成字幕学习来源。

文本来源每段最多 8000 字符、最多 24 段，总上限 192000 字符。字幕规范化最多保留 50000 行、每行 4000 字符，丢弃无效时间或空行；超限裁剪明确标记，不声称覆盖全文。每个来源带有固定的 actor=third_party、type=video、BV、CID、材料种类、分段信息和内容版本哈希，quote 必须存在于实际脱敏来源中。

评估仍使用 DSH 已有的无工具模型调用和严格输出校验。视频来源只允许为 fish 提出 topic/word/phrase/idiom/sentence_pattern。accepted 只能作为 mention 的接触线索；引用、否定、不确定可以暂缓或拒绝。第三方视频不能直接变成鱼的 belief/motive、明确喜欢、主人兴趣或事实核验结果。随后通过共享 propose/review 核心创建待评估概念、记录评估结果与 concept_state 版本；收录的话题可参加下一轮兴趣竞争，表达类素材可参与动态上下文。

同一 BV/CID、同一种正文和内容版本的来源 ID 稳定，重复浅读、深读及重试复用同一会话的队列任务，不重复增添概念证据或重新调用评估。正文变动会形成新版本；同视频不同分段及版本共用粗来源 ref，不能伪装成许多独立视频来抬高集合权重。读取或评估成功均不增加奖励。

长视频可保持部分评估状态：每批工作器最多处理四条来源，只有所有分段 done 才标记 assessed。评估失败、格式不合法或越过第三方收录边界时，按原队列规则退避重试，失败分段与已完成分段数都有记录，不虚报完成。

## 与选题关联及暂停恢复

```sh
node tools/bili.mjs debrief BV1234567890 --no-frames --feed-run-id nightly-example
```

显式提供 feed-run-id 时，代码验证该 BV 确实在该轮实际清单中，并关联对应决策；影子建议不充当实际采用结果。夜间调度已经把持久化作息计划的稳定 ID 同时放进 feed 与后续 debrief 命令，不要求主人临时提醒。没有这个参数的手工读取仍可回流，但不会按时间猜测属于哪轮选题。

learning=false 时仍记录材料取得和工具回执接收，不启动评估。恢复后，在该鱼会话的下次 turn/end 自动补入尚未排队的来源，然后继续既有持久队列。存储失败或对象完整性失败会回滚接收和入队，不把未验证文本交给模型；重试可以恢复。

## 观察与验证

现有事件/证据页面可查看 `video.read_started`、`video.material_acquired`、`video.material_presented`、`video.assessment_progress`、`video.assessed`、`video.read_failed` 和 `video.receipt_rejected`。明确关联选题的读取事件携带 decision_id，连接选题分数、实际材料和后续评估；source.video 与材料哈希保留进一步检查所需信息。

```sh
node tools/bili.mjs observe events '{"type":"video.material_presented","limit":50}'
node tools/bili.mjs observe events '{"type":"video.assessed","limit":50}'
```

测试使用临时数据库、假视频和被完全拦截的 HTTP 请求，覆盖实际 debrief CLI、回执接入、回合后评估、概念加入、下轮选题、重复来源、失败/空内容、分段和暂停恢复。不访问真实 B 站、真实模型或正在运行的用户数据；本阶段未做真实观看或图像理解验收。
