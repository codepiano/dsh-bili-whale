# 概念群目录与归属

目录是学习库已有概念群的索引，独立于 `concept_query` 的成员数量限制。查看目录不会修改数据，也不会把原有群或成员合并。

```sh
node tools/bili.mjs concept concept_catalog --json '{"subject":"fish","page":1,"limit":20}'
node tools/bili.mjs concept concept_catalog --json '{"query":"可视化"}'
```

返回群 ID、主体、名称、别名、定义、归属边界、关联群、成员数和最多三个代表概念（含来源 ID）。按关键词查名称、别名、定义、边界和成员内容；这是字词检索，语义归属由模型判断，不宣称是向量搜索。`total/page/limit` 用于遍历目录。

旧群没有定义时返回 `metadata_status: needs_definition`，定义与边界为 null。代表概念直接来自现有已接受成员，不能把它们当成完整的领域定义。此版本不批量生成旧群定义或重分组，也不把历史相近群自动合并。

## 自动学习如何归类

1. 普通后台学习任务先保存 `learning.catalog_prepared`，记录本次确实提供给模型的目录快照。
2. 模型请求携带 `source` 和 `catalog`。目录包括同主体可用群的紧凑名称/别名索引，以及按原文词语相关性选出的最多 12 群详情。user 来源也提供 fish 目录以支持已有的表达模仿规则，主体不可混用。
3. 已有群使用 `{collection_id, reason}`。没有合适群才使用 `{name, definition, boundary, aliases, related, reason}` 新建。一个概念可关联最多三个群，每个归属分别给出理由。无法判断则 deferred。
4. 系统检查 ID 来自本次目录且主体正确，新群名/别名不能与已显示的同主体已有名称或别名重复。写入事务还会检查最新状态中的名称/别名冲突。规范化匹配统一 NFKC、大小写及分隔符；语义近义仍需模型对照目录判断。
5. `collection.placement_decided` 保存成员、群 ID、join/create、理由和原始来源。`learning.request` 归档实际目录和请求，`learning.response` 保存模型输出；原成员、来源和历史版本保留。

名称索引上限 24 KB，详情上限 24 KB。索引未全部展示时显式返回 `truncated: true` 与真实总数，禁止本次任务新建群；可复用已展示群或暂缓。前台 AI 可用分页工具继续查目录，不能把未显示的旧群当成新领域。

任务重试复用已保存的目录；已验证结果在重启后继续幂等应用。历史已验证任务保留旧名称回放兼容，新评估不再接受单纯字符串群名。

## 补充旧群定义

`concept_catalog_update` 接受 `key`、`collection_id`、`definition`、`boundary`、`aliases`、`related`、`source_ids` 和 `reason`。必须引用本群成员已有的来源，关联群必须同主体，别名不能抢占其他群已有名称或别名。更新保存独立事件和状态版本，不改成员、原文、奖励或曝光。

前台 `concept_review` 支持用 `collection_id` 复用群。旧调用的 name 参数仍兼容，名称或别名匹配时复用 ID；已有同名歧义必须明确用 ID。新定义只在创建新群时写入，旧群定义需要显式调用更新工具，避免每次归类顺便覆盖领域边界。

## 验证范围

隔离测试覆盖目录分页与旧群保真、别名检索与冲突、主体隔离、来源约束、普通后台学习到原生 LLM 请求的目录传递、按 ID 复用、新群定义与归属回执、目录截断保护、重启持久化及历史任务恢复。语义路由测试使用可控模型响应证明协议与落库行为；不能据此声称真实模型对所有同义概念都能正确归类。
