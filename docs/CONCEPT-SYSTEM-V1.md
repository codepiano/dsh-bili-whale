# 概念系统第一版使用与验证

开发分支上的实现，不代表已安装或发布。观察、学习数据保存在 `~/.bili-ai/concept-system/`，可以用 `BILI_CONCEPT_HOME` 指向独立测试目录。不要把此目录放进公开仓库。

## 观察与版本

```bash
node tools/bili.mjs observe status
node tools/bili.mjs observe capture
node tools/bili.mjs observe events '{"type":"prompt.prepared","limit":20}'
node tools/bili.mjs observe versions persona
node tools/bili.mjs observe diff persona <旧版本ID> <新版本ID>
node tools/bili.mjs observe object <内容哈希>
```

`capture` 会读取固定范围的人设、personal、两本日记和白名单配置；不接受任意文件路径。对象在写入前脱敏，因此脱敏版本只用于观察，不能用于原样恢复凭据或宣称完整输入复现。`diff` 返回两个版本的内容与元数据，首版不提供自动恢复和外部动作重放。

宿主自动观察默认关闭。将配置中的 `conceptSystem.observe` 设为 `true`，在明确发布并重新加载插件后启用，首次采集当前版本，以后轮询关键文件并在提交提示时保存确定的人设输入。此开关在调度器启动时读取，修改后需要重新加载插件。它不改变现有账号和发送保护。

记录 `prompt.prepared` 与 `prompt.accepted`；后者只表示宿主接收。通过已安装 DSH 的 `session/event` 事件接口捕获新会话事件，只观察插件跟踪的会话。完全匹配的用户消息文本与已准备提示关联；其他用户消息创建独立 trace，无匹配时记录未关联状态。首版不补读整个旧会话，也不承诺跨重启恢复未完成 trace 的关联。

宿主保存的 assistant/message 及其中实际返回的 reasoning 内容会作为脱敏证据对象保存；可用的 request/header 和模型来源也保留在宿主事件中。没有事件接口或没有 reasoning 内容时，保留不可用标记，不能把简短决策理由冒充原始推理。显式导入响应也可以用 `observe response <JSON文件>`，必须提供能对应到 prepared 提示的 trace_id 与 session_id，并声明 reasoning_kind。

存储使用私有目录和内容哈希对象；单个原子替换的 `journal.json` 保存事件、版本清单与状态，同一跨进程锁串行化 CLI、MCP 和宿主写入。事务中断只可能留下尚未引用的内容对象，不会留下已更新学习状态却没有事件的部分提交。日志损坏时拒绝更新，不重建空白状态。首版面向本地低频使用，尚未分段压缩，事件量大时需要后续增加索引和归档。

关键文件检查覆盖删除和再次出现；一个轮询周期内发生且恢复原状的短暂编辑可能无法观测。人设、聊天、日记、原始推理均不进入项目 Git，默认也不向外上传。

## 验证边界

测试使用临时目录、模拟宿主及独立子进程；不访问真实 B 站接口、不改写真实人设、聊天和学习记录。宿主事件接口来自本机安装版本的源码，真实在线运行验收需等用户明确发布后完成。
