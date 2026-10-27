import { diffLines } from "diff";
export const displayContent = (value) =>
  value === null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
export function lineChanges(before, after) {
  const a = displayContent(before),
    b = displayContent(after);
  if (a.length + b.length > 400000)
    return { limited: true, before: a, after: b, lines: [] };
  const parts = diffLines(a, b, { timeout: 100, maxEditLength: 4000 });
  if (!parts) return { limited: true, before: a, after: b, lines: [] };
  let left = 0,
    right = 0;
  const lines = parts.flatMap((p) => {
    const values = p.value.split("\n");
    if (values.at(-1) === "") values.pop();
    return values.map((text) => ({
      text,
      kind: p.added ? "added" : p.removed ? "removed" : "same",
      left: p.added ? null : ++left,
      right: p.removed ? null : ++right,
    }));
  });
  return {
    limited: false,
    lines,
    added: lines.filter((l) => l.kind === "added").length,
    removed: lines.filter((l) => l.kind === "removed").length,
  };
}
