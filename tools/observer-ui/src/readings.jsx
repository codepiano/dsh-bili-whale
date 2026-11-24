import React, { useEffect, useRef, useState } from "react";
import { Anchor, Badge, Button, Group, NativeSelect, Pagination, Paper, Text, TextInput, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconArrowLeft, IconArrowRight, IconArrowUpRight, IconBook2, IconSearch } from "@tabler/icons-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { State, params, useData } from "./data.jsx";
import { markdownComponents } from "./markdown.jsx";
import { validDay } from "../../lib/diary-index.mjs";

const kinds = {
  subtitles: "视频字幕",
  audio_transcript: "音频转写",
  web_page: "网页正文",
};
const formatDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  dateStyle: "medium",
  timeStyle: "short",
});
const archiveUrl = (options) => "?" + params({ page: "readings", ...options });
const diaryUrl = (tab, day) => "?" + params({ page: "logs", tab, day });

function routeFromUrl() {
  const route = new URLSearchParams(window.location.search);
  const kind = route.get("kind");
  const day = route.get("day") ?? "";
  const diaryDay = route.get("diaryDay") ?? "";
  const index = (key) => {
    const value = Number(route.get(key));
    return Number.isSafeInteger(value) && value > 1 ? value : undefined;
  };
  return {
    read: route.get("read")?.slice(0, 128) || undefined,
    part: index("part"),
    list: index("list"),
    query: route.get("query")?.slice(0, 300) || "",
    kind: Object.hasOwn(kinds, kind) ? kind : "",
    day: validDay(day) ? day : "",
    diary: route.get("diary") === "private" ? "private" : route.get("diary") === "public" ? "public" : undefined,
    diaryDay: validDay(diaryDay) ? diaryDay : undefined,
  };
}

const normalClick = (event) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

function ReadingMeta({ item }) {
  return (
    <Group gap={8} className="reading-meta">
      <Badge variant="light" color={item.kind === "web_page" ? "blue" : "teal"} size="sm">
        {kinds[item.kind]}
      </Badge>
      {item.at && <time dateTime={item.at}>{formatDate.format(new Date(item.at))}</time>}
      <span>{item.pages} 页</span>
    </Group>
  );
}

function Reader({ id, part, revision, selectPage, originDiary, originDay, sectionRef }) {
  const [plain, setPlain] = useState(false);
  const state = useData(id ? "/api/readings/text?" + params({ id, page: part }) : null, revision, true);
  return (
    <Paper component="section" withBorder className="reading-reader" ref={sectionRef} tabIndex={-1} aria-label="归档正文" aria-busy={Boolean(id && state.loading)}>
      {id ? (
        <State state={{ ...state, loading: !state.data && !state.error }}>
          {({ reading, page, text, redacted }) => {
            const previous = page > 1;
            const next = page < reading.pages;
            return (
              <>
                <header className="reading-header">
                  <ReadingMeta item={reading} />
                  <Title order={2}>{reading.title}</Title>
                  <Group gap="sm">
                    {reading.url && (
                      <Anchor size="sm" href={reading.url} target="_blank" rel="noopener noreferrer">
                        打开来源 <IconArrowUpRight size={13} aria-hidden="true" />
                      </Anchor>
                    )}
                    {(originDay || reading.day) && (
                      <Anchor size="sm" href={diaryUrl(originDiary ?? "public", originDay ?? reading.day)}>
                        {originDay ? "返回原日记" : "查看同日公开日记"}
                      </Anchor>
                    )}
                  </Group>
                </header>
                <div className="reading-toolbar">
                  <Text size="sm" c="dimmed" role="status">
                    第 {page} / {reading.pages} 页{redacted ? " · 含脱敏内容" : ""}
                  </Text>
                  <Group gap="xs">
                    {reading.kind === "web_page" && (
                      <Button size="compact-sm" variant="subtle" aria-pressed={plain}
                        onClick={() => setPlain(!plain)}>纯文本</Button>
                    )}
                    {reading.pages > 1 && (
                      <>
                        <Button size="compact-sm" variant="default" disabled={!previous}
                          onClick={() => selectPage(page - 1)}>上一页</Button>
                        <Button size="compact-sm" variant="default" disabled={!next}
                          onClick={() => selectPage(page + 1)}>下一页</Button>
                      </>
                    )}
                  </Group>
                </div>
                {reading.kind === "web_page" && !plain ? (
                  <article className="diary-prose reading-prose">
                    <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
                      {text}
                    </Markdown>
                  </article>
                ) : <div className="reading-prose reading-text">{text}</div>}
                {reading.pages > 1 && (
                  <Group className="reading-end" justify="space-between">
                    <Button variant="subtle" leftSection={<IconArrowLeft size={15} />}
                      disabled={!previous} onClick={() => selectPage(page - 1, true)}>上一页</Button>
                    <Button variant="light" rightSection={<IconArrowRight size={15} />}
                      disabled={!next} onClick={() => selectPage(page + 1, true)}>下一页</Button>
                  </Group>
                )}
              </>
            );
          }}
        </State>
      ) : (
        <div className="reading-blank">
          <IconBook2 size={30} stroke={1.4} aria-hidden="true" />
          <Text>从左侧选择一份归档</Text>
        </div>
      )}
    </Paper>
  );
}

