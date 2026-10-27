#!/usr/bin/env node
import fs from "node:fs";
import { ConceptEngine } from "../lib/concept-system/engine.mjs";
import { schemas } from "../lib/concept-system/schemas.mjs";
import { redact } from "../lib/concept-system/store.mjs";
const [name, flag, value] = process.argv.slice(2);
try {
  if (name === "help" || !name) {
    console.log(
      "Usage: bili.mjs concept <tool> [--input file.json | --json JSON]\n" +
        Object.keys(schemas).join("\n"),
    );
  } else {
    if (flag && !["--input", "--json"].includes(flag))
      throw Error("Use --input file.json or --json JSON");
    const input =
      flag === "--input"
        ? JSON.parse(fs.readFileSync(value, "utf8"))
        : flag === "--json"
          ? JSON.parse(value)
          : {};
    console.log(
      JSON.stringify(await new ConceptEngine().call(name, input), null, 2),
    );
  }
} catch (e) {
  console.error(redact(e.message));
  process.exitCode = 1;
}
