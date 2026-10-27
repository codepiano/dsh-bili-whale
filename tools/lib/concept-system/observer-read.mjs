import fs from "node:fs";
import { createRequire } from "node:module";
import { ObservationStore } from "./store.mjs";
import { collectionStrength } from "./engine.mjs";
const require = createRequire(import.meta.url),
  APPLICATION_ID = 0x42574353;
export function requestError(message, status = 400) {
  return Object.assign(Error(message), { status });
}
export function integer(raw, fallback, min, max) {
  const n = raw === null || raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw requestError("分页参数超出范围");
  return n;
}
const parse = (row) => (row ? JSON.parse(row.payload) : null);
export class ObserverReader {
  constructor(directory) {
    this.store = new ObservationStore(directory);
  }
  use(fn, empty) {
    const file = this.store.file;
    if (!fs.existsSync(file))
      return typeof empty === "function" ? empty() : empty;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        const stat = fs.lstatSync(file + suffix);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw requestError("观察数据库路径不可用", 503);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    let db;
    try {
      const { DatabaseSync } = require("node:sqlite");
      db = new DatabaseSync(file, { readOnly: true });
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=3000; BEGIN;");
      if (
        db.prepare("PRAGMA user_version").get().user_version !== 1 ||
        db.prepare("PRAGMA application_id").get().application_id !==
          APPLICATION_ID
      )
        throw requestError("数据库版本不受支持，请使用对应版本的观察工具", 503);
      return fn(db);
    } finally {
      db?.close();
    }
  }
  overview() {
    return this.use(
      (db) => ({
        available: true,
        counts: {
          collections: db
            .prepare(
              "SELECT count(*) AS n FROM concept_entities WHERE kind='collections'",
            )
            .get().n,
          previews: db.prepare("SELECT count(*) AS n FROM previews").get().n,
          events: db.prepare("SELECT count(*) AS n FROM events").get().n,
          versions: db.prepare("SELECT count(*) AS n FROM versions").get().n,
        },
        roles: db
          .prepare("SELECT DISTINCT role FROM versions ORDER BY role")
          .all()
          .map((r) => r.role),
        last_event:
          db.prepare("SELECT at FROM events ORDER BY seq DESC LIMIT 1").get()
            ?.at ?? null,
      }),
      {
        available: false,
        legacy: fs.existsSync(this.store.legacyFile),
        counts: { collections: 0, previews: 0, events: 0, versions: 0 },
        roles: [],
        last_event: null,
      },
    );
  }
  graph(db, c) {
    const rows = db
      .prepare(
        "SELECT payload FROM concept_entities WHERE kind='members' AND id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(c.members));
    const members = Object.fromEntries(
        rows.map((r) => {
          const m = parse(r);
          return [m.id, m];
        }),
      ),
      ids = [...new Set(Object.values(members).map((m) => m.source_id))];
    const sources = Object.fromEntries(
      db
        .prepare(
          "SELECT id,payload FROM concept_entities WHERE kind='sources' AND id IN (SELECT value FROM json_each(?))",
        )
        .all(JSON.stringify(ids))
        .map((r) => [r.id, JSON.parse(r.payload)]),
    );
    return { members, sources };
  }
  collections({ page = 1, limit = 12, subject = "", query = "" } = {}) {
    return this.use(
      (db) => {
        const where = ["kind='collections'"],
          args = [];
        if (subject) {
          where.push("json_extract(payload,'$.subject')=?");
          args.push(subject);
        }
        if (query) {
          where.push("instr(lower(json_extract(payload,'$.name')),lower(?))>0");
          args.push(query);
        }
        const filter = where.join(" AND "),
          total = db
            .prepare(
              `SELECT count(*) AS n FROM concept_entities WHERE ${filter}`,
            )
            .get(...args).n;
        const items = db
          .prepare(
            `SELECT payload FROM concept_entities WHERE ${filter} ORDER BY json_extract(payload,'$.created_at') DESC,id LIMIT ? OFFSET ?`,
          )
          .all(...args, limit, (page - 1) * limit)
          .map((row) => {
            const c = parse(row),
              s = this.graph(db, c);
            return {
              ...c,
              strength: collectionStrength(c, s),
              member_count: c.members.length,
              accepted_count: Object.values(s.members).filter(
                (m) => m.status === "accepted",
              ).length,
            };
          });
        return { items, total, page, limit };
      },
      { items: [], total: 0, page, limit },
    );
  }
  collection(id, { page = 1, limit = 30 } = {}) {
    return this.use(
      (db) => {
        const c = parse(
          db
            .prepare(
              "SELECT payload FROM concept_entities WHERE kind='collections' AND id=?",
            )
            .get(id),
        );
        if (!c) throw requestError("概念集合不存在", 404);
        const graph = this.graph(db, c),
          members = c.members
            .slice((page - 1) * limit, page * limit)
            .map((id) => graph.members[id])
            .filter(Boolean)
            .map((m) => ({ ...m, source: graph.sources[m.source_id] ?? null }));
        return {
          ...c,
          strength: collectionStrength(c, graph),
          items: members,
          total: c.members.length,
          page,
          limit,
        };
      },
      () => {
        throw requestError("尚无概念集合", 404);
      },
    );
  }
  decisions({
    before = Number.MAX_SAFE_INTEGER,
    limit = 15,
    stage = "all",
    trace = "",
  } = {}) {
    return this.use(
      (db) => {
        const where = ["e.type='decision.previewed'", "e.seq<?"],
          args = [before];
        if (stage !== "all")
          where.push(
            `json_extract(p.payload,'$.committed') IS ${stage === "pending" ? "NULL" : "NOT NULL"}`,
          );
        if (trace) {
          where.push("e.trace_id=?");
          args.push(trace);
        }
        const rows = db
            .prepare(
              `SELECT e.seq,e.at,e.trace_id,e.payload AS event,p.id,p.payload FROM events e JOIN previews p ON p.id=json_extract(e.payload,'$.data.id') WHERE ${where.join(" AND ")} ORDER BY e.seq DESC LIMIT ?`,
            )
            .all(...args, limit + 1),
          more = rows.length > limit;
        const items = rows.slice(0, limit).map((r) => {
          const p = parse(r);
          try {
            const preview = this.store.getObject(p.object).content;
            return {
              id: r.id,
              seq: r.seq,
              at: r.at,
              trace_id: r.trace_id,
              committed: p.committed,
              question: preview.input.question,
              scene: preview.input.scene,
              winner: preview.winner,
              options: preview.rows.length,
            };
          } catch {
            return {
              id: r.id,
              seq: r.seq,
              at: r.at,
              trace_id: r.trace_id,
              committed: p.committed,
              question: "决策快照不可用",
              unavailable: true,
            };
          }
        });
        return { items, next: more ? items.at(-1).seq : null };
      },
      { items: [], next: null },
    );
  }
  decision(id) {
    return this.use(
      (db) => {
        const p = parse(
          db.prepare("SELECT payload FROM previews WHERE id=?").get(id),
        );
        if (!p) throw requestError("决策不存在", 404);
        let preview, state;
        try {
          preview = this.store.getObject(p.object).content;
          state = this.store.getObject(p.state_object).content;
        } catch {
          throw requestError("决策或状态快照不可用，无法还原当时的评分", 404);
        }
        const committed = p.committed
          ? parse(
              db
                .prepare(
                  "SELECT payload FROM concept_entities WHERE kind='decisions' AND id=?",
                )
                .get(p.committed),
            )
          : null;
        const feedback = committed
          ? db
              .prepare(
                "SELECT payload FROM events WHERE decision_id=? AND type='feedback.recorded' ORDER BY seq",
              )
              .all(committed.id)
              .map((r) => parse(r).data)
          : [];
        const names = Object.fromEntries(
          preview.rows.flatMap((row) =>
            row.contributions.map((c) => [
              c.collection_id,
              state.collections[c.collection_id]?.name ?? c.collection_id,
            ]),
          ),
        );
        const members = Object.fromEntries(
          preview.rows.flatMap((row) =>
            row.contributions.map((c) => [
              c.member_id,
              state.members[c.member_id]?.content ?? c.member_id,
            ]),
          ),
        );
        return {
          id,
          preview,
          committed,
          feedback,
          names,
          members,
          trace_id: preview.input.trace_id ?? null,
        };
      },
      () => {
        throw requestError("尚无决策记录", 404);
      },
    );
  }
  events({ trace_id, decision_id, after = 0, limit = 50 }) {
    return this.use(
      (db) => {
        if (!trace_id && !decision_id) return { items: [], next: null };
        const column = trace_id ? "trace_id" : "decision_id",
          value = trace_id || decision_id;
        const rows = db
          .prepare(
            `SELECT payload FROM events WHERE ${column}=? AND seq>? ORDER BY seq LIMIT ?`,
          )
          .all(value, after, limit + 1);
        const items = rows.slice(0, limit).map(parse);
        return { items, next: rows.length > limit ? items.at(-1).seq : null };
      },
      { items: [], next: null },
    );
  }
  versions(role, { before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
    return this.use(
      (db) => {
        const rows = db
          .prepare(
            "SELECT ordinal,payload FROM versions WHERE role=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?",
          )
          .all(role, before, limit + 1);
        const items = rows
          .slice(0, limit)
          .map((r) => ({ ...parse(r), ordinal: r.ordinal }));
        return {
          items,
          next: rows.length > limit ? items.at(-1).ordinal : null,
        };
      },
      { items: [], next: null },
    );
  }
  diff(role, from, to) {
    return this.use(
      (db) => {
        const find = (id) =>
            parse(
              db
                .prepare("SELECT payload FROM versions WHERE role=? AND id=?")
                .get(role, id),
            ),
          a = find(from),
          b = find(to);
        if (!a || !b) throw requestError("找不到所选版本", 404);
        try {
          return {
            from: a,
            to: b,
            before: a.hash ? this.store.getObject(a.hash) : null,
            after: b.hash ? this.store.getObject(b.hash) : null,
          };
        } catch {
          throw requestError("版本存在，但快照文件不可用", 404);
        }
      },
      () => {
        throw requestError("尚无版本记录", 404);
      },
    );
  }
  evidence(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw requestError("快照标识不正确");
    try {
      return this.store.getObject(hash);
    } catch {
      throw requestError("证据快照不可用", 404);
    }
  }
}
