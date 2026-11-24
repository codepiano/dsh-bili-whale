// 日记以带日期的一级标题分篇。找不到标题的旧正文仍可完整阅读。
export function indexDiary(content) {
  const entries = new Map();
  let day = "";
  let start = 0;
  let fence = null;

  function save(end, nextDay) {
    const body = content.slice(start, end).trim();
    if (body) {
      if (!entries.has(day)) entries.set(day, []);
      entries.get(day).push(body);
    }
    start = end;
    day = nextDay;
  }

  for (const line of content.matchAll(/^.*$/gm)) {
    const fenceMark = line[0].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (fenceMark?.[1][0] === fence[0] &&
          fenceMark[1].length >= fence.length && !fenceMark[2].trim()) {
        fence = null;
      }
      continue;
    }
    if (fenceMark) {
      fence = fenceMark[1];
      continue;
    }
    const heading = line[0].match(/^ {0,3}#[ \t]+.*?\b(\d{4}-\d{2}-\d{2})\b/);
    if (heading && validDay(heading[1])) save(line.index, heading[1]);
  }
  save(content.length, "");
  return [...entries]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, sections]) => ({ key, content: sections.join("\n\n") }));
}

function validDay(day) {
  const date = new Date(day + "T00:00:00Z");
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === day;
}
