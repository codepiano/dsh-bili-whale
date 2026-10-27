#!/usr/bin/env node
import fs from "node:fs";
import { Observer } from "../lib/concept-system/observation.mjs";
import { ObservationStore } from "../lib/concept-system/store.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
export async function observeCommand(argv = process.argv.slice(2)) {
  const [command, ...args] = argv,
    store = new ObservationStore(),
    observer = new Observer({ store });
  try {
    if (command === "serve") {
      if (args.length && (args[0] !== "--port" || args.length !== 2))
        throw Error("Usage: observe serve [--port 4399]");
      const { startObserverServer } =
        await import("../lib/observer-server.mjs");
      const running = await startObserverServer({
        port: args.length ? Number(args[1]) : 0,
      });
      console.log(`本地只读观察页面：${running.url}`);
      let closing = false;
      const stop = async () => {
        if (closing) return;
        closing = true;
        await running.close();
      };
      process.once("SIGINT", () => {
        stop().catch((e) => {
          console.error(e.message);
          process.exitCode = 1;
        });
      });
      process.once("SIGTERM", () => {
        stop().catch((e) => {
          console.error(e.message);
          process.exitCode = 1;
        });
      });
    } else {
      let out;
      if (command === "capture") out = await observer.capture();
      else if (command === "events")
        out = store.events(args[0] ? JSON.parse(args[0]) : {});
      else if (command === "versions" && args[0]) out = store.versions(args[0]);
      else if (command === "diff") out = store.diff(...args);
      else if (command === "object") out = store.getObject(args[0]);
      else if (command === "response" && args[0])
        out = await observer.response(
          JSON.parse(fs.readFileSync(args[0], "utf8")),
        );
      else if (command === "status") out = store.status();
      else if (command === "integrity") out = store.integrity();
      else
        throw Error(
          "Usage: observe capture | events [filter JSON] | versions <role> | diff <role> <from ID> <to ID> | object <hash> | response <JSON file> | status | integrity | serve [--port N]",
        );
      console.log(JSON.stringify(out, null, 2));
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  await observeCommand();
