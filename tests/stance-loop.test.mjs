import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObservationStore, hash } from "../tools/lib/concept-system/store.mjs";
import { ConceptEngine } from "../tools/lib/concept-system/engine.mjs";
import { FeedConcepts, feedGroups } from "../tools/lib/concept-system/feed.mjs";
import { VideoReads } from "../tools/lib/concept-system/video-reads.mjs";
import { renderLearningContext } from "../tools/lib/concept-system/personal-context.mjs";
const config = {
  conceptSystem: {
    observe: true,
    learning: true,
    mode: "active",
    renderBudget: 400,
  },
};
const videos = [
  {
    bv: "BV0000000001",
    t: "漂亮口号保证成功",
    description: "只有承诺，没有方法",
    up: "A",
    _score: 50,
  },
  {
    bv: "BV0000000002",
    t: "测量误差：提供检验步骤",
    description: "可以复查的方法及不确定性",
    up: "B",
    _score: 1,
  },
];
async function fixture(t, route = "revisit") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "whale-stance-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new ObservationStore(home),
    engine = new ConceptEngine(store);
  for (let i = 0; i < 6; i++) {
    const m = await engine.call("concept_propose", {
      key: "s" + i,
      source: {
        id: "s" + i,
        actor: "fish",
        type: "manual",
        excerpt: "保留证据并比较解释" + i,
      },
      subject: "fish",
      content: "保留证据并比较解释" + i,
      tags: ["belief"],
      interpretation: "explicit",
    });
    const r = await engine.call("concept_review", {
      key: "r" + i,
      candidate_id: m.id,
      status: "accepted",
      reason: "已有明确立场",
      collections: [{ name: "判断准则" + i }],
    });
    await store.transaction({}, (d) => {
      d.state.concepts.collections[r.collection_ids[0]].legacy_pref = {
        weight: 1 + i / 100,
        wins: i,
        losses: 0,
      };
    });
  }
  await engine.call("exploration_configure", {
    key: "ratios",
    ratios: {
      deep: route === "deep" ? 1 : 0,
      revisit: route === "revisit" ? 1 : 0,
      discover: route === "discover" ? 1 : 0,
    },
    reason: "隔离路径验证",
  });
  if (route === "deep") {
    const c = Object.values(store.state().concepts.collections)[0];
    await engine.call("exploration_question", {
      key: "q",
      collection_id: c.id,
      question: "怎样复核测量中的误差？",
      next_step: "找出方法和反例",
      reason: "有明确理解缺口",
    });
  }
  const feed = new FeedConcepts({ config, store, runId: "run", seed: "fixed" }),
    args = { candidates: videos, legacy: videos, n: 1, per: 2 };
  const search = await feed.plan(["科学"]);
  assert.equal(search.status, "search_plan_required");
  await engine.call("feed_search_plan", {
    key: "queries",
    run_id: "run",
    queries: ["检验证据的方法"],
    reason: "围绕未解问题或稀疏立场查找可验证的方法",
  });
  const ready = await feed.plan(["科学"]);
  assert.equal(ready.status, "search_ready");
  assert.ok(ready.keywords.includes("检验证据的方法"));
  return { home, store, engine, feed, args };
}
function assessments(packet) {
  return packet.candidates.map((v, i) => ({
    bvid: v.bv,
    exploration: {
      relevance: 1,
      reason: i ? "比较可复查方法" : "检查缺乏方法的承诺",
      quote: v.t,
    },
    discovered_term: i ? "测量误差" : "漂亮口号",
    stances: packet.stances.map((s) => ({
      collection_id: s.collection_id,
      member_id: s.member_id,
      strength: i ? 0.9 : -0.8,
      quote: v.t,
      reason: i ? "候选给出检验方法，支持该准则" : "候选只有承诺，应谨慎对待",
    })),
  }));
}
test("beliefs change actual slate through cited judgments, without becoming topics or legacy win rewards", async (t) => {
  const { store, engine, feed, args } = await fixture(t);
  const packet = await feed.select(args);
  assert.equal(packet.status, "judgment_required");
  assert.equal(packet.selected.length, 0);
  assert.equal(packet.stances.length, 6);
  assert.equal(feedGroups(store.state().concepts).length, 0);
  assert.equal(store.events({ type: "decision.committed" }).length, 0);
  await engine.call("feed_assess", {
    key: "judge",
    run_id: "run",
    assessments: assessments(packet),
  });
  const result = await feed.resume({ n: 1, per: 2 });
  assert.equal(result.selected[0].bv, videos[1].bv);
  const decision = result.decisions[0];
  assert.equal(decision.feed_judgment.stance_ids.length, 6);
  const saved = store.preview(decision.preview_id),
    preview = store.getObject(saved.object).content;
  assert.ok(
    preview.rows.every(
      (r) => r.contributions.filter((c) => c.purpose === "stance").length === 6,
    ),
  );
  assert.ok(
    preview.rows.find((r) => r.label === videos[1].bv).base >
      preview.rows.find((r) => r.label === videos[0].bv).base,
  );
  assert.equal(engine.replay(decision.preview_id).matches, true);
  assert.ok(
    preview.rows
      .flatMap((r) => r.contributions)
      .filter((c) => c.purpose === "stance")
      .every(
        (c) =>
          c.legacy_prior?.algorithm === "stance-prior-v1" &&
          c.legacy_prior.factor >= 0.75 &&
          c.legacy_prior.factor <= 1.25,
      ),
  );
  assert.equal(
    Object.values(store.state().concepts.collections).some(
      (c) => c.reward !== 0,
    ),
    false,
  );
  assert.equal(
    Object.values(store.state().concepts.members).some((m) =>
      m.tags.includes("topic"),
    ),
    false,
  );
  const before = hash(store.state()),
    events = store.events({ type: "decision.committed" }).length;
  assert.deepEqual(await feed.resume({ n: 1, per: 2 }), result);
  assert.equal(hash(store.state()), before);
  assert.equal(store.events({ type: "decision.committed" }).length, events);
});
test("candidate quotes, stance membership, full coverage and new state are checked before accepting model judgments", async (t) => {
  const { store, engine, feed, args } = await fixture(t),
    packet = await feed.select(args);
  const valid = assessments(packet),
    bad = structuredClone(valid);
  bad[0].stances[0].quote = "材料里没有这句话";
  const before = hash(store.state());
  await assert.rejects(
    engine.call("feed_assess", { key: "bad", run_id: "run", assessments: bad }),
    /quote/,
  );
  await assert.rejects(
    engine.call("feed_assess", {
      key: "partial",
      run_id: "run",
      assessments: valid.slice(1),
    }),
    /every prepared candidate/,
  );
  const duplicate = structuredClone(valid);
  duplicate[0].stances[1] = duplicate[0].stances[0];
  await assert.rejects(
    engine.call("feed_assess", {
      key: "dup",
      run_id: "run",
      assessments: duplicate,
    }),
    /duplicate stance/,
  );
  assert.equal(hash(store.state()), before);
  await engine.call("concept_propose", {
    key: "new",
    source: { id: "new", actor: "fish", type: "manual", excerpt: "新增来源" },
    subject: "fish",
    content: "新增线索",
    tags: ["topic"],
  });
  await assert.rejects(
    engine.call("feed_assess", {
      key: "stale",
      run_id: "run",
      assessments: valid,
    }),
    /state changed/,
  );
});
test("actual subtitle receipt updates exploration exposure once; acquisition, selected slate and descriptions do not", async (t) => {
  const { store, engine, feed, args } = await fixture(t),
    packet = await feed.select(args);
  await engine.call("feed_assess", {
    key: "judge",
    run_id: "run",
    assessments: assessments(packet),
  });
  const result = await feed.resume({ n: 1, per: 2 }),
    reads = new VideoReads(store),
    d = result.decisions[0];
  const plan = () =>
    engine.call("exploration_plan", { seed: "after", scene: "watch" });
  assert.equal((await plan()).counts.revisit, 0);
  const description = await reads.start(d.selected, { feed_run_id: "run" }),
    desc = await reads.complete(description.id, {
      bvid: d.selected,
      cid: "123",
      description: "只有简介",
      duration: 30,
    });
  await reads.acceptOutput(desc.marker, { session_id: "fish", learn: false });
  assert.equal((await plan()).counts.revisit, 0);
  const attempt = await reads.start(d.selected, { feed_run_id: "run" }),
    receipt = await reads.complete(attempt.id, {
      bvid: d.selected,
      cid: "123",
      duration: 30,
      subtitles: [
        {
          from: 0,
          to: 20,
          content: "测量结果需要重复检验，并记录误差与不确定性。",
        },
      ],
    });
  assert.equal((await plan()).counts.revisit, 0);
  await reads.acceptOutput(receipt.marker, {
    session_id: "fish",
    learn: false,
  });
  await reads.acceptOutput(receipt.marker, {
    session_id: "fish",
    learn: false,
  });
  assert.equal((await plan()).counts.revisit, 0);
  assert.deepEqual(reads.seen(),[]);
  await assert.rejects(engine.call('exploration_progress',{key:'premature',decision_id:d.id,outcome:'engaged',source_ids:['s0'],answered:'没有读正文',next_step:'跳过正文',reason:'应拒绝'}),/Read all subtitle pages/);
  const page=await engine.call('video_read_page',{read_id:receipt.id,page:1});
  await reads.acceptOutput(JSON.stringify(page),{session_id:'fish',learn:false});
  assert.equal((await plan()).counts.revisit, 1);
  assert.equal(store.events({ type: "exploration.exposed" }).length, 1);
  const exposed = store.state().concepts.decisions[d.id].exploration.exposure;
  await engine.call("exploration_progress", {
    key: "reflection",
    decision_id: d.id,
    outcome: "engaged",
    source_ids: exposed.source_ids,
    answered: "读到了重复检验的方法",
    remaining: "哪些条件会使方法失效？",
    next_step: "寻找反例",
    reason: "根据实际字幕材料反思",
  });
  assert.equal((await plan()).counts.revisit, 1);
  assert.equal(engine.replay(d.preview_id).matches, true);
});
test("discovery retains quoted novel terms as pending and deep dives retain the actual open question", async (t) => {
  for (const route of ["discover", "deep"]) {
    const { store, engine, feed, args } = await fixture(t, route),
      packet = await feed.select(args);
    assert.equal(packet.exploration.path, route);
    const a = assessments(packet);
    if (route === "discover") {
      const bad = structuredClone(a);
      bad[0].discovered_term = "不存在的词";
      await assert.rejects(
        engine.call("feed_assess", {
          key: "bad",
          run_id: "run",
          assessments: bad,
        }),
        /term quoted/,
      );
    }
    await engine.call("feed_assess", {
      key: "judge",
      run_id: "run",
      assessments: a,
    });
    const result = await feed.resume({ n: 1, per: 2 }),
      d = result.decisions[0];
    assert.equal(d.exploration.path, route);
    assert.equal(engine.replay(d.preview_id).matches, true);
    if (route === "discover")
      assert.equal(
        store.state().concepts.members[d.exploration.target.candidate_id]
          .status,
        "pending",
      );
    else
      assert.equal(
        d.exploration.target_snapshot.question,
        "怎样复核测量中的误差？",
      );
  }
});
test("an empty owner profile cannot take budget from fish beliefs; all six short stances fit in real configured context", async (t) => {
  const { store } = await fixture(t);
  const rendered = await renderLearningContext(store, { budget: 400 });
  assert.equal(rendered.rendered.length, 1);
  assert.equal(rendered.rendered[0].subject, "fish");
  assert.equal(rendered.rendered[0].selected.length, 6);
  assert.ok([...rendered.text].length <= 400);
  assert.match(rendered.text, /exploration_next/);
  assert.equal(store.events({ type: "learning.context_admitted" }).length, 0);
});

