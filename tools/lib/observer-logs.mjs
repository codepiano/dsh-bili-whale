import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { requestError } from "./concept-system/observer-read.mjs";

const diaryFiles = new Map([
  ["public", "whale-diary.md"],
  ["private", "whale-diary-private.md"],
]);

async function readLog(directory, name) {
  let file;
  try {
    file = await open(
      path.join(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile()) throw Error("Not a regular file");
    return {
      content: await file.readFile("utf8"),
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw requestError("无法读取这份日志", 503);
  } finally {
    await file?.close();
  }
}

export async function readDiary(directory, kind) {
  const file = diaryFiles.get(kind);
  if (!file) throw requestError("未知日记类型");
  return { diary: await readLog(directory, file) };
}

export async function readActivity(directory, { page, limit }) {
  const log = await readLog(directory, "whale-log.jsonl");
  const events = [];
  let skipped = 0;
  for (const line of (log?.content ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const { at, kind, target, note } = JSON.parse(line);
      if (
        typeof at !== "string" ||
        Number.isNaN(Date.parse(at)) ||
        typeof kind !== "string" ||
        !kind.trim()
      ) {
        skipped++;
        continue;
      }
      events.push({
        at,
        kind,
        target: typeof target === "string" ? target : null,
        note: typeof note === "string" ? note : null,
      });
    } catch {
      skipped++;
    }
  }
  const pages = Math.max(1, Math.ceil(events.length / limit));
  const current = Math.min(page, pages);
  const end = events.length - (current - 1) * limit;
  return {
    items: events.slice(Math.max(0, end - limit), end).reverse(),
    total: events.length,
    page: current,
    pages,
    skipped,
  };
}
