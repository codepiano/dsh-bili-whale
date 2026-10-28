# 火山引擎音频转写调研

核对日期：2026-10-28。当前应比较「豆包录音文件识别模型 2.0」，避免把历史大模型标准版的 2.3 元/小时当成新版价格。

| 计费 | 官方价格 | 本项目含义 |
| --- | --- | --- |
| 2.0 按量后付费 | 0.8 元/音频小时 | 10 分钟约 0.133 元，30 分钟约 0.4 元 |
| 2.0 30 小时资源包 | 23 元，有效期一年 | 折合约 0.77 元/小时，个人量级先按量即可 |

来源：[豆包语音官方计费说明](https://docs.volcengine.com/docs/doubao-voice/billing-instructions?lang=zh)。以上只计算识别费，不含可能的文件存储、网络与其他模型费用；不是对当前账号优惠或权益的确认。

标准版资源 ID 为 `volc.seedasr.auc`，支持不超过 512 MB、5 小时的录音文件。调用为异步 submit/query，文档说明通常在 3 小时内完成；不能按极速版「30 分钟音频约 10 秒」来承诺 2.0 标准版延迟。接口文档要求 `audio.url`，需要服务端可访问的音频链接；本机回环文件不可直接访问。

新版鉴权使用 `X-Api-Key`，另带 `X-Api-Resource-Id`、`X-Api-Request-Id`；提交使用固定 `X-Api-Sequence: -1`。查询开启 `show_utterances` 后可取分句文本与时间信息，适合接入现有有时间轴的阅读来源。

官方接口：[任务提交](https://docs.volcengine.com/docs/DoubaoVoice/task-submission-http-1?lang=zh)、[结果查询](https://docs.volcengine.com/docs/DoubaoVoice/result-query-http-1?lang=en)、[模型对比](https://docs.volcengine.com/docs/DoubaoVoice/model-list?lang=zh)。

建议：当前先以本地 whisper 兜底。云端 2.0 可以作为后续可选异步提供方：持久化任务 ID、提交参数指纹、状态、查询重试与最终原文；提交状态不明时恢复查询而不是重复收费提交。取回完整转写后仍须沿用真实正文交付、来源哈希与独立转写类型，不能把任务受理算作已读。音频访问可使用短期对象存储链接，不将 B 站账号 Cookie 或账号签名媒体 URL 传给第三方。

本次未调用火山识别接口、未采购资源包，也未将音频上传云端。服务的真实识别质量、账号权限及实际延迟尚未实测。
