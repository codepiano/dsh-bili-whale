import { DEFAULTS } from './defaults.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { DSH_HOME } from './paths.mjs'
export function readNightConfig(home = DSH_HOME) {
  let user = {}, legacy = {}
  try { user = JSON.parse(fs.readFileSync(process.env.BILI_WHALE_CONFIG || path.join(home, 'bili-whale.config.json'), 'utf8')).night ?? {} } catch {}
  try { legacy = JSON.parse(fs.readFileSync(path.join(home, 'whale-night.config.json'), 'utf8')) } catch {}
  return { ...structuredClone(DEFAULTS.night), ...user, ...legacy }
}
