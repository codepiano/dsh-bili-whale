import fs from 'node:fs'
import crypto from 'node:crypto'

// One versioned skill is used by the fish workspace and its existing auxiliary
// learner. No global skill registry or independent schedule is introduced.
const document=fs.readFileSync(new URL('../skills/fish-concept-maintenance/SKILL.md',import.meta.url),'utf8')
export const conceptMaintenanceSkill=Object.freeze({
  name:'fish-concept-maintenance',
  hash:crypto.createHash('sha256').update(document).digest('hex'),
  content:document.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim(),
})
