#!/usr/bin/env node
import fs from "node:fs";
import { Observer } from "../lib/concept-system/observation.mjs";
import { ObservationStore } from "../lib/concept-system/store.mjs";
const [command, ...args] = process.argv.slice(2),
  store = new ObservationStore(),
  observer = new Observer({ store });
try {
  let out;
  if (command === "capture") out = await observer.capture();
  else if (command === "events")
    out = store.events(args[0] ? JSON.parse(args[0]) : {});
  else if (command === "versions" && args[0]) out = store.versions(args[0]);
  else if (command === "diff") out = store.diff(...args);
  else if (command === "object") out = store.getObject(args[0]);
  else if (command === "response" && args[0])
    out = await observer.response(JSON.parse(fs.readFileSync(args[0], "utf8")));
  else if (command === "status") out = store.status();
  else if (command === "integrity") out = store.integrity();
  else
    throw Error(
      "Usage: observe capture | events [filter JSON] | versions <role> | diff <role> <from ID> <to ID> | object <hash> | response <JSON file> | status | integrity",
    );
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
