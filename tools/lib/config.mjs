// 统一配置层 —— 一个文件承载所有"属于使用者"的东西。
//
// 为什么要有它（2026-10-14 外部评审指出的最大架构缺口）：
//   在此之前，"个人化的东西"散在四处、形态还不一样 ——
//     ① `~/.bili-ai/quota.json`（额度/白名单，独立文件）
//     ② `~/.dsh/whale-night.config.json`（作息，独立文件）
//     ③ `whale-diary.md` 的叙事段落（偏好被 feed.mjs 解析 Markdown 提取 ✗ 脆弱）
//     ④ 代码里硬编码（历史昵称 SELF_NAMES ✗）
//   使用者的体验是"我得读源码才知道要改哪" ✗ —— 这不是模板，是作者的自用件。
//   现在：**填一个 `bili-whale.config.json` 就完成自定义** ✓，其余全是中性默认值。
//
// 查找顺序：$BILI_WHALE_CONFIG → ~/.dsh/bili-whale.config.json → 内置默认值（中性）
import fs from 'node:fs'
// ⚠️ 2026-10-21：configPath 必须 **import 进来** 才可用 ✗
//   `export { configPath } from './paths.mjs'` 只是再导出，不会创建本地绑定 →
//   下面 config() 里的 fs.readFileSync(configPath) 会拿到 undefined → 抛错 → 被 catch 吞掉
//   → 静默退回默认值（self / owner / quota / preferences 全部失效）✗ 实测踩到
import { configPath } from './paths.mjs'


export { configPath } from './paths.mjs'

import { DEFAULTS, mergeConfig } from './defaults.mjs'
export { DEFAULTS } from './defaults.mjs'

let cache = null
/** 读取合并后的配置（带缓存）。 */
export function config() {
  if (cache) return cache
  let user = {}
  try { user = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { /* 没配置就用默认 */ }
  cache = mergeConfig(DEFAULTS, user)
  cache.__hasUserFile = Object.keys(user).length > 0
  return cache
}
