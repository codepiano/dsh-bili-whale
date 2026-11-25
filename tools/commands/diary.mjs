// 「她的一天」—— 让主人看得见她做了什么（可见性层，2026-10-14 主人问"我怎么知道她做了什么"）
//
// 用法:
//   node diary.mjs show [--days 1]      人读摘要：今天看了什么 / 想了什么 / 发了什么 / 额度还剩多少
//   node diary.mjs log <kind> [--target X] [--note "…"]   记一条结构化事件到 ~/.dsh/whale-log.jsonl
//   node diary.mjs tail [--n 20]        最近的结构化事件
//
// 三个数据源（各司其职）：
//   ~/.dsh/whale-diary.md      叙事（她自己的话：看过的、想法池、谁回过她）—— 给人读
//   ~/.bili-ai/quota.json      发言账（每条对外发言，含"自主/主人授权"标记）—— 给闸门与审计用
//   ~/.dsh/whale-log.jsonl     事件流（看/想/发/被回… 结构化）—— 给程序与其他端用
//
// 关键约定（写进 AGENTS.md）：**自主发言之后必须主动通知主人**（notify_wechat），
// 因为"她自己决定的对外动作"必须让主人事后可见 —— 这是 B 档能成立的前提。
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'
import { indexDiary } from '../lib/diary-index.mjs'
import { beijingDay } from '../lib/observer-logs.mjs'
import { ObserverReader } from '../lib/concept-system/observer-read.mjs'
import { archivedReadings } from '../lib/observer-readings.mjs'
import { dshPath } from '../lib/paths.mjs'


const argv = process.argv.slice(2)
// 设置页的「日记总开关」真的生效（2026-10-18 修）：关掉就什么都不记
if (config().diary?.enabled === false) { console.log('（日记总开关关着 —— 这次不记）'); process.exit(0) }
const cmd = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true
  else if (!opt._a) opt._a = argv[i]
}
const HOME = (process.env.USERPROFILE || process.env.HOME || '/')
const DIARY = dshPath('whale-diary.md')
const QUOTA = path.join(HOME, '.bili-ai', 'quota.json')
const LOG = dshPath('whale-log.jsonl')
const today = () => beijingDay(new Date())
const hhmm = (iso) => String(iso).slice(11, 16)

if (cmd === 'log') {
  const kind = opt._a ?? 'event'
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind, target: opt.target ?? null, note: opt.note ?? null }) + '\n')
  console.log(`已记：${kind}${opt.target ? ' → ' + opt.target : ''}`)
  process.exit(0)
}

if (cmd === 'tail') {
  const n = Number(opt.n ?? 20)
  let lines = []
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean) } catch {}
  if (!lines.length) { console.log('（还没有事件记录）'); process.exit(0) }
  for (const l of lines.slice(-n)) {
    try { const e = JSON.parse(l); console.log(`  ${String(e.at).slice(0, 16).replace('T', ' ')}  ${e.kind}  ${e.target ?? ''}  ${e.note ?? ''}`) }
    catch { console.log('  ' + l) }
  }
  process.exit(0)
}

if (cmd === 'show' || !cmd) {
  const days = Number(opt.days ?? 1)
  if (!Number.isSafeInteger(days) || days < 1 || days > 36500) {
    console.error('--days 需要 1 至 36500 的整数'); process.exit(1)
  }
  const since = beijingDay(new Date(Date.now() - (days - 1) * 86400000))
  const title = config().persona?.diaryTitle ?? '今日摘要'
  console.log(`════════ ${title}（${since} ~ ${today()}）════════\n`)

  // ① 叙事部分：解析日记
  let text = ''
  try { text = fs.readFileSync(DIARY, 'utf8') } catch { console.log(`（读不到日记 ${DIARY}）`) }
  const reader = new ObserverReader()
  const archived = reader.use(db => archivedReadings(db, reader.store, {since, until:today()}), null)
  const entries = indexDiary(text).filter(entry => !entry.key || (entry.key >= since && entry.key <= today()))
  const seen = []
  const thoughts = []
  for (const entry of entries) {
    let section = ''
    for (const line of entry.content.split(/\r?\n/)) {
      if (/^#{1,2}\s/.test(line)) { section = line.replace(/^#+\s+/, ''); continue }
      if (section.includes('想说') && line.trim() && !/^(?:-\s*)?（空/.test(line.trim())) {
        thoughts.push({day:entry.key, text:line.trim().replace(/^-\s*/, '')})
      }
      if (archived === null && section.includes('看过') && line.startsWith('|')) {
        const cells = line.replace(/^\||\|$/g,'').split('|').map(s => s.trim())
        const day = cells[0].match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]
        if (day && day >= since && day <= today()) seen.push({day,title:cells[2],description:cells[3],thought:cells[4]})
      }
    }
  }
  const readings = archived ?? seen
  console.log(`【看过 ${readings.length} 条】`)
  for (const item of readings.sort((a,b) => (b.at ?? b.day).localeCompare(a.at ?? a.day))) {
    console.log(`  · ${item.title}  ${item.day} ${item.description ?? ''}`)
    if (item.thought) console.log('      她的想法：' + item.thought)
  }
  console.log(`\n【想说但还没说 ${thoughts.length} 条】`)
  for (const item of thoughts) console.log('  · ' + (item.day ? item.day + ' ' : '') + item.text)

  // ② 发言账（她真的对外说了什么）
  console.log('\n【对外发言（今天）】')
  try {
    const q = JSON.parse(fs.readFileSync(QUOTA, 'utf8'))
    // 2026-10-21 修（外部审计 #8）：账本里的 at 是 UTC ISO 串，直接 startsWith(本地日期)
    //   会把凌晨 0–8 点的发言算到"昨天"✗（quota.mjs 早就修过同一个坑，这里漏了）
    //   统一先把时间戳转成本地日期再比 ✓
    const dayOf = (at) => new Date(at).toLocaleDateString('sv-SE')
    const todayLog = (q.log ?? []).filter((x) => dayOf(x.at) === today())
    const auto = todayLog.filter((x) => x.auto).length
    // q.daily 早就不写盘了（save() 只持久化 {log}）→ 显示 undefined 会误导 ✗
    const dailyCap = Number(q.daily ?? q.shareDaily ?? 0)
    console.log(`  共 ${todayLog.length} 条（自主 ${auto}${dailyCap ? '/' + dailyCap : ''}，主人授权 ${todayLog.length - auto}）` + (dailyCap ? '' : ' · 自主发言不设条数上限 ✓'))
    for (const x of todayLog) console.log(`  · ${hhmm(x.at)}  ${x.type}${x.auto ? '（自主）' : ''}  ${x.target ?? ''}  ${x.note ?? ''}`)
    if (!todayLog.length) console.log('  （今天一条都没发）✓')
  } catch { console.log('  （还没有发言记录 —— 发第一条时 `quota record` 会自动建 quota.json）✓') }

  // ③ 事件流
  console.log('\n【最近事件】')
  let lines = []
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean) } catch {}
  if (!lines.length) console.log('  （还没有事件记录 —— `diary log` 会往这里写）')
  for (const l of lines.slice(-6)) {
    try { const e = JSON.parse(l); console.log(`  · ${String(e.at).slice(5, 16).replace('T', ' ')}  ${e.kind}  ${e.target ?? ''}  ${e.note ?? ''}`) } catch {}
  }
  console.log('\n（她是主动来找你的：自主发言后必须 notify_wechat —— 见 AGENTS.md「日子」一节）')
  process.exit(0)
}

console.log('用法: node diary.mjs show [--days 1] | log <kind> [--target X] [--note "…"] | tail [--n 20]')
