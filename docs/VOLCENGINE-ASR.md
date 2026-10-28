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

当前接入：视频读取通过 common-mcp 的 speech 服务原生 HTTP API（默认 `127.0.0.1:4325/api/`）使用豆包 2.0。插件不运行本地识别器、只流式下载/上传压缩音轨，不解码音轨。异步提交前持久化稳定请求身份，后续查询相同任务；提交状态不明时只以原始参数恢复同一身份，不另建付费任务。后端服务统一持有豆包凭据、任务和结果，插件只保存其访问凭据引用。

音频经过speech的TOS临时上传流程中转：申请带MD5/大小约束的签名表单，流式上传后以uploadId提交。B站Cookie仅用于取得压缩音轨，不向speech或豆包传递B站签名媒体链接。上传/任务ID和实际音轨SHA-256进入来源；TOS签名不记录到日志或普通状态文件。上传确认后删除本机临时音轨，云端清理由speech统一负责，不回退本地模型。

本次接入验证包含模拟任务与真实 `/api/backends` 只读请求（200，doubao / cloud / volc.seedasr.auc，uploads已配置）。未实际提交收费转写、未采购资源包。实际识别质量、B 站链接云端可达性及任务延迟尚未实测。
