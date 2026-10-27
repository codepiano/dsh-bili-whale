// 宿主、调度器与 CLI 共用的默认配置；此模块不读取文件或启动服务。
/** 中性默认值：不含任何作者的个人信息，换个人也能跑。 */
export const RISK_DEFAULTS = { minGapMs: 1500, readHourly: 600, readDaily: 3000, writeHourly: 12, writeDaily: 30, writeGapSec: 120, dmGapSec: 60 }

export const DEFAULTS = {
  conceptSystem: { observe: false, learning: true, mode: 'shadow', renderBudget: 400 },
  sessionRotateDays: 0,
  personaOncePerSession: false,
  risk: RISK_DEFAULTS,
  persona: {
    name: '',
    ownerTitle: '你',      // 助手怎么称呼使用者
    selfClaim: '我',       // 助手怎么自称
    diaryTitle: '今日摘要', // diary show 的标题（想用自己的口吻就改这里）
  },
  preferences: {
    like: ['AI 工具与插件', '鬼畜与怀旧向剪辑', '猫咪', 'Live2D/模型'],
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
    keywords: [],
  },
  notify: { type: 'none', url: '', template: 'text', cmd: '' },   // none | desktop | webhook | command | dm | stdout | file
  aliases: [],                  // 历史昵称（兜底用；当前昵称仍从 nav 动态读）
  // 使用者本人（分享型评论要 @ 的人）：mid 用于白名单/查询，name 用于正文里的 @昵称
  // （acc/info 查询会风控，所以 name 缓存一份；改过就用 thread 的 `@到:` 验一下）
  owner: { mid: '', name: '' },
  self: { mid: '', name: '' },
  diary: { push: true, enabled: true },
  toolsPath: '',
  quota: { shareDaily: 3 },
  // 「标尺」（2026-10-18 加）：分享前必须打分，不到 share.minScore 就是"今天没有值得发的"（合法结果）
  share: { aiCommentGuard: false, aiThreshold: 30, enabled: true, via: 'comment', minScore: 13, silentAfterDays: 3 },  // 分享型（@主人）开关与评分阈值
  // 评论默认关；私信默认开，每 60 秒检查一次；同一人 30 天内只回复一次。
  listen: { comment: false, commentIntervalSec: 60, scope: 'both', oncePerPerson: true, allDay: false, dm: true, dmIntervalSec: 60, live: false, liveRoom: '', liveScope: 'owner' },
  // 作息：windows[] = 每天允许醒来的时段（每个窗口 = 一次机会）；maxWakesPerDay 缺省 = 窗口数（计划器上限 12）
  night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0.3, minGapMin: 10, maxVideos: 5 },
}

// 每次合并都返回独立对象，避免设置校验或调用方修改共享默认值。
export function mergeConfig(base, over) {
  const out = structuredClone(base)
  for (const [key, value] of Object.entries(over || {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeConfig(base[key] ?? {}, value)
      : structuredClone(value)
  }
  return out
}
