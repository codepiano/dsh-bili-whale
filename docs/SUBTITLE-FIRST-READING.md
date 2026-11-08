# 字幕优先与按需补充

日常先取元信息及平台字幕，优先人工中文轨。有完整字幕时不取音轨、画面、弹幕或热评。没有字幕时调用 common-mcp 的 speech 服务，经豆包云端转写。插件不启动任何本地语音模型，只流式传输压缩音轨并计算校验和，不转换 WAV、不进行本机推理，失败也不回退本地识别。

## 语音服务连接

speech 同时提供 MCP 和原生 HTTP API，本插件使用后者：

- `GET /api/backends`：确认选定后端已配置、处理位置为 cloud 且支持时间戳。
- `POST /api/audio-uploads`：按稳定 clientRequestId、实际字节数和 Base64 MD5 预留私有 TOS 上传。按返回的表单直接流式上传，凭据不落日志或状态文件。
- `POST /api/transcriptions`：按稳定 clientRequestId 和 uploadId 提交；可能产生云端识别费。
- `GET /api/transcriptions/:id`：查询原任务，取统一毫秒时间戳和原文。
- `POST /api/transcriptions/:id/wait`：每次至多等待25秒；超时返回同一任务，后续继续恢复。

默认地址 `http://127.0.0.1:4325/api/`、后端 `doubao`。在共享的 bili-whale.config.json 中配置凭据文件引用，不复制或输出服务 token：

```json
{
  "reading": {
    "audio": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:4325/api/",
      "provider": "doubao",
      "envFile": "/absolute/path/common-mcp/services/speech-service/.runtime/service.env"
    }
  }
}
```

也支持 `BILI_SPEECH_API_URL`、`BILI_SPEECH_TOKEN`（或 SPEECH_SERVICE_TOKEN）、`BILI_SPEECH_ENV_FILE`。envFile 只读取 SPEECH_SERVICE_TOKEN，不执行文件。豆包 API Key 留在 speech 服务。远端 HTTP 不允许传输凭据，远端部署须使用 HTTPS。旧 model/executable/Whisper 环境变量不再生效。

## 异步读取与恢复

字幕接口成功但没有正文时才自动补音频；网络/风控失败不额外请求媒体。先确认云端后端及 uploads 均已配置，再取独立 AAC 音轨，以流式下载保存到当前 DSH_HOME/speech-tasks，最多128MiB。不解码、不加载语音模型、不把整段音频读入内存。B站Cookie仅用于平台访问，不传给speech、TOS或豆包。

本机流式计算MD5和SHA-256，向speech申请上传预留，以磁盘支持的Blob直接发multipart表单到私有TOS。使用uploadId提交识别，不将B站签名直链交给第三方。上传确认后立即删除本机临时音轨；云端终态清理由speech负责，24小时过期及TOS一天生命周期兜底由服务自身管理。

同一BV/CID、服务和提供商拥有稳定身份；上传预留和转写提交分别有固定clientRequestId。本机私有状态文件（目录700，文件600）仅保存稳定请求参数、上传/任务ID及音频SHA-256，不保存TOS上传签名或B站音轨直链。上传未确认时保留压缩音轨并复用原上传预留；转写提交响应丢失时复用原uploadId和原提交身份。服务已绑定任务时直接恢复其taskId，不重新上传或另行收费提交。上传预留关闭/冲突时明确失败并清理本机文件，不自动换ID。

`debrief_read` 遇到排队任务返回 pending read_id，本地记录 `video.audio_pending`。状态机要求 `video_audio_status({read_id})` 查询同一任务。相邻调用至少间隔30秒，每次由服务最多等待25秒；可结束回合，下一次作息优先恢复未完成的原 cycle。不会同步阻塞几小时，也不循环空转。完成后生成原 read_id 的材料回执，模型仍须通过 video_read_page 实际接收完整正文；任务受理、状态查询、下载或路径均不算已读。

