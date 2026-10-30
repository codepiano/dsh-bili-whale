# 鱼的阅读后技能与知识库

专属 skill 源文件在 `skills/fish-concept-maintenance/SKILL.md`。部署时仅复制到鱼的 cwd 下 `.agents/skills/fish-concept-maintenance/SKILL.md`，不安装到 Codex/DSH 全局目录。后台学习直接加载同一版本，响应回执记录 skill 名称和内容 SHA256。

概念群服务决策、兴趣、探索目标与归属；Nowledge Mem 是知识库，保存具体读了什么、内容总结、鱼自己的理解/想法与待查问题。日记是生活/反思记录，既不替代知识库，也不把第三方观点直接变成主人偏好或 persona。

沿用现有流程：实际视频正文全部页交付 → 阅读完成 → 当前鱼会话装配专属 skill 和待保存 read_id → 鱼写总结 → video_knowledge_save → nmem 稳定 ID 写入并实际读回 → knowledge.saved 与 memory_id。不新增每日定时任务或自我唤醒消息。概念提取/归属仍在既有回合后学习队列处理，具有来源、理由与版本。

`video_knowledge_save` 接受 read_id、summary、thoughts、questions、quotes[{source_id,quote}]。要求真实 reading_complete、未截断的字幕/转写与原文连续引句，拒绝仅简介、未读完或未送达材料。保存正文标明作者材料主张、鱼的理解和疑问，保留视频链接、BV/CID、正文种类和版本及阅读/来源 ID。视频总结语义由鱼负责；原文引句的存在、真实阅读门槛和存储一致性由代码核验。

`video_knowledge_get` 从 Nowledge Mem 实际读回该内容版本的知识记录。ID 由视频/CID/材料种类/内容哈希确定，重试不会另建副本。成功读回且正文与请求一致才写 saved 回执；网络或格式错误保留 pending 和原草稿哈希，不假报成功。恢复时用原草稿重试。原始完整草稿保存在私有请求对象中供查证；本地仅保存控制状态与审计，知识正文的使用入口是 Mem。

专属上下文仅供已跟踪、active 且启用学习的鱼会话；无待保存实际阅读时不插入。上下文缺失时先重新读取真实 read_id 的正文，不能凭标题补写总结。平台只读限制不阻止保存自己的知识记录；仍遵循用户本轮明确限制。
