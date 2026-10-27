import fs from 'node:fs'
globalThis.fetch=async(url,options={})=>{
  const u=new URL(url)
  fs.appendFileSync(process.env.TEST_REQUESTS,JSON.stringify({url:String(url),method:options.method??'GET'})+'\n')
  if(options.method&&options.method!=='GET')throw Error('No platform writes allowed')
  if(u.pathname==='/x/web-interface/nav')return Response.json({code:0,data:{wbi_img:{img_url:'https://example.test/'+'a'.repeat(32)+'.png',sub_url:'https://example.test/'+'b'.repeat(32)+'.png'}}})
  if(u.pathname==='/x/web-interface/wbi/search/type')return Response.json({code:0,data:{result:JSON.parse(fs.readFileSync(process.env.TEST_FEED_POOL,'utf8'))}})
  throw Error('Unexpected network request: '+u.pathname)
}
