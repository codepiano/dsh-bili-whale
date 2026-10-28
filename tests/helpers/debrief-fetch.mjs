import fs from 'node:fs'
globalThis.fetch=async(url,options={})=>{
  const u=new URL(url),fixture=JSON.parse(fs.readFileSync(process.env.TEST_DEBRIEF_FIXTURE,'utf8'))
  fs.appendFileSync(process.env.TEST_REQUESTS,JSON.stringify({url:String(url),method:options.method??'GET'})+'\n')
  if(options.method&&options.method!=='GET')throw Error('No platform writes allowed')
  if(u.pathname==='/x/web-interface/nav')return Response.json({code:0,data:{wbi_img:{img_url:'https://example.test/'+'a'.repeat(32)+'.png',sub_url:'https://example.test/'+'b'.repeat(32)+'.png'}}})
  if(u.pathname==='/x/web-interface/wbi/view')return Response.json({code:fixture.view_code??0,data:{cid:123,aid:456,title:'康德导读',desc:fixture.description??'视频简介',duration:90,owner:{name:'UP'},pubdate:1000,stat:{view:1000,like:3,favorite:2,coin:1,danmaku:0,reply:0},pic:'https://example.test/cover.jpg'}})
  if(['/x/player/playurl','/x/player/wbi/playurl'].includes(u.pathname))return Response.json({code:0,data:{dash:{audio:[{bandwidth:64000,baseUrl:'https://fixture.bilivideo.com/audio.m4a'}]}}})
  if(u.hostname==='fixture.bilivideo.com')return new Response('fixture audio')
  if(u.pathname==='/cover.jpg')return new Response(fixture.cover_failed?'':'fixture-image',{status:fixture.cover_failed?503:200})
  if(u.pathname==='/x/player/wbi/v2')return Response.json({code:fixture.player_code??0,data:{subtitle:{subtitles:fixture.no_subtitles?[]:[{lan:'ai-zh',subtitle_url:'https://example.test/subtitles'},...(fixture.multiple_tracks?[{lan:'zh-CN',subtitle_url:'https://example.test/subtitles'}]:[])]}}})
  if(u.pathname==='/subtitles')return fixture.subtitle_failed?new Response('',{status:503}):Response.json({body:fixture.body??[{from:0,to:4,content:'康德讨论认识的边界。'}]})
  if(u.hostname==='comment.bilibili.com')return new Response('<i></i>')
  if(u.pathname==='/x/v2/reply')return Response.json({code:0,data:{replies:[]}})
  throw Error('Unexpected network request: '+u.href)
}