test("the real CLI requires a path-specific search plan, retrieves its queries, and resumes the judged slate without new requests", async (t) => {
  const { home, store, engine } = await fixture(t),
    profile = path.join(home, "profile"),
    privateDir = path.join(home, "private-home", ".bili-ai");
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });
  const configPath = path.join(profile, "bili-whale.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      preferences: { like: ["AI"], dislike: [] },
      risk: { minGapMs: 0 },
    }),
  );
  fs.writeFileSync(
    path.join(privateDir, "credentials.json"),
    JSON.stringify({
      sessdata: "fixture",
      bili_jct: "fixture",
      buvid3: "fixture",
    }),
  );
  const poolFile = path.join(home, "pool.json"),
    requests = path.join(home, "requests.jsonl");
  fs.writeFileSync(
    poolFile,
    JSON.stringify(
      videos.map((v) => ({
        bvid: v.bv,
        title: "AI " + v.t,
        description: v.description,
        duration: "05:00",
        danmaku: 30,
        play: 1000,
        author: v.up,
      })),
    ),
  );
  const { spawnSync } = await import("node:child_process"),
    { fileURLToPath, pathToFileURL } = await import("node:url");
  const env = {
    ...process.env,
    USERPROFILE: path.join(home, "private-home"),
    DSH_HOME: profile,
    BILI_WHALE_CONFIG: configPath,
    BILI_CONCEPT_HOME: home,
    TEST_FEED_POOL: poolFile,
    TEST_REQUESTS: requests,
    NODE_OPTIONS:
      "--import=" +
      pathToFileURL(
        fileURLToPath(new URL("./helpers/feed-fetch.mjs", import.meta.url)),
      ).href,
  };
  const run = () => {
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../tools/commands/feed.mjs", import.meta.url)),
        "--source",
        "search",
        "--n",
        "1",
        "--json",
        "--run-id",
        "cli-stage",
        "--seed",
        "staged",
      ],
      { env, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const planning = run();
  assert.equal(planning.status, "search_plan_required");
  assert.equal(fs.existsSync(requests), false);
  await engine.call("feed_search_plan", {
    key: "cli-queries",
    run_id: "cli-stage",
    queries: ["可复核的AI证据"],
    reason: "在该立场下查找可复核实例",
  });
  const pending = run();
  assert.equal(pending.status, "judgment_required");
  assert.ok(
    fs
      .readFileSync(requests, "utf8")
      .includes(encodeURIComponent("可复核的AI证据")),
  );
  await engine.call("feed_assess", {
    key: "cli-assess",
    run_id: "cli-stage",
    assessments: assessments(pending),
  });
  const traffic = fs.readFileSync(requests, "utf8");
  fs.unlinkSync(path.join(privateDir, "credentials.json"));
  fs.unlinkSync(poolFile);
  const selected = run();
  assert.equal(selected.status, "selected");
  assert.equal(selected.selected.length, 1);
  assert.deepEqual(run(), selected);
  assert.equal(fs.readFileSync(requests, "utf8"), traffic);
  assert.ok(
    traffic
      .split("\n")
      .filter(Boolean)
      .every((l) => JSON.parse(l).method === "GET"),
  );
  assert.equal(
    store
      .events({ type: "feed.exploration_planned" })
      .filter((e) => e.data.run_id === "cli-stage").length,
    1,
  );
});

