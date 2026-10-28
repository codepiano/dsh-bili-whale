import { hash } from './store.mjs'

// Identity matching is deliberately narrower than semantic similarity. Synonyms
// require an explicit alias or a model judgment against the directory.
export const catalogName = name => name.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}\s]/gu, '')
const names = c => [c.name, ...(c.aliases ?? [])]
export function matchingCollections(state, subject, name) {
  const key = catalogName(name)
  if(!key)throw Error('Collection name/alias must contain letters or numbers')
  return Object.values(state.collections ?? {}).filter(c => c.subject === subject && names(c).some(n => catalogName(n) === key))
}
function entry(state, c) {
  const members = c.members.map(id => state.members?.[id]).filter(m => m?.status === 'accepted')
  return {
    id:c.id, subject:c.subject, name:c.name, aliases:c.aliases ?? [],
    definition:c.definition ?? null, boundary:c.boundary ?? null,
    metadata_status:c.definition ? 'documented' : 'needs_definition',
    related:c.related ?? [], member_count:members.length,
    representatives:members.slice().sort((a,b)=>a.id.localeCompare(b.id)).slice(0,3).map(m=>({id:m.id,content:m.content.slice(0,400),tags:m.tags,source_id:m.source_id})),
    metadata_evidence:c.metadata_evidence ?? null,
  }
}
const tokens = text => {
  const normalized=text.normalize('NFKC').toLowerCase()
  const words=normalized.match(/[a-z0-9]{2,}/g) ?? []
  for(const run of normalized.match(/[\p{Script=Han}]+/gu) ?? [])for(let i=0;i<run.length-1;i++)words.push(run.slice(i,i+2))
  return [...new Set(words)]
}
function rank(state,c,query) {
  const text=[...names(c),c.definition ?? '',c.boundary ?? '',...c.members.map(id=>state.members?.[id]?.content ?? '')].join(' ').normalize('NFKC').toLowerCase()
  return tokens(query).reduce((n,t)=>n+(text.includes(t)?1:0),0)
}
export function catalogQuery(state,{subject,query='',page=1,limit=20}={}) {
  const all=Object.values(state.collections ?? {}).filter(c=>!subject||c.subject===subject)
    .map(c=>({c,score:query?rank(state,c,query):0}))
    .filter(row=>!query||row.score>0)
    .sort((a,b)=>b.score-a.score||a.c.id.localeCompare(b.c.id))
  return {state_version:hash(state),total:all.length,page,limit,items:all.slice((page-1)*limit,page*limit).map(({c})=>entry(state,c))}
}
// Every visible name is available for semantic routing, with detailed evidence
// for the lexical shortlist. A bounded/incomplete inventory never licenses new
// groups: the caller must defer instead of claiming there is no suitable group.
export function learningCatalog(state,source) {
  const subjects=source.actor==='user'?['user','fish']:['fish']
  const groups=Object.values(state.collections ?? {}).filter(c=>subjects.includes(c.subject)).sort((a,b)=>a.id.localeCompare(b.id))
  const inventory=[];let bytes=0
  for(const c of groups) {
    const row={id:c.id,subject:c.subject,name:c.name,aliases:c.aliases ?? []}
    const size=Buffer.byteLength(JSON.stringify(row))
    if(bytes+size>24000)break
    inventory.push(row);bytes+=size
  }
  const visible=new Set(inventory.map(c=>c.id))
  const details=[];let detailBytes=0
  for(const {c} of groups.filter(c=>visible.has(c.id)).map(c=>({c,score:rank(state,c,source.excerpt)}))
    .sort((a,b)=>b.score-a.score||a.c.id.localeCompare(b.c.id))) {
    const row=entry(state,c),size=Buffer.byteLength(JSON.stringify(row))
    if(details.length>=12||detailBytes+size>24000)break
    details.push(row);detailBytes+=size
  }
  return {policy:'catalog-v1',state_version:hash(state),subjects,total:groups.length,truncated:inventory.length<groups.length,inventory,details}
}
export function applyCatalogMetadata(state,c,spec,{source_ids,reason,at}) {
  for(const alias of [c.name,...(spec.aliases ?? [])]) {
    const collisions=matchingCollections(state,c.subject,alias).filter(other=>other.id!==c.id)
    if(collisions.length)throw Error('Collection name/alias already belongs to '+collisions.map(c=>c.id).join(','))
  }
  for(const id of spec.related ?? []) {
    if(!Object.hasOwn(state.collections,id)||state.collections[id].subject!==c.subject||id===c.id)throw Error('Invalid related collection')
  }
  for(const id of source_ids) {
    if(!c.members.some(mid=>state.members[mid]?.source_id===id))throw Error('Catalog evidence must belong to the collection')
  }
  c.definition=spec.definition;c.boundary=spec.boundary
  c.aliases=[...new Set(spec.aliases ?? [])]
  c.related=[...new Set([...(c.related ?? []),...(spec.related ?? [])])]
  c.metadata_evidence={source_ids:[...new Set(source_ids)],reason,at}
  return c
}
