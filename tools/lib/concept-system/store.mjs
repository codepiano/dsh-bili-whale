import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SqliteJournal } from "./sqlite-journal.mjs";
import { HOME } from "../paths.mjs";

export const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : stable(value))
    .digest("hex");
const secretKey =
  /^(?:cookie|setcookie|authorization|proxyauthorization|credentials?|sessdata|bilijct|buvid3|accesstoken|refreshtoken|sessiontoken|launchtoken|apikey|password|secret|secretkey|token|auth)$/i;
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secretKey.test(k.replace(/[-_]/g, "")) ? "[REDACTED]" : redact(v),
      ]),
    );
  if (typeof value !== "string") return value;
  return value
    .replace(/\b(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(
      /\b(SESSDATA|bili_jct|buvid3|access[-_]?token|refresh[-_]?token|api[-_]?key|password|secret|token)([\"']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;,}&]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(/https?:\/\/[^\s<>"']+/g, (raw) => {
      try {
        const u = new URL(raw);
        if (u.username || u.password) {
          u.username = "";
          u.password = "";
        }
        // Query-bearing platform/media URLs can carry signed account-specific access.
        if (
          /(?:^|\.)(?:bilibili\.com|bilivideo\.(?:com|cn)|hdslb\.com)$/.test(
            u.hostname,
          ) ||
          [...u.searchParams.keys()].some((k) =>
            /token|sign|auth|key|credential|cookie|expires|deadline|wssecret/i.test(
              k,
            ),
          )
        )
          u.search = "";
        return u.href;
      } catch {
        return raw;
      }
    });
}
export const dataRoot = () =>
  process.env.BILI_CONCEPT_HOME ||
  path.join(HOME, ".bili-ai", "concept-system");
export function atomicWrite(file, content) {
  const tmp = file + "." + crypto.randomUUID() + ".tmp";
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink())
    throw Error("Observation directory must not be a symlink");
  fs.chmodSync(dir, 0o700);
}
function canonicalDirectory(directory) {
  const absolute = path.resolve(directory);
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink())
    throw Error("Observation directory must not be a symlink");
  let ancestor = absolute;
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}
export class ObservationStore {
  constructor(directory = dataRoot(), { now = Date.now } = {}) {
    this.directory = canonicalDirectory(directory);
    this.now = now;
    this.file = path.join(this.directory, "observations.sqlite3");
    this.legacyFile = path.join(this.directory, "journal.json");
    this.journal = new SqliteJournal(this);
  }
  read() {
    return this.journal.export();
  }
  state() {
    return this.journal.state();
  }
  preview(id) {
    return this.journal.preview(id);
  }
  status() {
    return this.journal.status();
  }
  integrity() {
    return this.journal.integrity();
  }
  object(content) {
    const safe = redact(content),
      text = typeof safe === "string" ? safe : stable(safe),
      id = hash(text);
    privateDir(this.directory);
    const dir = path.join(this.directory, "objects");
    privateDir(dir);
    const file = path.join(dir, id + ".json");
    if (!fs.existsSync(file))
      atomicWrite(
        file,
        JSON.stringify({
          content: safe,
          redacted: stable(content) !== stable(safe),
        }),
      );
    else this.getObject(id);
    return { hash: id, redacted: stable(content) !== stable(safe) };
  }
  getObject(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error("Invalid object hash");
    const file = path.join(this.directory, "objects", id + ".json");
    if (fs.lstatSync(file).isSymbolicLink())
      throw Error("Object must not be a symlink");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      hash(
        typeof value.content === "string"
          ? value.content
          : stable(value.content),
      ) !== id
    )
      throw Error("Observation object hash mismatch");
    return value;
  }
  async transaction(options = {}, fn) {
    return this.journal.transaction(options, fn);
  }
  async event(type, data, links) {
    return this.transaction({ state: false }, (_, emit) =>
      emit(type, data, links),
    );
  }
  events(filters = {}) {
    return this.journal.events(filters);
  }
  async snapshot(
    role,
    content,
    { status = "present", actor = "external_unknown", trace_id, expected } = {},
  ) {
    const object = status === "present" ? this.object(content) : null;
    return this.transaction({ state: false }, (d, emit) => {
      const last = d.latestVersion(role);
      if (expected !== undefined && (last?.hash ?? null) !== expected)
        throw Error("Version conflict");
      if (last?.hash === object?.hash && last?.status === status) return last;
      const version = {
        id: crypto.randomUUID(),
        role,
        status,
        hash: object?.hash ?? null,
        redacted: object?.redacted ?? false,
        actor,
        at: new Date(this.now()).toISOString(),
      };
      d.addVersion(version);
      emit("snapshot.captured", version, { trace_id });
      return version;
    });
  }
  versions(role) {
    return this.journal.versions(role);
  }
  diff(role, from, to) {
    const a = this.journal.version(role, from),
      b = this.journal.version(role, to);
    if (!a || !b) throw Error("Unknown version");
    return {
      role,
      from: a,
      to: b,
      before: a.hash ? this.getObject(a.hash) : null,
      after: b.hash ? this.getObject(b.hash) : null,
    };
  }
}