test('fixed MCP business operations complete feed stages and acquire real CLI subtitle receipts without terminal filesystem grants',async t=>{
 const {home,store,engine}=await fixture(t),profile=path.join(home,'mcp-profile'),privateDir=path.join(home,'mcp-user','.bili-ai')
 fs.mkdirSync(profile,{recursive:true});fs.mkdirSync(privateDir,{recursive:true})
 const configPath=path.join(profile,'bili-whale.config.json');fs.writeFileSync(configPath,JSON.stringify({...config,preferences:{like:['AI'],dislike:[]},risk:{minGapMs:0}}))
 fs.writeFileSync(path.join(privateDir,'credentials.json'),JSON.stringify({sessdata:'fixture',bili_jct:'fixture',buvid3:'fixture'}))
 const poolFile=path.join(home,'mcp-pool.json'),requests=path.join(home,'mcp-requests.jsonl'),debriefFixture=path.join(home,'debrief-fixture.json')
 fs.writeFileSync(poolFile,JSON.stringify(videos.map(v=>({bvid:v.bv,title:'AI '+v.t,description:v.description,duration:'05:00',danmaku:30,play:1000,author:v.up}))))
 fs.writeFileSync(debriefFixture,JSON.stringify({cover_failed:true,body:[{from:0,to:12,content:'测试材料说明怎样检验证据与误差。'}]}))
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js'),{fileURLToPath,pathToFileURL}=await import('node:url')
 const env={...process.env,USERPROFILE:path.join(home,'mcp-user'),DSH_HOME:profile,BILI_WHALE_CONFIG:configPath,BILI_CONCEPT_HOME:home,TEST_FEED_POOL:poolFile,TEST_REQUESTS:requests,TEST_DEBRIEF_FIXTURE:debriefFixture}
 async function connect(helper){const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../tools/concept-mcp.mjs',import.meta.url))],env:{...env,NODE_OPTIONS:'--import='+pathToFileURL(fileURLToPath(new URL('./helpers/'+helper,import.meta.url))).href},stderr:'pipe'});const client=new Client({name:'scoped-operations-test',version:'1'});await client.connect(transport);t.after(()=>client.close());return client}
 const client=await connect('feed-fetch.mjs')
 const call=async(client,name,args)=>{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,result.content?.[0]?.text);return JSON.parse(result.content[0].text)}
 const args={run_id:'mcp-scoped',n:1,per:2,pool:20,source:'search'}
 const request=await call(client,'feed_run',args);assert.equal(request.status,'search_plan_required')
 await call(client,'feed_search_plan',{key:'mcp-queries',run_id:args.run_id,queries:['检验AI证据'],reason:'针对立场寻找可复核的方法'})
 const pending=await call(client,'feed_run',args);assert.equal(pending.status,'judgment_required')
 await call(client,'feed_assess',{key:'mcp-judge',run_id:args.run_id,assessments:assessments(pending)})
 const selected=await call(client,'feed_run',args);assert.equal(selected.selected.length,1)
 await client.close()
 const reader=await connect('debrief-fetch.mjs')
 const read=await call(reader,'debrief_read',{bvid:selected.selected[0].bv,feed_run_id:args.run_id})
 assert.match(read.receipt_marker,/BILI_DEBRIEF_RECEIPT:/)
 const rid=read.receipt_marker.split(':')[1],row=await new VideoReads(store).get(rid)
 assert.equal(row.feed.decision_id,selected.decisions[0].id);assert.equal(row.status,'acquired');assert.equal(row.kind,'subtitles')
 assert.equal(store.events({type:'exploration.exposed'}).length,0,'MCP API acquisition alone is not host receipt delivery')
 const tracker=new VideoReads(store);await tracker.acceptOutput(read.receipt_marker,{session_id:'fish',learn:false})
 assert.equal(store.events({type:'exploration.exposed'}).length,0,'metadata cannot create reading exposure')
 const page=await call(reader,'video_read_page',{read_id:rid,page:1})
 assert.match(page.text,/检验证据/)
 await tracker.acceptOutput(JSON.stringify(page),{session_id:'fish',learn:false})
 assert.equal(store.events({type:'exploration.exposed'}).length,1)
 await assert.rejects(engine.call('feed_run',{run_id:'bad',command:'arbitrary'}))
 await assert.rejects(engine.call('debrief_read',{bvid:'BV;bad',feed_run_id:args.run_id}))
 assert.ok(fs.readFileSync(requests,'utf8').split('\n').filter(Boolean).every(l=>JSON.parse(l).method==='GET'))
 await reader.close()
})