export function Readings({ revision }) {
  const [route, setRoute] = useState(routeFromUrl);
  const [query] = useDebouncedValue(route.query.trim(), 200);
  const sectionRef = useRef(null);
  const { list, kind, day } = route;
  const state = useData("/api/readings?" + params({ query, kind, day, page: list }), revision, true);
  const selected = route.read ?? state.data?.items[0]?.id;
  const filtered = Boolean(route.query || day || kind);

  useEffect(() => {
    const onPop = () => setRoute(routeFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function navigate(next, replace = false) {
    window.history[replace ? "replaceState" : "pushState"](null, "", archiveUrl(next));
    setRoute(next);
  }
  function filter(changes) {
    navigate({ ...route, ...changes, read: undefined, part: undefined, list: undefined }, true);
  }

  return (
    <div className="reading-layout">
      <Paper component="aside" withBorder className="reading-list" aria-label="阅读归档列表">
        <search className="reading-filters" aria-label="筛选阅读归档">
          <TextInput
            type="search" label="搜索归档" placeholder="标题、链接或 BV 号"
            autoComplete="off" spellCheck={false} maxLength={300} value={route.query}
            onChange={(event) => filter({ query: event.currentTarget.value })}
            leftSection={<IconSearch size={16} aria-hidden="true" />}
          />
          <div className="reading-filter-row">
            <NativeSelect label="类型" value={kind}
              onChange={(event) => filter({ kind: event.currentTarget.value })}
              data={[{ value: "", label: "全部类型" }, ...Object.entries(kinds).map(
                ([value, label]) => ({ value, label }),
              )]}
            />
            <TextInput type="date" label="阅读日期" value={day}
              min="0001-01-01" max="9999-12-31"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (!value || validDay(value)) filter({ day: value });
              }} />
          </div>
        </search>
        <div className="reading-list-status">
          <Text size="sm" c="dimmed" role="status">
            {state.data ? `${state.data.total} 份归档 · 北京时间` : "读取归档"}
          </Text>
          {filtered && (
            <Button size="compact-xs" variant="subtle"
              onClick={() => filter({ query: "", kind: "", day: "" })}>清除筛选</Button>
          )}
        </div>
        <div aria-busy={state.loading || query !== route.query.trim()}>
          <State state={{ ...state, loading: state.loading && !state.data }}>
            {({ items, page, pages }) => items.length ? (
              <>
                <ul className="reading-list-items" role="list">
                  {items.map((item) => {
                    const next = { ...route, read: item.id, part: undefined };
                    return (
                      <li key={item.id}>
                        <a
                          className="reading-list-link" href={archiveUrl(next)}
                          aria-current={item.id === selected ? "page" : undefined}
                          onClick={(event) => {
                            if (!normalClick(event)) return;
                            event.preventDefault();
                            navigate(next);
                            const section = sectionRef.current;
                            if (section && !window.matchMedia("(min-width: 901px)").matches) {
                              section.scrollIntoView({ block: "start" });
                            }
                          }}
                        >
                          <span className="reading-list-title">{item.title}</span>
                          <ReadingMeta item={item} />
                        </a>
                      </li>
                    );
                  })}
                </ul>
                {pages > 1 && (
                  <Pagination size="sm" total={pages} value={page}
                    onChange={(list) => navigate({ ...route, list, read: undefined, part: undefined })}
                    getItemProps={(n) => ({ "aria-label": `归档列表第 ${n} 页` })} />
                )}
              </>
            ) : <Text size="sm" c="dimmed" p="sm">{filtered ? "没有匹配的归档" : "还没有已读原文归档"}</Text>}
          </State>
        </div>
      </Paper>
      <Reader key={selected ?? ""} id={selected} part={route.part ?? 1} revision={revision}
        sectionRef={sectionRef} originDiary={route.diary} originDay={route.diaryDay}
        selectPage={(part, scroll) => {
          navigate({ ...route, read: selected, part });
          if (scroll) {
            sectionRef.current?.focus({ preventScroll: true });
            sectionRef.current?.scrollIntoView({ block: "start" });
          }
        }}
      />
    </div>
  );
}

export function DiaryReadingLinks({ diary, day, revision }) {
  const state = useData("/api/readings/related?" + params({ diary, day }), revision);
  if (!state.data) return null;
  const { mentioned, sameDay, sameDayCount } = state.data;
  if (!mentioned.length && !sameDayCount) return null;
  return (
    <section className="diary-reading-links" aria-label="相关原文">
      <Group justify="space-between" gap="xs">
        <Title order={2} size="h4">阅读原文</Title>
        <Anchor size="sm" href={archiveUrl({ day, diary, diaryDay: day })}>查看当天全部归档</Anchor>
      </Group>
      {[[mentioned, "日记提及的来源"], [sameDay, "同日归档"]].map(([items, label]) => items.length > 0 && (
        <div key={label}>
          <Text fw={600} size="sm" mt="sm" mb={4}>{label}</Text>
          <ul className="diary-reading-list" role="list">
            {items.map((item) => (
              <li key={item.id}>
                <Anchor size="sm" href={archiveUrl({ read: item.id, diary, diaryDay: day })}>
                  {item.title}
                </Anchor>
                <Text size="xs" c="dimmed">{kinds[item.kind]} · {item.pages} 页</Text>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
