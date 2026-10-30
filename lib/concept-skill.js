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

// Native filesystem discovery can be disabled. This lifecycle-owned provider
// exposes exactly one skill, and only for the fish's configured workspace.
export function registerFishConceptSkill(skills,getCwd) {
  const matches=options=>typeof options?.cwd==='string'&&options.cwd===getCwd()
  const candidate={name:conceptMaintenanceSkill.name,description:document.match(/^description: (.+)$/m)[1],provider:'bili-whale-reading',source:'bundled',rank:100,invocation:{modelInvocable:true,userInvocable:true},resourceBase:{kind:'directory',path:new URL('../skills/fish-concept-maintenance/',import.meta.url).pathname},path:new URL('../skills/fish-concept-maintenance/SKILL.md',import.meta.url).pathname}
  return skills.registerProvider(()=>({name:'bili-whale-reading',list:async options=>matches(options)?[candidate]:[],get:async(_candidate,options)=>matches(options)?{...candidate,content:conceptMaintenanceSkill.content}:undefined}))
}
