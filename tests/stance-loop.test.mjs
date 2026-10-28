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
  assert.match(rendered.text, /feed_assess/);
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
 await assert.rejects(engine.call('feed_run',{run_id:'bad',command:'arbitrary'}))
 await assert.rejects(engine.call('debrief_read',{bvid:'BV;bad',feed_run_id:args.run_id}))
 assert.ok(fs.readFileSync(requests,'utf8').split('\n').filter(Boolean).every(l=>JSON.parse(l).method==='GET'))
 await reader.close()
})
