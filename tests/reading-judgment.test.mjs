import test from 'node:test'
import assert from 'node:assert/strict'
import { readingOption } from '../tools/lib/concept-system/reading-judgment.mjs'

test('a topic or a reused fact cannot multiply stance credit; an independent, grounded objection survives', () => {
  const material = '历史唯物主义。资料记录了两处反例。作者没有披露样本。'
  const stances = Array.from({length:6}, (_, i) => ({member_id:String(i),collection_id:'g',content:'核对反例，检查样本'}))
  const items = stances.map(s => ({...s,strength:0.8,quote:'资料记录了两处反例',reason:'核对反例时，记录了两处反例可供查证',evidence:{focus_quote:'反例',condition:'核对反例',predicate:'记录了两处反例'}}))
  items[0].quote='历史唯物主义'
  items[1].evidence.condition='查发票'
  items[2].quote='资料记录了两处反例。'
  items[4].reason='主题。'
  Object.assign(items[5],{strength:-0.7,quote:'作者没有披露样本',reason:'检查样本要求披露分母，作者没有披露样本',evidence:{focus_quote:'样本',condition:'检查样本',predicate:'没有披露样本'}})
  const score = list=>readingOption({stances:list,exploration:{relevance:0.8}},stances,material,'如何核对反例与样本？')
  const r=score(items)
  assert.deepEqual(r.stance_evidence.map(x=>x.status),['missing_candidate_claim','missing_stance_condition','shared_candidate_evidence','shared_candidate_evidence','missing_question_link','applicable'])
  assert.deepEqual(r.contributions.map(x=>x.strength),[-0.7])
  assert.deepEqual(score([...items].reverse()).contributions,r.contributions)
})
