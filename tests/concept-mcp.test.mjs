import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = fileURLToPath(new URL("../", import.meta.url));
test("real stdio MCP handshake, schemas, tool calls, failure results, restart and CLI share state", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "whale-mcp-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: path.join(home, ".dsh"),
    BILI_CONCEPT_HOME: path.join(home, "data"),
    DSH_NODE: process.execPath,
  };
  let client, transport;
  async function connect() {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "tools/concept-mcp.mjs")],
      env,
      stderr: "pipe",
    });
    client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
  }
  await connect();
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.ok(
    tools.tools.some(
      (t) => t.name === "decision_preview" && t.inputSchema.type === "object",
    ),
  );
  const input = {
    key: "one",
    subject: "fish",
    source: {
      id: "u1",
      type: "conversation",
      actor: "user",
      excerpt: "我想了解康德",
    },
    content: "康德",
    tags: ["topic"],
  };
  const result = await client.callTool({
    name: "concept_propose",
    arguments: input,
  });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).status, "pending");
  const bad = await client.callTool({
    name: "concept_review",
    arguments: {
      key: "bad",
      candidate_id: "missing",
      status: "accepted",
      reason: "test",
      collections: [{ name: "哲学" }],
    },
  });
  assert.equal(bad.isError, true);
  await client.close();
  await connect();
  const query = await client.callTool({ name: "concept_query", arguments: {} });
  assert.equal(JSON.parse(query.content[0].text).members.length, 1);
  const cli = spawnSync(
    process.execPath,
    [
      path.join(root, "tools/bili.mjs"),
      "concept",
      "concept_query",
      "--json",
      "{}",
    ],
    { env, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).members[0].content, "康德");
  await client.close();
});