test('all real subtitle pages are required; forged, partial, foreign and replayed bodies cannot create exposure',async t=>{
 const {store,engine,feed,args}=await fixture(t),pending=await feed.select(args)
 await engine.call('feed_assess',{key:'judge-pages',run_id:'run',assessments:assessments(pending)})
 const selected=await feed.resume({n:1,per:2}),decision=selected.decisions[0],reads=new VideoReads(store)
 const started=await reads.start(decision.selected,{feed_run_id:'run'})
 const acquired=await reads.complete(started.id,{bvid:decision.selected,cid:'123',duration:100,subtitles:Array.from({length:7},(_,i)=>({from:i*10,to:i*10+5,content:'证据'+String(i)+'方法'.repeat(900)}))})
 await reads.acceptOutput(acquired.marker,{session_id:'fish',route:{provider:'deepseek-account',model:'fixture'}})
 assert.equal(store.events({type:'learning.enqueued'}).length,0)
 await reads.resume('fish');assert.equal(store.events({type:'learning.enqueued'}).length,0)
 const first=await reads.page({read_id:acquired.id,page:1}),last=await reads.page({read_id:acquired.id,page:2})
 assert.equal(first.total_pages,2)
 for(const payload of [{...first,text:first.text.slice(0,100)},{...first,receipt_hash:'a'.repeat(64)},{...first,text:undefined}])assert.deepEqual(await reads.acceptOutput(JSON.stringify(payload),{session_id:'fish'}),[])
 assert.deepEqual(await reads.acceptOutput(JSON.stringify(first),{session_id:'other'}),[])
 await reads.acceptOutput(JSON.stringify(last),{session_id:'fish',host_seq:100,tool_call_id:'page-2'})
 assert.equal(store.events({type:'exploration.exposed'}).length,0);assert.deepEqual(reads.seen(),[])
 const restored=new VideoReads(new ObservationStore(store.directory))
 await restored.acceptOutput(JSON.stringify(first),{session_id:'fish',host_seq:101,tool_call_id:'page-1'})
 assert.equal(store.events({type:'exploration.exposed'}).length,0,'full body without model delivery is not exposure')
 await restored.acceptDelivery({session_id:'other',through_seq:101,host_seq:102})
 await restored.acceptDelivery({session_id:'fish',through_seq:100,host_seq:102})
 assert.equal(store.events({type:'exploration.exposed'}).length,0)
 await restored.acceptDelivery({session_id:'fish',through_seq:101,host_seq:103})
 assert.equal(store.events({type:'exploration.exposed'}).length,1);assert.deepEqual(reads.seen(),[decision.selected])
 assert.equal(store.events({type:'video.subtitle_read_completed'}).length,1)
 assert.equal(store.events({type:'learning.enqueued'}).length,2)
 await restored.acceptOutput(JSON.stringify(first),{session_id:'fish'})
 assert.equal(store.events({type:'exploration.exposed'}).length,1)
 const exposure=store.state().concepts.decisions[decision.id].exploration.exposure
 await assert.rejects(engine.call('exploration_progress',{key:'foreign-source',decision_id:decision.id,outcome:'engaged',source_ids:['s0'],answered:'不匹配',next_step:'继续',reason:'拒绝跨视频来源'}),/this decision actual subtitle/)
 await engine.call('exploration_progress',{key:'actual-pages',decision_id:decision.id,outcome:'engaged',source_ids:exposure.source_ids,answered:'正文中的证据与方法',remaining:'独立重复是否一致？',next_step:'找独立复核',reason:'实际完整正文'})
 assert.equal(store.events({type:'exploration.exposed'}).length,1)
 const long=await reads.start(decision.selected,{feed_run_id:'run'}),truncated=await reads.complete(long.id,{bvid:decision.selected,cid:'999',duration:1000,subtitles:Array.from({length:100},(_,i)=>({from:i,to:i+1,content:'长'.repeat(4000)}))})
 await reads.acceptOutput(truncated.marker,{session_id:'fish'})
 await assert.rejects(reads.page({read_id:long.id,page:1}),/Truncated/)
 assert.equal(store.events({type:'exploration.exposed'}).length,1)
})

