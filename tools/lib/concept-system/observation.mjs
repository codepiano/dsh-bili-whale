import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ObservationStore, hash, redact } from './store.mjs'
import { HOME, DSH_HOME, configPath } from '../paths.mjs'

export const CONFIG_FIELDS = ['persona', 'preferences', 'listen', 'night', 'share', 'quota', 'diary', 'sessionRotateDays', 'personaOncePerSession', 'conceptSystem']
export const observedPaths = () => ({ persona: path.join(HOME, '.bili-ai', 'persona.md'), personal: path.join(HOME, '.bili-ai', 'personal.json'), diary: path.join(DSH_HOME, 'whale-diary.md'), private_diary: path.join(DSH_HOME, 'whale-diary-private.md'), config: configPath })
export function readSource(role, file) {
  try {
    // No symlinks: a watched persona path must not become a credential-file alias.
    if (fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file)) throw Error('Symlinked observation source rejected')
    if (fs.statSync(file).size > 4 * 1024 * 1024) throw Error('Source exceeds 4 MiB capture limit')
    let content = fs.readFileSync(file, 'utf8')
    if (role === 'config') { const cfg = JSON.parse(content); content = Object.fromEntries(CONFIG_FIELDS.filter(k => Object.hasOwn(cfg, k)).map(k => [k, cfg[k]])) }
    return { role, status: 'present', content }
  } catch (e) { return { role, status: e.code === 'ENOENT' ? 'missing' : 'unreadable', error: e.code ?? 'CAPTURE_REJECTED' } }
}
export function runtimeManifest(root) {
  let commit = null, dirty = null
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    dirty = hash(execFileSync('git', ['diff', 'HEAD', '--', 'lib', 'tools'], { cwd: root, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {}
  return { commit, working_diff_hash: dirty, node: process.versions.node, electron: process.versions.electron ?? null, model: null, model_parameters: null, context_coverage: 'plugin_prepared_messages_only' }
}
export class Observer {
  constructor({ store = new ObservationStore(), paths = observedPaths(), runtime = {}, log = () => {} } = {}) { this.store = store; this.paths = paths; this.runtime = runtime; this.log = log }
  async capture(sources = Object.entries(this.paths).map(([role, file]) => readSource(role, file)), trace_id) {
    const versions = {}
    for (const s of sources) versions[s.role] = await this.store.snapshot(s.role, s.content, { status: s.status, trace_id })
    return versions
  }
  async prepare({ request, block, sources, included, previous }) {
    const trace_id = crypto.randomUUID(), links = { trace_id, session_id: request.sessionId, request_id: request.requestId ?? null }
    const versions = await this.capture(sources, trace_id)
    const prompt = this.store.object(request), persona = this.store.object(block)
    await this.store.event('prompt.prepared', { prompt, effective_persona: persona, included, previous_injection: included ? null : previous ?? null, versions, runtime: this.runtime, reasoning: { status: 'unavailable', reason: 'sessionController.prompt provides no response transcript' } }, links)
    return { ...links, effective_persona: persona.hash }
  }
  async accepted(trace) { await this.store.event('prompt.accepted', { scope: 'host_received_only' }, trace) }
  async failed(trace, error) { await this.store.event('prompt.failed', { status: 'unknown', error: String(error?.message ?? error) }, trace) }
  watch() {
    let tail = Promise.resolve(), stopped = false, running = false
    const previous = new Map()
    // watchFile establishes its initial stat asynchronously and can miss an
    // edit immediately after registration. Compare content snapshots instead;
    // unchanged polls perform no SQLite writes and failed captures retry.
    const poll = () => {
      if (stopped || running) return
      running = true
      tail = tail.then(async () => {
        const sources = Object.entries(this.paths).map(([role, file]) => readSource(role, file))
        const changed = sources.filter(s => previous.get(s.role) !== hash(s))
        if (changed.length) await this.capture(changed)
        for (const s of changed) previous.set(s.role, hash(s))
      }).catch(e => this.log('Observation capture failed: ' + e.message)).finally(() => { running = false })
    }
    const timer = setInterval(poll, 1000); timer.unref?.(); poll()
    return async () => { stopped = true; clearInterval(timer); await tail }
  }
  async response({ trace_id, session_id, turn_id = null, response_id = null, text, reasoning, reasoning_kind = 'unavailable', partial = false, source = 'explicit_import' }) {
    if (!trace_id || !session_id) throw Error('Explicit trace and session correlation required')
    const prepared = this.store.events({ trace_id, session_id, type: 'prompt.prepared' })
    if (!prepared.length) throw Error('No matching prepared prompt')
    if (!['provider_reasoning', 'host_summary', 'unavailable'].includes(reasoning_kind)) throw Error('Unknown reasoning kind')
    if (reasoning_kind === 'unavailable' && reasoning) throw Error('Reasoning content requires a declared provenance')
    const object = this.store.object({ text, reasoning: reasoning ?? null, reasoning_kind, partial, source })
    return this.store.event('response.completed', { object, reasoning_kind, partial, source, correlation: response_id ? 'explicit_response_id' : 'explicit_turn_or_trace_only' }, { trace_id, session_id, turn_id, response_id })
  }
}

// DSH session/event seam verified against the installed host. No history replay or
// private runtime access: capture only new events for explicitly tracked sessions.
export function attachSessionEvents(ctx, observer, initialSessionId, { onEvent = async () => {} } = {}) {
  const tracked = new Set([initialSessionId]), active = new Map()
  let tail = Promise.resolve()
  const originalPrepare = observer.prepare.bind(observer)
  const pending = new Map()
  observer.prepare = async input => {
    const trace = await originalPrepare(input)
    tracked.add(input.request.sessionId)
    const text = input.request.content?.filter(x => x.type === 'text').map(x => x.text).join('\n')
    const list = pending.get(input.request.sessionId) ?? []
    list.push({ trace, text }); pending.set(input.request.sessionId, list)
    return trace
  }
  const handler = (session, event) => {
    if (!tracked.has(session.id)) return
    const copy = structuredClone(event)
    tail = tail.then(async () => {
      const id = session.id
      let prepared = false
      if (copy.type === 'user/message') {
        const text = copy.data?.content?.filter(x => x.type === 'text').map(x => x.text).join('\n')
        const queue = pending.get(id) ?? [], index = queue.findIndex(p => p.text === text)
        if (index >= 0) { active.set(id, queue[index].trace); queue.splice(index, 1); prepared = true }
        else if (!copy.data?.source?.kind || copy.data.source.kind === 'user') active.set(id, { trace_id: crypto.randomUUID(), session_id: id, correlation: 'host_message_only' })
      }
      const links = active.get(id) ?? { session_id: id, trace_id: null, correlation: 'unlinked_host_event' }
      const object = observer.store.object(copy)
      await observer.store.event('host.session_event', { host_type: copy.type, host_seq: copy.seq, host_time: copy.time, object,
        reasoning_kind: copy.type === 'assistant/message' && copy.data?.message?.content?.some(b => b.type === 'reasoning') ? 'provider_reasoning' : null }, links)
      try { await onEvent(session, redact(copy), { ...links, prepared }) }
      finally { if (copy.type === 'turn/end') active.delete(id) }
    }).catch(e => observer.log('Host observation failed: ' + e.message))
  }
  const dispose = ctx.on?.('session/event', handler)
  return { track: id => tracked.add(id), stop: async () => { if (typeof dispose === 'function') dispose(); await tail } }
}
