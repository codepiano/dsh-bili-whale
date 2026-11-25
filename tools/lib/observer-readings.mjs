import { requestError } from "./concept-system/observer-read.mjs";
import { redact } from "./concept-system/store.mjs";
import { indexDiary } from "./diary-index.mjs";
import { beijingDay } from "./observer-logs.mjs";

export const readingKinds = ["subtitles", "audio_transcript", "web_page"];

function isArchived(read) {
  return read?.reading_complete === true && readingKinds.includes(read.kind) &&
    !read.coverage?.truncated && read.sources?.length > 0;
}

function* records(db, kind = "") {
  if (!kind || kind === "web_page") {
    const web = db.prepare("SELECT payload FROM state_values WHERE key='resource_reads'").get();
    for (const read of Object.values(JSON.parse(web?.payload ?? "{}"))) {
      if (isArchived(read)) yield read;
    }
  }
  if (kind === "web_page") return;
  const video = db.prepare(
    "SELECT payload FROM video_reads WHERE json_extract(payload,'$.reading_complete')=1 AND (?='' OR kind=?)",
  );
  for (const { payload } of video.iterate(kind, kind)) {
    const read = JSON.parse(payload);
    if (isArchived(read)) yield read;
  }
}

function asWebUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function summarize(store, read) {
  let title = read.title;
  const bvid = /^BV[0-9A-Za-z]{10}$/.test(read.bvid) ? read.bvid : null;
  if (!title && bvid && read.material?.hash) {
    try {
      title = store.getObject(read.material.hash).content.title;
    } catch {
      // A missing metadata object should not hide independently archived text pages.
    }
  }
  const url = bvid ? `https://www.bilibili.com/video/${bvid}/` : asWebUrl(redact(read.url));
  const at = read.read_completed_at ?? read.presented_at ?? read.completed_at ?? read.acquired_at;
  const timestamp = new Date(at);
  return {
    id: read.id,
    kind: read.kind,
    title: (typeof title === "string" && redact(title.trim())) || bvid || url || "未命名阅读",
    url,
    bvid,
    at: Number.isFinite(timestamp.valueOf()) ? timestamp.toISOString() : null,
    day: Number.isFinite(timestamp.valueOf()) ? beijingDay(timestamp) : null,
    pages: read.sources.length,
  };
}

const newestFirst = (a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id);
const normalize = (text) => text.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();

export function archivedReadings(db, store, {kind, since, until} = {}) {
  return [...records(db, kind)]
    .filter((read) => {
      if (!since && !until) return true;
      const at = new Date(read.read_completed_at ?? read.presented_at ?? read.completed_at ?? read.acquired_at);
      if (!Number.isFinite(at.valueOf())) return false;
      const date = beijingDay(at);
      return (!since || date >= since) && (!until || date <= until);
    })
    .map((read) => summarize(store, read));
}

export function listReadings(db, store, { query, kind, day, page, limit }) {
  const needle = normalize(query.trim());
  const items = archivedReadings(db, store, {kind, since:day, until:day})
    .filter((item) => !needle || [item.title, item.url, item.bvid, item.id]
      .some((value) => value && normalize(value).includes(needle)))
    .sort(newestFirst);
  const pages = Math.max(1, Math.ceil(items.length / limit));
  const current = Math.min(page, pages);
  return { items: items.slice((current - 1) * limit, current * limit), total: items.length, page: current, pages };
}

export function readingPage(db, store, id, page) {
  const row = db.prepare("SELECT payload FROM video_reads WHERE id=?").get(id);
  const read = row
    ? JSON.parse(row.payload)
    : JSON.parse(db.prepare("SELECT payload FROM state_values WHERE key='resource_reads'").get()?.payload ?? "{}")[id];
  if (!isArchived(read)) throw requestError("找不到这份已读原文", 404);
  const source = read.sources[page - 1];
  if (!source) throw requestError("找不到这一页原文", 404);
  try {
    const object = store.getObject(source.object.hash);
    if (typeof object.content?.excerpt !== "string") throw Error("Missing archived text");
    return { reading: summarize(store, read), page, text: object.content.excerpt, redacted: Boolean(object.redacted || source.object.redacted) };
  } catch {
    throw requestError("这一页的归档文件不可用", 404);
  }
}

function referenceUrl(value) {
  const safe = asWebUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  url.hash = "";
  return url.href;
}

export function diaryReadings(db, store, { day, content }) {
  const entry = indexDiary(content).find(({ key }) => key === day);
  if (!entry) return { mentioned: [], sameDay: [], sameDayCount: 0 };
  const body = entry.content;
  const normalized = normalize(body);
  const bvids = new Set(body.match(/\bBV[0-9A-Za-z]{10}\b/g));
  const ids = new Set(body.match(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/g));
  const urls = new Set(
    (body.match(/https?:\/\/[^\s<>）】》），。]+/g) ?? [])
      .map((value) => referenceUrl(value.replace(/[)\],.;]+$/, ""))).filter(Boolean),
  );
  const mentioned = [];
  const sameDay = [];
  for (const read of records(db)) {
    const item = summarize(store, read);
    const title = normalize(item.title);
    const titleMatch = item.day === day && title.length >= 8 && normalized.includes(title);
    const urlMatch = [item.url, read.url, read.requested_url].some((value) => urls.has(referenceUrl(value)));
    if (ids.has(item.id) || bvids.has(item.bvid) || urlMatch || titleMatch) mentioned.push(item);
    else if (item.day === day) sameDay.push(item);
  }
  return {
    mentioned: mentioned.sort(newestFirst),
    sameDay: sameDay.sort(newestFirst).slice(0, 6),
    sameDayCount: sameDay.length,
  };
}