test('normal automatic cycle continues after missing subtitles, requires full reading and sourced questions, and resumes idempotently',async t=>{
 const {nextExploration}=await import('../tools/lib/concept-system/auto-exploration.mjs')
 const {store,engine}=await fixture(t),reads=new VideoReads(store);let invocations=0
 const feed=async arg=>{invocations++;const f=new FeedConcepts({config,store,runId:arg.run_id,seed:arg.seed}),resumed=await f.resume({n:arg.n,per:arg.per});if(resumed)return resumed;const plan=await f.plan(['科学']);if(plan.status==='search_plan_required')return plan;return f.select({candidates:videos,legacy:videos,n:arg.n,per:arg.per})}
 const options={feed,readConfig:()=>({...config,night:{maxVideos:2}})},next=()=>nextExploration(store,{cycle_id:'daily'},options)
 async function prepare(){let out=await next();assert.equal(out.next_action,'feed_search_plan');await engine.call('feed_search_plan',{key:out.run_id,run_id:out.run_id,queries:['复核误差 方法'],reason:'正常问题检索'});out=await next();assert.equal(out.next_action,'feed_assess');await engine.call('feed_assess',{key:out.run_id,run_id:out.run_id,assessments:assessments(out.packet)});return next()}
 let out=await prepare()
 for(let i=0;i<2;i++){
  assert.equal(out.next_action,'debrief_read');const attempt=await reads.start(out.arguments.bvid,{feed_run_id:out.run_id}),receipt=await reads.complete(attempt.id,{bvid:attempt.bvid,cid:'123',duration:10,description:'只有简介'})
  await reads.acceptOutput(receipt.marker,{session_id:'fish'});out=await next()
 }
 assert.equal(out.round,2);assert.equal(out.next_action,'feed_search_plan');assert.equal(store.events({type:'exploration.exposed'}).length,0)
 assert.equal(store.events({type:'exploration.cycle_continued'}).length,1)
 out=await prepare();const attempt=await reads.start(out.arguments.bvid,{feed_run_id:out.run_id}),receipt=await reads.complete(attempt.id,{bvid:attempt.bvid,cid:'456',duration:30,subtitles:[{from:0,to:10,content:'独立重复检验会暴露不同的误差。'}]})
 await reads.acceptOutput(receipt.marker,{session_id:'fish'});out=await next();assert.equal(out.next_action,'video_read_page')
 const page=await engine.call(out.next_action,out.arguments);await reads.acceptOutput(JSON.stringify(page),{session_id:'fish'})
 out=await next();assert.equal(out.next_action,'exploration_progress')
 await engine.call('exploration_progress',{key:'daily-progress',decision_id:out.decision_id,outcome:'engaged',source_ids:out.source_ids,answered:'读到了独立重复与误差的关系',remaining:'误差从何而来？',next_step:'找方法细节',reason:'完整正文'})
 out=await next();assert.equal(out.next_action,'exploration_question')
 await engine.call('exploration_question',{key:'daily-question',collection_id:out.collection_id,source_ids:out.source_ids,question:'怎样控制独立重复中的测量误差？',next_step:'找测量控制实例',reason:'实际字幕未决问题'})
 out=await next();assert.equal(out.status,'complete');const before=invocations
 assert.deepEqual(await nextExploration(new ObservationStore(store.directory),{cycle_id:'daily'},options),out);assert.equal(invocations,before)
 assert.equal(store.events({type:'exploration.cycle_completed'}).length,1)
})

