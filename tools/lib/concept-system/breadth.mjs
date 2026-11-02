// Old records remain intact. Classification affects exploration eligibility only.
export function interestEligibility(member, state, collection) {
  if (member.interest_role === 'method') return {eligible:false,reason:'explicit_method_record'};
  const text=member.content??'',source=state.sources?.[member.source_id];
  const operational=/^(?:字幕为空|补标点|保存成功|工具调用|检索结果评估)$|^(在检索方法上|视频搜索的检索面|判断原问题在本次检索面|识别出未回答的问题|将未决问题定义|原问题.*未.*回答|区分.*(?:材料原文|原始文字稿))|已作为.*后续问题记录/;
  const methodGroup=/^(检索策略经验|评估自省|动机偏差|证据标准|视频工程证据判断)$/;
  if(member.interest_role!=='content'&&(operational.test(text)||(source?.actor==='fish'&&methodGroup.test(collection?.name??''))))return {eligible:false,reason:'legacy_operation_record'};
  return {eligible:true,reason:member.interest_role==='content'?'explicit_content_topic':'content_topic'};
}
// Explicit catalog metadata wins; conservative legacy hints are visible and can
// be corrected through the sourced catalog API. Unknown groups share one bucket.
export function collectionDomain(c) {
  if(c?.domain)return {name:c.domain,origin:'catalog'};
  const text=`${c?.name??''} ${c?.definition??''}`;
  const hints=[['软件与工程',/软件|开发|编程|代码|引擎|three\.js|godot|开源|可视化|网站|部署|AI.*工具/i],['历史与社会',/历史|国家|社会|政治/],['商业与经济',/经济|付费|商业|市场|消费|企业经营/],['哲学与认知',/哲学|心智|范畴|虚无|意义|现代性|牵挂|中介|论证|可供性|问题区分/],['自然科学',/物理|化学|生物|天文|地质|生态/],['艺术与文化',/艺术|音乐|绘画|文学|电影/]];
  const match=hints.find(([,re])=>re.test(c?.name??''))??hints.find(([,re])=>re.test(text));return {name:match?.[0]??'未分类',origin:match?'legacy_metadata_hint':'unknown'};
}
export function questionDomain(q,c) {
  return collectionDomain({...c,definition:`${q?.question??''} ${c?.definition??''}`}).name;
}
export function readingDomain(state,decision) {
  const x=decision.exploration,c=state.collections[x?.target?.collection_id];
  return x?.target?.question_id?questionDomain(state.exploration?.questions?.[x.target.question_id]??x.target_snapshot,c):collectionDomain(c).name;
}
export function readingHistory(state,subject='fish') {
  return Object.values(state.decisions??{}).filter(d=>d.subject===subject&&d.exploration?.exposure&&d.exploration.progress?.outcome!=='failed').sort((a,b)=>b.exploration.exposure.at-a.exploration.exposure.at||a.id.localeCompare(b.id));
}
export function readingDomains(state,decision) {
  const x=decision.exploration;
  if(x?.domain&&x.domain!=="未分类")return [x.domain];
  if(x?.target?.candidate_id){const id=x.target.candidate_id;const placed=Object.values(state.collections??{}).filter(c=>!c.archived_at&&c.members.includes(id));if(placed.length)return [...new Set(placed.map(c=>collectionDomain(c).name))]}
  const ids=x?.target?.collection_id?[x.target.collection_id]:decision.collection_ids??[];
  return x?.target?.question_id?[readingDomain(state,decision)]:[...new Set(ids.map(id=>collectionDomain(state.collections[id]).name))];
}
export function breadthSnapshot(state,subject='fish',limit=40) {
  const history=readingHistory(state,subject).slice(0,limit),domains=Object.create(null);
  for(const c of Object.values(state.collections??{}))if(c.subject===subject&&!c.archived_at&&c.members.some(id=>{const m=state.members[id];return m?.status==='accepted'&&m.tags.includes('topic')&&interestEligibility(m,state,c).eligible})){const d=collectionDomain(c);domains[d.name]??={domain:d.name,count:0,last_read_at:null};}
  for(const d of history)for(const name of readingDomains(state,d)) {const row=domains[name]??={domain:name,count:0,last_read_at:null};row.count++;row.last_read_at=Math.max(row.last_read_at??0,d.exploration.exposure.at);}
  const ranked=Object.values(domains).sort((a,b)=>a.count-b.count||(a.last_read_at??0)-(b.last_read_at??0)||a.domain.localeCompare(b.domain));
  return {policy:'domain-breadth-v1',window:limit,actual_reads:history.length,domains:ranked};
}
export function readingPenalty(state,c,now) {
  const domain=collectionDomain(c).name;
  const recent=readingHistory(state,c.subject).slice(0,12);
  const hits=recent.filter(d=>readingDomains(state,d).includes(domain));
  const pressure=hits.reduce((sum,d)=>sum+2**(-Math.max(0,now-d.exploration.exposure.at)/(24*3600000)),0);
  return {domain,reads:hits.length,factor:1/(1+pressure),reason:'实际完整阅读后的领域降权；失败和仅选入清单不计'};
}
export function readingFatigue(c,scene,now,p) {
  const scenes=['feed','watch'].includes(scene)?['feed','watch']: [scene];
  return Math.max(0,...scenes.map(key=>{const f=c.fatigue?.[key];return f?f.value*2**(-Math.max(0,now-f.at)/p.fatigueHalfLifeMs):0}));
}
