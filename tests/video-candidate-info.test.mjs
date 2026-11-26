import test from 'node:test'
import assert from 'node:assert/strict'
import { enrichShortVideos } from '../tools/lib/video-candidate-info.mjs'

test('short video previews keep their identity and original text on empty, mismatched and failed lookups', async () => {
  const candidates = ['-', '原简介', '', '长简介'.repeat(20)].map((description,i) =>
    ({ bv: 'BV000000000'+i, t:'视频标题', description }))
  const seen = []
  await enrichShortVideos(candidates, {get: async url => {
    const id = new URL(url).searchParams.get('bvid')
    seen.push(id)
    if (id.endsWith('2')) throw Error('offline')
    return {code:0,data:{bvid:id.endsWith('1')?'BV0000000009':id,desc:'',pages:[{part:'视频标题'}]}}
  }})
  assert.equal(seen.length,3)
  assert.deepEqual(candidates.map(c=>c.video_info?.status), ['no_additional_detail','unavailable','unavailable',undefined])
  assert.deepEqual(candidates.map(c=>c.description), ['-', '原简介', '', '长简介'.repeat(20)])
})