test('automatic exploration bounds empty rounds, preserves exhaustion, and disabled mode makes no cycle writes',async t=>{
 const {nextExploration}=await import('../tools/lib/concept-system/auto-exploration.mjs'),{store}=await fixture(t)
 let calls=0;const options={feed:async()=>{calls++;return {status:'selected',selected:[]}},readConfig:()=>({...config,night:{maxVideos:2}})}
 const exhausted=await nextExploration(store,{cycle_id:'empty'},options);assert.equal(exhausted.status,'exhausted');assert.equal(calls,3)
 assert.deepEqual(await nextExploration(store,{cycle_id:'empty'},options),exhausted);assert.equal(calls,3)
 assert.equal(store.events({type:'exploration.cycle_exhausted'}).length,1);assert.equal(store.events({type:'exploration.exposed'}).length,0)
 const before=hash(store.state());assert.equal((await nextExploration(store,{cycle_id:'off'},{...options,readConfig:()=>({conceptSystem:{observe:false}})})).status,'disabled');assert.equal(hash(store.state()),before)
 await store.transaction({key:'feed-select:stale-r1',input:'selected'},()=>({mode:'shadow',selected:[videos[0]]}))
 const reads=new VideoReads(store),stale=await reads.start(videos[0].bv,{feed_run_id:'stale-r1'})
 await store.transaction({state:false},d=>{const r=d.reads.get(stale.id);d.reads.put({...r,started_at:new Date(Date.now()-220000).toISOString()})})
 const continued=await nextExploration(store,{cycle_id:'stale'},{...options,feed:async()=>({status:'selected',selected:[videos[0]]})})
 assert.equal(continued.round,2);assert.equal(continued.next_action,'debrief_read');assert.equal((await reads.get(stale.id)).status,'failed')
})