静音、失败、缺时间戳或分句未覆盖全文均不能冒充完整阅读。配置/查询暂时不可用时保留任务现场；重复查询已取得材料只返回相同回执，不重交任务。原始正文和时间轴保留，字幕与 audio_transcript 来源 ID 独立；云端来源保存服务名、提供商、任务 ID、资源版本、上传ID及实际音轨SHA-256。旧URL任务仅为恢复原身份而兼容，其URL哈希不会冒充音频字节哈希。历史 whisper.cpp 来源 schema 仅为兼容旧记录，已删除本地推理实现。

## 按需补充

- `debrief_read({bvid,feed_run_id?})`：字幕优先，缺字幕使用 speech 云端转写。独立读取可省略 feed_run_id；提供时仍校验视频确实属于该轮清单。
- `audio:"never"` 禁用音频；`audio:"always"` 明确需要核实口述时使用同一 speech 入口。
- `context:true` 才取封面、弹幕和热评，不混入视频正文学习来源。
- `video_read_frames({read_id,times:[35,92],reason:"核实图表刻度"})`：仅按需取1–6个片内时间点，直接返回图片；保留BV、CID、时间、图片哈希及原阅读关联。仍须下载视频流，512MiB/180秒上限，无全片场景检测，不把生成图片当作模型已看懂。

CLI 支持 `debrief <BV> [--audio auto|never|always] [--context] [--frames] [--feed-run-id ID]`。旧九宫格/硬字幕条只在显式 --frames/--substrip 时启用，--no-frames 兼容保留。

## 独立 CLI 读取与入库

观察开关开启时，CLI `debrief <BV>` 不需要 feed slate 就会生成真实材料回执，并明确输出 `read_id` 和正文页数；MCP `debrief_read` 同样返回 `read_id`。feed 关联只用于追溯选题，不是阅读或入库的前提。

独立读取与 cycle 读取使用相同的逐页交付门槛：鱼会话的成功工具结果接收材料回执后，用 `video_read_page({read_id,page})` 接收全部正文页；DeepSeek 路由还须由宿主确认正文送达模型。之后 `video_knowledge_save` 校验原文引文、写入 Mem 并读回验证。取得字幕文件或仅看到回执不能直接入库；简介、截断材料、未送达正文继续拒收。独立读取不伪造 feed 决策或探索曝光。

手工在会话外运行 CLI 只取得材料，不自动绑定会话。应将原始命令输出作为鱼会话的真实工具结果交付，或在鱼会话中调用不带 feed_run_id 的 `debrief_read`；不编造编号或送达记录。历史材料不自动改写为已读，也不需要等未来搜索再次选中后才能重新读取入库。

## 验证边界

2026-11-09 独立 debrief 入库修复：独立工作树与依赖、临时用户目录/数据库、拦截网络和模拟 Mem 写入/读回下，Node 26 全量 367 项通过；宿主 Node 24 的 debrief、MCP、正文送达与知识保存相关 39 项通过。覆盖无 feed 的真实 CLI/MCP 调用、多页正文、未送达拒收、保存读回及幂等；未向真实 Mem 写入测试内容。

使用独立开发工作树、独立依赖、临时 HOME/DSH_HOME/数据库及模拟媒体与语音API验证，不写真实学习库。全量串行回归298/298通过，观察页构建通过。覆盖MD5/字节数、流式表单上传、凭据隔离、本机文件清理、云端提交、未知受理恢复、稳定身份、节流、任务完成回流、正文交付、来源追溯及后续作息恢复；缺配置/云端失败不会执行本地模型。

真实 speech 原生 `/api/backends` 返回200，报告 doubao 已配置、cloud、volc.seedasr.auc，uploads.configured=true；这是连通与配置核对，不代表实际付费转写成功。本次没有真实云端提交、视频账号写入、在线服务重启或移动端验证。新功能只在开发分支提交，未合入main或发布。价格及接口调研见 [VOLCENGINE-ASR.md](VOLCENGINE-ASR.md)。
