import fs from 'node:fs'
globalThis.fetch=async(url,options={})=>{
  const u=new URL(url)
  fs.appendFileSync(process.env.TEST_REQUESTS,JSON.stringify({url:String(url),method:options.method??'GET'})+'\n')
  if(options.method&&options.method!=='GET')throw Error('No platform writes allowed')
  if(u.pathname==='/x/web-interface/nav')return Response.json({code:0,data:{wbi_img:{img_url:'https://example.test/'+'a'.repeat(32)+'.png',sub_url:'https://example.test/'+'b'.repeat(32)+'.png'}}})
  if(u.pathname==='/x/web-interface/wbi/search/type')return Response.json({code:0,data:{result:JSON.parse(fs.readFileSync(process.env.TEST_FEED_POOL,'utf8'))}})
  if(u.pathname==='/x/web-interface/wbi/view')return Response.json({code:0,data:{bvid:u.searchParams.get('bvid'),aid:456,cid:123,title:'原始升级维护记录',duration:90,owner:{name:'UP'},stat:{},desc:'项目组逐一核对了升级前后的工时和每笔返工记录。',pages:[{part:'维护日志实例'}]}})
  throw Error('Unexpected network request: '+u.pathname)
}