test('automatic cycle advances a stale search instead of asking the model to reroll or reuse invalid judgments',async t=>{
 const {nextExploration}=await import('../tools/lib/concept-system/auto-exploration.mjs'),{store,engine}=await fixture(t)
 const options={readConfig:()=>config,feed:async arg=>new FeedConcepts({store,config,runId:arg.run_id,seed:arg.seed}).plan(['科学'])}
 const first=await nextExploration(store,{cycle_id:'conflict'},options);assert.equal(first.round,1)
 assert.deepEqual(first.continue_with,{tool:'exploration_next',arguments:{cycle_id:'conflict'}});assert.equal(first.feed_arguments.n,5);assert.equal(first.feed_arguments.pool,30)
 assert.match(first.packet.instructions,/不要直接调用 feed_run/);assert.match(first.packet.instructions,/exploration_next/)
 await engine.call('concept_propose',{key:'other-work',source:{id:'other-work',actor:'fish',type:'manual',excerpt:'刚收到另一个真实材料线索'},subject:'fish',content:'新的材料线索',tags:['topic']})
 const next=await nextExploration(store,{cycle_id:'conflict'},options);assert.equal(next.round,2);assert.equal(next.next_action,'feed_search_plan')
 assert.equal(store.events({type:'exploration.cycle_continued'}).at(-1).data.reason,'concept_state_changed_before_selection')
})
