import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { DEFAULTS, RISK_DEFAULTS } from '../tools/lib/defaults.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-defaults-'))
const dshHome = path.join(home, '.dsh')
fs.mkdirSync(dshHome)
Object.assign(process.env, { HOME: home, USERPROFILE: home, DSH_HOME: dshHome,
  DSH_NODE: process.execPath, BILI_WHALE_CONFIG: path.join(dshHome, 'custom-config.json') })
// Mount the actual settings handlers without starting timers, sessions or network calls.
globalThis.setInterval = globalThis.setTimeout = () => ({})
globalThis.clearInterval = globalThis.clearTimeout = () => {}
globalThis.fetch = () => { throw Error('network forbidden in defaults tests') }
const { default: plugin } = await import('../lib/index.js')
const routes = new Map()
plugin.apply({ get: () => ({ requestRejection: () => null }),
  webServer: { register(r) { routes.set(r.path, r.handler); return () => {} } }, effect() {} })
test.after(() => fs.rmSync(home, { recursive: true, force: true }))
async function settings(method = 'GET', body = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = method; req.headers = { host: '127.0.0.1' }
    const res = { writeHead(code) { this.code = code }, end(text) {
      assert.equal(this.code, 200, text); resolve(JSON.parse(text).config)
    } }
    routes.get('/dsh-bili/api/settings')(req, res).catch(reject)
  })
}
function cliConfig() {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {config} from './tools/lib/config.mjs'; console.log(JSON.stringify(config()))"],
    { cwd: new URL('..', import.meta.url), env: process.env, encoding: 'utf8', timeout: 10000 })
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
test('fresh install: settings API and CLI return identical complete conservative defaults', async () => {
  const host = await settings()
  assert.deepEqual(host, cliConfig())
  assert.deepEqual(host, { ...DEFAULTS, __hasUserFile: false })
  assert.equal(host.listen.comment, false); assert.equal(host.listen.dm, true)
  assert.equal(host.listen.oncePerPerson, true); assert.equal(host.listen.dmIntervalSec, 60)
  assert.equal(host.persona.ownerTitle, '你'); assert.equal(host.persona.name, '')
  assert.deepEqual(host.risk, RISK_DEFAULTS)
  assert.equal(fs.existsSync(process.env.BILI_WHALE_CONFIG), false)
})
test('partial legacy config keeps explicit false/zero/empty values and unknown fields through save', async () => {
  const user = { listen: { dm: false, comment: true, oncePerPerson: false },
    persona: { ownerTitle: '朋友' }, preferences: { like: [] }, quota: { shareDaily: 0 },
    diary: { push: false }, risk: { dmGapSec: 0 }, customExtension: { keep: true } }
  fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify(user))
  assert.deepEqual(await settings(), cliConfig())
  const saved = await settings('POST', { sessionRotateDays: 2 })
  assert.deepEqual(saved, (({ __hasUserFile, ...cfg }) => cfg)(cliConfig()))
  assert.equal(saved.listen.dm, false); assert.equal(saved.listen.oncePerPerson, false)
  assert.equal(saved.listen.comment, true); assert.equal(saved.listen.dmIntervalSec, 60)
  assert.equal(saved.persona.ownerTitle, '朋友'); assert.deepEqual(saved.preferences.like, [])
  assert.equal(saved.risk.dmGapSec, 0); assert.equal(saved.diary.push, false)
  assert.equal(saved.quota.shareDaily, 0); assert.deepEqual(saved.customExtension, { keep: true })
  // Host POST validation and mutations of returned nested arrays must never leak into defaults.
  saved.night.windows[0].start = '01:00'
  fs.rmSync(process.env.BILI_WHALE_CONFIG)
  assert.equal((await settings()).night.maxWakesPerDay, undefined)
  assert.equal((await settings()).night.windows[0].start, '20:00')
  assert.deepEqual(await settings(), cliConfig())
})
test('shipped example is exactly the shared defaults, excluding explanatory notes', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../tools/templates/config.example.json', import.meta.url)))
  for (const key of Object.keys(example)) if (key.startsWith('_')) delete example[key]
  assert.deepEqual(example, DEFAULTS)
})
test('learning switch preserves false across host and CLI; non-boolean input is rejected before saving', async () => {
  const saved=await settings('POST',{conceptSystem:{learning:false}})
  assert.equal(saved.conceptSystem.learning,false)
  assert.deepEqual(saved.conceptSystem,cliConfig().conceptSystem)
  const before=fs.readFileSync(process.env.BILI_WHALE_CONFIG,'utf8')
  await new Promise((resolve,reject)=>{
    const req=Readable.from([Buffer.from(JSON.stringify({conceptSystem:{learning:'yes'}}))])
    req.method='POST';req.headers={host:'127.0.0.1'}
    const res={writeHead(code){this.code=code},end(text){assert.equal(this.code,400);assert.match(text,/learning/);resolve()}}
    routes.get('/dsh-bili/api/settings')(req,res).catch(reject)
  })
  assert.equal(fs.readFileSync(process.env.BILI_WHALE_CONFIG,'utf8'),before)
})
