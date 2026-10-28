# 字幕优先与按需补充

日常流程为 `debrief_read → video_read_page → exploration_progress`。默认取得元信息和平台字幕，优先人工中文轨，再选 AI 中文轨；有字幕不下载音视频、不取封面、弹幕或热评。原有选题竞争和问题线保持不变。

字幕接口成功但无有效正文时，才尝试已有本地 `whisper-cli`：只下载 DASH 音轨，分为最多 240 秒的片段转写，拼回原视频时间轴。网络或风控失败不触发额外媒体请求。未安装引擎、未下载模型、没有独立音轨、转写失败或空白时保留具体状态；仍无完整正文就继续其他材料。默认最多两小时音频、128 MiB 音轨和 25 分钟转写预算；不自动下载模型或上传云端。

## 按需入口

- `debrief_read({bvid,feed_run_id})`：字幕优先，缺字幕本地转写。
- `audio:"never"`：禁用音频兜底；`audio:"always"`：有必要核实口述时显式转写。成功后以转写作为这次阅读正文；原字幕读取及补充阅读来源都保留。
- `context:true`：明确需要观众反应时补封面、弹幕热区与热评。它们不混入视频正文概念学习来源。
- `video_read_frames({read_id,times:[35,92],reason:"核实图表刻度"})`：对已接收的真实阅读，取 1–6 个片内时间点，直接返回带时间的图片。不再全片跑场景检测。此入口仍须下载一个可用的视频流，设 512 MiB / 180 秒上限；不会默认每条视频抽帧。

CLI 对应：

```sh
node tools/bili.mjs debrief <BV>
node tools/bili.mjs debrief <BV> --audio never
node tools/bili.mjs debrief <BV> --audio always --feed-run-id <本轮ID>
node tools/bili.mjs debrief <BV> --context
node tools/bili.mjs debrief <BV> --frames   # 显式使用旧九宫格
```

`--no-frames` 兼容保留；不传任何画面选项时默认不抽帧。`--substrip` 显式使用旧抽样字幕条，不能当作整片台词。

## 本地工具配置

默认从 PATH 找 `whisper-cli`，模型为 `~/.cache/whisper.cpp/ggml-base.bin`。可用环境变量 `BILI_WHISPER_BIN`、`BILI_WHISPER_MODEL` 覆盖；模型也兼容 `FFMPEG_SKILL_ASR_MODEL`。设置文件可选添加：

```json
{"reading":{"audio":{"enabled":true,"executable":"/absolute/path/whisper-cli","model":"/absolute/path/ggml-base.bin"}}}
```

这是部署者配置，业务 MCP 不接受任意命令或文件路径。FFmpeg 复用现有定位机制。相同音频哈希、模型哈希、时长与分段策略复用本地转写缓存；换模型或音频会形成新版本，转写缓存和阅读证据只写入当前 DSH_HOME。下载音轨、WAV 分片和临时视频在结束/失败后清理。

## 真实阅读与来源

平台字幕继续用 `kind=subtitles`；本地转写用 `kind=audio_transcript`，来源保留 BV、CID、原时间轴、正文版本、whisper.cpp、模型文件名及 SHA-256、原音轨 SHA-256、分段长度。相同文字的字幕和转写、不同模型版本拥有不同来源 ID。

取得材料仍只记 acquired。宿主接收真实工具结果后记 presented；有 feed 关联的字幕和转写都必须按页实际返回完整正文，DeepSeek 还需提供方 delivery-accepted 覆盖正文，才完成真实阅读并允许计曝光/入队学习。伪造、截断、漏页或跨会话回执不能通过。完整读完表示正文已交付，不表示识别无误、观点属实或看过全片。

转写页采用 `bili.video_text_page.v1`，事件为 `video.transcript_page_presented` / `video.transcript_read_completed`；旧字幕页与事件保持兼容。先读字幕再补音频时，来源合入同一决策的 supplements，不重复计曝光。图片单独记录 `video.frames_acquired`，包括理由、时间点、文件哈希、存档及原材料哈希，不自动冒充图片已读或写成字幕学习来源。

火山引擎调查见 [VOLCENGINE-ASR.md](VOLCENGINE-ASR.md)。本次只调研云端服务，未开通、购买、配置凭据或接入付费调用。

## 本次隔离验证

在独立开发工作树安装独立依赖；自动测试以临时 HOME、DSH_HOME、观察库、模拟 HTTP 和模拟媒体程序验证，不向在线账号或真实学习库写入。全量串行回归 272/272 通过；已有跨进程节流计时测试在并行负载下曾抖动，单独复查及串行全量均通过，未修改该实现。回归覆盖默认请求精简、人工字幕优先、缺字幕音频兜底、禁用/失败路径、分段时间轴、缓存、转写来源、逐页交付门槛、补充阅读不重复计曝光及图片原生工具结果。

另外，以临时合成的 3.867 秒英文语音实跑本机 whisper.cpp/base，正确取得带时间转写；以临时 4 秒、640×360 视频实跑指定时间点取帧，得到两个 1280×720 JPEG，检查了图片像素与原生 image 内容块。观察页构建通过。未测试真实 B 站音轨下载、真实视频的识别准确率、DSH 会话实际接图或火山付费调用；未进行移动端测试。

在线 main 工作目录未改动，原 DSH 进程启动时间未变，HTTP 监听仍在（无认证请求返回 401）。没有为验证重启、停止或刷新用户服务/页面。新功能按约定只提交到开发分支，未合入 main 或发布。
