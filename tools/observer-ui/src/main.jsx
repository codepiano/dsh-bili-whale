import React, { useEffect, useState, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  MantineProvider,
  createTheme,
  Button,
  Paper,
  Title,
  Text,
  Group,
  Stack,
  Badge,
  NativeSelect,
  TextInput,
  Drawer,
  Table,
  Loader,
  Alert,
  Pagination,
  Accordion,
  Progress,
  Divider,
  Code,
  Tooltip,
  ScrollArea,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
  IconFish,
  IconCirclesRelation,
  IconRoute,
  IconHistory,
  IconRefresh,
  IconArrowUpRight,
  IconLock,
  IconSearch,
  IconArrowRight,
  IconAlertCircle,
} from "@tabler/icons-react";
import "@mantine/core/styles.css";
import "./style.css";
import { lineChanges, displayContent } from "./diff.mjs";
const roles = {
  persona: "人格文件",
  personal_rendered: "学习倾向注入",
  personal: "personal 文件",
  concept_state: "概念状态",
  config: "配置",
  diary: "公开日记",
  private_diary: "私人日记",
};
const statusText = {
  accepted: "已接受",
  pending: "待评估",
  deferred: "暂缓",
  rejected: "已拒绝",
  present: "已保存",
  missing: "已删除",
  unreadable: "不可读取",
};
const tagText = {
  topic: "主题",
  belief: "观点",
  motive: "动机",
  word: "词汇",
  phrase: "惯用语",
  idiom: "成语",
  sentence_pattern: "句式",
};
const eventText = {
  "exploration.configured": "探索比例配置",
  "exploration.question_updated": "探索问题更新",
  "exploration.progress_recorded": "探索进展",
  "decision.previewed": "决策预演",
  "decision.committed": "实际选择",
  "feedback.recorded": "结果反馈",
  "snapshot.captured": "版本快照",
  "state.updated": "状态更新",
  "prompt.prepared": "提示已准备",
  "prompt.accepted": "宿主已接收",
  "host.session_event": "DS 会话事件",
  "response.completed": "响应归档",
  "personal.rendered": "学习倾向渲染",
};
const date = (x) => {
  if (x === null || x === undefined) return "未记录";
  const d = new Date(x);
  return Number.isNaN(d.getTime())
    ? "时间不可用"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(d);
};
const num = (x) => (Number.isFinite(x) ? x.toFixed(3) : "—");
const params = (values) =>
  new URLSearchParams(
    Object.entries(values).filter(
      ([, v]) => v !== null && v !== undefined && v !== "",
    ),
  ).toString();
async function api(url, signal) {
  const res = await fetch(url, { signal });
  let body;
  try {
    body = await res.json();
  } catch {
    throw Error("服务返回了无法读取的响应");
  }
  if (!res.ok) throw Error(body.error || "读取失败");
  return body;
}
function useData(url, revision = 0) {
  const [attempt, retry] = useState(0);
  const [state, set] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    if (!url) {
      set({ loading: false, data: null, error: null });
      return;
    }
    const abort = new AbortController();
    set({ loading: true, data: null, error: null });
    api(url, abort.signal)
      .then((data) => set({ loading: false, data, error: null }))
      .catch((e) => {
        if (e.name !== "AbortError")
          set({ loading: false, data: null, error: e.message });
      });
    return () => abort.abort();
  }, [url, revision, attempt]);
  return { ...state, retry: () => retry((n) => n + 1) };
}
function State({ state, children }) {
  if (state.loading)
    return (
      <div className="state">
        <Loader size="sm" />
        <Text c="dimmed" size="sm">
          正在读取本地记录
        </Text>
      </div>
    );
  if (state.error)
    return (
      <Alert
        color="red"
        icon={<IconAlertCircle size={18} />}
        title="读取未完成"
      >
        {state.error}
        <div>
          <Button
            mt="sm"
            size="xs"
            variant="light"
            color="red"
            onClick={state.retry}
          >
            重试读取
          </Button>
        </div>
      </Alert>
    );
  return children(state.data);
}
function Empty({
  title = "还没有记录",
  text = "此页面只读展示已有数据，不会生成或修改记录。",
}) {
  return (
    <div className="empty">
      <IconCirclesRelation size={30} stroke={1.2} />
      <Title order={3} size="h4" mt="md">
        {title}
      </Title>
      <Text c="dimmed" size="sm" mt="xs">
        {text}
      </Text>
    </div>
  );
}
function Stat({ label, value }) {
  return (
    <Paper className="stat" withBorder radius="md" p="md">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text className="stat-value">{value ?? "—"}</Text>
    </Paper>
  );
}
function SmallId({ value }) {
  return (
    <Tooltip label={value || "未关联"}>
      <Text component="span" className="mono small-id">
        {value ? value.slice(0, 12) : "未关联"}
      </Text>
    </Tooltip>
  );
}
function Evidence({ hash }) {
  const state = useData(hash ? "/api/evidence/" + hash : null);
  return (
    <State state={state}>
      {(d) => (
        <>
          {d?.redacted && (
            <Badge color="yellow" mb="xs">
              已脱敏的观察视图
            </Badge>
          )}
          <Code block className="evidence">
            {displayContent(d?.content)}
          </Code>
        </>
      )}
    </State>
  );
}
function CollectionDetail({ id, revision }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [id]);
  const state = useData(
    id
      ? `/api/collections/${encodeURIComponent(id)}?${params({ page })}`
      : null,
    revision,
  );
  return (
    <State state={state}>
      {(c) =>
        c && (
          <Stack gap="lg">
            <div>
              <Badge variant="light">
                {c.subject === "fish" ? "鱼的集合" : "用户的集合"}
              </Badge>
              <Title order={2} mt="sm">
                {c.name}
              </Title>
              <Text c="dimmed" size="sm">
                成员各自保留来源，相近内容不会被合并。
              </Text>
            </div>
            <Group grow>
              <Stat label="当前基础强度" value={num(c.strength)} />
              <Stat label="反馈奖励" value={num(c.reward)} />
            </Group>
            <Group gap="lg">
              <Text size="sm">熟悉 {num(c.familiarity)}</Text>
              <Text size="sm">好奇 {num(c.curiosity)}</Text>
              <Text size="sm">认同 {num(c.affinity)}</Text>
              <Text size="sm">置信 {num(c.confidence)}</Text>
            </Group>
            <div>
              <Text fw={600} size="sm" mb="xs">
                最近记录的场景疲劳
              </Text>
              {Object.keys(c.fatigue).length ? (
                Object.entries(c.fatigue).map(([scene, f]) => (
                  <Group
                    key={scene}
                    justify="space-between"
                    className="fatigue"
                  >
                    <Text size="sm">{scene}</Text>
                    <Text size="sm">
                      {num(f.value)} · {date(f.at)}
                    </Text>
                  </Group>
                ))
              ) : (
                <Text size="sm" c="dimmed">
                  尚无使用记录
                </Text>
              )}
            </div>
            <Divider />
            <Title order={3} size="h4">
              成员与来源 · {c.total}
            </Title>
            {c.items.map((m) => (
              <Paper key={m.id} withBorder p="md" radius="md">
                <Group justify="space-between" align="start">
                  <Text fw={600} className="wrap">
                    {m.content}
                  </Text>
                  <Badge color={m.status === "accepted" ? "teal" : "gray"}>
                    {statusText[m.status] || m.status}
                  </Badge>
                </Group>
                <Group gap={6} mt="sm">
                  {m.tags.map((t) => (
                    <Badge key={t} variant="outline" color="gray">
                      {tagText[t] || t}
                    </Badge>
                  ))}
                </Group>
                <Text size="xs" c="dimmed" mt="sm">
                  场景 {m.scene} · 解释 {m.interpretation}
                </Text>
                {m.triggers.length > 0 && (
                  <Text size="sm" mt="xs">
                    触发：{m.triggers.join("、")}
                  </Text>
                )}
                {m.exclusions.length > 0 && (
                  <Text size="sm" mt="xs">
                    不适用：{m.exclusions.join("、")}
                  </Text>
                )}
                <Text size="sm" mt="sm">
                  {m.review?.reason}
                </Text>
                <Paper className="source" p="sm" mt="sm">
                  <Text size="xs" c="dimmed">
                    来源 · {m.source?.actor ?? "未知"} /{" "}
                    {m.source?.type ?? "未记录"}
                  </Text>
                  <Text size="sm" mt={4} className="wrap">
                    {m.source?.excerpt ?? "来源记录不可用"}
                  </Text>
                </Paper>
              </Paper>
            ))}
            {c.total > 30 && (
              <Pagination
                total={Math.ceil(c.total / 30)}
                value={page}
                onChange={setPage}
              />
            )}
          </Stack>
        )
      }
    </State>
  );
}
function Collections({ revision }) {
  const [subject, setSubject] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState(null);
  const [query] = useDebouncedValue(search, 250);
  useEffect(() => setPage(1), [subject, query]);
  const state = useData(
    "/api/collections?" + params({ subject, query, page }),
    revision,
  );
  return (
    <>
      <Group className="toolbar" align="end">
        <TextInput
          label="查找集合"
          placeholder="例如：哲学、表达习惯"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search"
        />
        <NativeSelect
          label="归属主体"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          data={[
            { value: "", label: "全部主体" },
            { value: "fish", label: "鱼的集合" },
            { value: "user", label: "用户的集合" },
          ]}
        />
      </Group>
      <State state={state}>
        {(d) =>
          !d?.items.length ? (
            <Empty
              title={query ? "没有匹配的集合" : "尚未形成概念集合"}
              text={query ? "换一个名称，或清空筛选条件。" : undefined}
            />
          ) : (
            <>
              <Text size="sm" c="dimmed" mb="md">
                共 {d.total} 个集合 · 基础强度来自当前已接受成员及反馈
              </Text>
              <div className="collection-grid">
                {d.items.map((c) => (
                  <Paper
                    className="collection-card"
                    key={c.id}
                    withBorder
                    radius="lg"
                    p="lg"
                  >
                    <Group justify="space-between">
                      <Badge
                        variant="light"
                        color={c.subject === "fish" ? "teal" : "indigo"}
                      >
                        {c.subject === "fish" ? "鱼" : "用户"}
                      </Badge>
                      <Text size="xs" c="dimmed">
                        {c.accepted_count} / {c.member_count} 已接受
                      </Text>
                    </Group>
                    <Title order={3} size="h4" mt="lg" className="wrap">
                      {c.name}
                    </Title>
                    <Group justify="space-between" mt="lg">
                      <Text size="xs" c="dimmed">
                        基础强度
                      </Text>
                      <Text fw={650} className="mono">
                        {num(c.strength)}
                      </Text>
                    </Group>
                    <Progress
                      value={(c.strength / 3) * 100}
                      size={5}
                      mt={8}
                      color="teal"
                    />
                    <Group justify="space-between" mt="md">
                      <Text size="xs" c="dimmed">
                        奖励 {num(c.reward)}
                      </Text>
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        rightSection={<IconArrowUpRight size={15} />}
                        onClick={() => setSelected(c.id)}
                        aria-label={"查看集合 " + c.name}
                      >
                        查看成员
                      </Button>
                    </Group>
                  </Paper>
                ))}
              </div>
              {d.total > 12 && (
                <Pagination
                  value={page}
                  onChange={setPage}
                  total={Math.ceil(d.total / 12)}
                  mt="lg"
                />
              )}
            </>
          )
        }
      </State>
      <Drawer
        opened={!!selected}
        onClose={() => setSelected(null)}
        title="概念集合"
        size="680px"
        position="right"
      >
        <CollectionDetail id={selected} revision={revision} />
      </Drawer>
    </>
  );
}
function Trace({ trace, decision, revision }) {
  const [after, setAfter] = useState(0);
  useEffect(() => setAfter(0), [trace, decision]);
  const state = useData(
    trace || decision
      ? "/api/events?" +
          params({
            trace_id: trace,
            decision_id: trace ? null : decision,
            after,
          })
      : null,
    revision,
  );
  return (
    <State state={state}>
      {(d) =>
        !d?.items.length ? (
          <Text c="dimmed" size="sm">
            没有可关联的提示或会话事件；不根据时间猜测关联。
          </Text>
        ) : (
          <>
            <Accordion variant="separated">
              {d.items.map((e) => (
                <Accordion.Item key={e.id} value={e.id}>
                  <Accordion.Control>
                    <Group gap="sm">
                      <Badge size="sm" variant="light">
                        {eventText[e.type] || e.type}
                      </Badge>
                      <Text size="xs" c="dimmed">
                        {date(e.at)} · #{e.seq}
                      </Text>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    {e.type === "prompt.prepared" && (
                      <Text size="sm" mb="sm">
                        实际提供人设：
                        {e.data.included ? "本轮已注入" : "本轮去重跳过"} ·
                        人格版本{" "}
                        <SmallId value={e.data.versions?.persona?.id} />
                      </Text>
                    )}
                    <Code block className="evidence">
                      {JSON.stringify(e.data, null, 2)}
                    </Code>
                    {(e.data.object?.hash || e.data.prompt?.hash) && (
                      <Accordion mt="sm">
                        <Accordion.Item value="raw">
                          <Accordion.Control>查看证据快照</Accordion.Control>
                          <Accordion.Panel>
                            <Evidence
                              hash={e.data.object?.hash || e.data.prompt.hash}
                            />
                          </Accordion.Panel>
                        </Accordion.Item>
                      </Accordion>
                    )}
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
            {d.next && (
              <Button variant="light" mt="md" onClick={() => setAfter(d.next)}>
                下一段事件
              </Button>
            )}
            {after > 0 && (
              <Button
                variant="subtle"
                mt="md"
                ml="sm"
                onClick={() => setAfter(0)}
              >
                回到起点
              </Button>
            )}
          </>
        )
      }
    </State>
  );
}
function DecisionDetail({ id, revision }) {
  const state = useData(
    id ? "/api/decisions/" + encodeURIComponent(id) : null,
    revision,
  );
  return (
    <State state={state}>
      {(d) => {
        if (!d) return null;
        const p = d.preview,
          max = Math.max(...p.rows.map((r) => Math.abs(r.score)), 0.01);
        return (
          <Stack gap="lg">
            <div>
              <Group gap="xs">
                <Badge>{p.input.scene}</Badge>
                <Badge color={d.committed ? "teal" : "gray"}>
                  {d.committed ? "已提交实际选择" : "仅预演"}
                </Badge>
              </Group>
              <Title order={2} mt="sm">
                {p.input.question}
              </Title>
              <Text size="xs" c="dimmed" mt="sm">
                {date(p.at)} · {p.algorithm} · 种子 {p.input.seed}
              </Text>
            </div>
            <Paper p="md" className="decision-result" radius="md">
              <Text size="xs" c="dimmed">
                程序建议
              </Text>
              <Title order={3} mt={4}>
                {p.winner}
              </Title>
              <Text size="sm" mt="sm">
                实际选择：{d.committed?.selected ?? "尚未提交"}
                {d.committed?.overridden ? "（覆盖建议）" : ""}
              </Text>
              {d.committed && (
                <Text size="sm" mt={4}>
                  {d.committed.reason}
                </Text>
              )}
            </Paper>
            {p.exploration && (
              <Paper withBorder p="md" radius="md">
                <Stack gap="xs">
                  <Title order={3}>
                    探索路径：
                    {
                      {
                        deep: "领域深挖",
                        revisit: "稀疏群回访",
                        discover: "新词发现",
                      }[p.exploration.path]
                    }
                  </Title>
                  <Text size="sm">
                    比例（深挖 / 回访 / 发现）：
                    {["deep", "revisit", "discover"]
                      .map(
                        (key) =>
                          `${Math.round(p.exploration.config.ratios[key] * 100)}%`,
                      )
                      .join(" / ")}
                  </Text>
                  <Text size="sm">
                    规划依据：{p.exploration.planner_reason}
                  </Text>
                  <Text size="sm">本次探索理由：{p.exploration.reason}</Text>
                  {d.committed?.exploration &&
                    (() => {
                      const x = d.committed.exploration,
                        progress = x.progress;
                      return (
                        <>
                          <Text size="sm">
                            探索目标：
                            {x.target_snapshot.question ??
                              x.target_snapshot.name ??
                              x.target_snapshot.content}
                          </Text>
                          {x.target_snapshot.next_step && (
                            <Text size="sm">
                              计划下一步：{x.target_snapshot.next_step}
                            </Text>
                          )}
                          <Text size="sm">候选选择理由：{x.option_reason}</Text>
                          <Text size="sm">
                            实际进展：
                            {progress
                              ? {
                                  engaged: "已接触",
                                  completed: "已完成",
                                  skipped: "跳过",
                                  failed: "失败",
                                }[progress.outcome]
                              : "尚未记录实际接触，不计曝光"}
                          </Text>
                          {progress && (
                            <>
                              <Text size="sm">进展说明：{progress.reason}</Text>
                              <Text size="sm">
                                已回答：{progress.answered || "尚未确认"}
                              </Text>
                              <Text size="sm">
                                剩余问题：{progress.remaining || "未记录"}
                              </Text>
                              <Text size="sm">
                                下一步：{progress.next_step || "未记录"}
                              </Text>
                              <Text size="xs" c="dimmed">
                                来源：{progress.source_ids.join("、") || "无"} ·
                                调用方报告
                              </Text>
                            </>
                          )}
                        </>
                      );
                    })()}
                </Stack>
              </Paper>
            )}
            <div>
              <Text size="sm" fw={650} mb="sm">
                候选竞争
              </Text>
              {p.rows.map((r) => (
                <div className="score-row" key={r.label}>
                  <Group justify="space-between">
                    <Text size="sm" fw={600}>
                      {r.label}
                      {!r.eligible ? " · 不参与竞争" : ""}
                    </Text>
                    <Text size="sm" className="mono">
                      {num(r.score)}
                    </Text>
                  </Group>
                  <Progress
                    value={(Math.abs(r.score) / max) * 100}
                    color={
                      !r.eligible ? "gray" : r.score < 0 ? "orange" : "teal"
                    }
                    size={6}
                    mt={6}
                  />
                  <Text size="xs" c="dimmed" mt={6}>
                    基础贡献均值 {num(r.base)} + 扰动 {num(r.noise)}
                  </Text>
                  <Text size="sm" mt={5}>
                    {r.reason}
                  </Text>
                </div>
              ))}
            </div>
            <Alert color="gray" variant="light">
              评分使用当时归档的集合状态。相关度和论据强度由调用方提供，不等同于客观证据。
            </Alert>
            <Accordion
              multiple
              defaultValue={p.rows.slice(0, 1).map((r) => r.label)}
              variant="separated"
            >
              {p.rows.map((r) => (
                <Accordion.Item key={r.label} value={r.label}>
                  <Accordion.Control>{r.label} · 评分明细</Accordion.Control>
                  <Accordion.Panel>
                    <Text size="xs" c="dimmed" mb="sm">
                      每项 = 基础权重 × 相关度 × 论据强度 × (1 −
                      疲劳)，候选取均值后加扰动。
                    </Text>
                    {r.contributions.length ? (
                      <ScrollArea type="auto">
                        <Table withRowBorders className="contributions">
                          <Table.Thead>
                            <Table.Tr>
                              {[
                                "集合 / 成员",
                                "权重",
                                "相关度",
                                "论据",
                                "疲劳",
                                "贡献",
                              ].map((h) => (
                                <Table.Th key={h}>{h}</Table.Th>
                              ))}
                            </Table.Tr>
                          </Table.Thead>
                          <Table.Tbody>
                            {r.contributions.map((c, i) => (
                              <Table.Tr key={i}>
                                <Table.Td>
                                  <Text size="sm" fw={600}>
                                    {d.names[c.collection_id]}
                                  </Text>
                                  <Text size="xs" c="dimmed" className="wrap">
                                    {d.members[c.member_id]}
                                  </Text>
                                  <Text size="xs" mt={4}>
                                    {c.reason}
                                  </Text>
                                </Table.Td>
                                {[
                                  c.base,
                                  c.relevance,
                                  c.strength,
                                  c.fatigue,
                                  c.value,
                                ].map((v, i) => (
                                  <Table.Td key={i} className="mono">
                                    {num(v)}
                                  </Table.Td>
                                ))}
                              </Table.Tr>
                            ))}
                          </Table.Tbody>
                        </Table>
                      </ScrollArea>
                    ) : (
                      <Text size="sm" c="dimmed">
                        没有提交有效贡献，属于探索性候选。
                      </Text>
                    )}
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
            <div>
              <Title order={3} size="h4" mb="sm">
                反馈与变化
              </Title>
              {d.feedback.length ? (
                d.feedback.map((f) => (
                  <Paper key={f.id} withBorder p="md" radius="md" mb="sm">
                    <Group justify="space-between">
                      <Badge
                        color={
                          f.outcome === "positive"
                            ? "teal"
                            : f.outcome === "negative"
                              ? "orange"
                              : "gray"
                        }
                      >
                        {f.outcome === "positive"
                          ? "正反馈"
                          : f.outcome === "negative"
                            ? "负反馈"
                            : "尚无结论"}
                      </Badge>
                      <Text size="xs" c="dimmed">
                        {f.actor} · {date(f.at)}
                      </Text>
                    </Group>
                    <Text size="sm" mt="sm">
                      {f.reason}
                    </Text>
                    {f.changes.map((c) => (
                      <Text size="xs" c="dimmed" mt={4} key={c.id}>
                        {d.names[c.id] || c.id}：{num(c.before)} →{" "}
                        {num(c.after)}
                      </Text>
                    ))}
                  </Paper>
                ))
              ) : (
                <Text size="sm" c="dimmed">
                  尚无结果反馈；竞争胜负不自动赏罚。
                </Text>
              )}
            </div>
            <Divider />
            <Title order={3} size="h4">
              关联事件与证据
            </Title>
            <Text size="xs" c="dimmed">
              trace <SmallId value={d.trace_id} />
              {p.input.parent_decision_id && (
                <>
                  {" "}
                  · 父决策 <SmallId value={p.input.parent_decision_id} />
                </>
              )}
            </Text>
            <Trace
              trace={d.trace_id}
              decision={d.committed?.id}
              revision={revision}
            />
          </Stack>
        );
      }}
    </State>
  );
}
function Decisions({ revision }) {
  const [stage, setStage] = useState("all"),
    [before, setBefore] = useState(null),
    [history, setHistory] = useState([]),
    [selected, setSelected] = useState(null);
  useEffect(() => {
    setBefore(null);
    setHistory([]);
  }, [stage]);
  const state = useData(
    "/api/decisions?" + params({ stage, before }),
    revision,
  );
  return (
    <>
      <Group className="toolbar" align="end">
        <NativeSelect
          label="决策状态"
          value={stage}
          onChange={(e) => setStage(e.target.value)}
          data={[
            { value: "all", label: "全部决策" },
            { value: "committed", label: "已提交实际选择" },
            { value: "pending", label: "仅预演，尚未提交" },
          ]}
        />
        <Text size="sm" c="dimmed" pb={8}>
          按预演时间倒序展示，保留没有被提交的尝试。
        </Text>
      </Group>
      <State state={state}>
        {(d) =>
          !d?.items.length ? (
            <Empty title="没有匹配的决策记录" />
          ) : (
            <>
              <Paper withBorder radius="lg" className="table-paper">
                <Table highlightOnHover verticalSpacing="md">
                  <Table.Thead>
                    <Table.Tr>
                      {["问题与场景", "程序建议", "状态", "预演时间", ""].map(
                        (h, i) => (
                          <Table.Th key={i}>{h}</Table.Th>
                        ),
                      )}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {d.items.map((r) => (
                      <Table.Tr key={r.id}>
                        <Table.Td>
                          <Text fw={600} size="sm" className="wrap">
                            {r.question}
                          </Text>
                          <Text c="dimmed" size="xs" mt={4}>
                            {r.scene ?? "—"} · {r.options ?? "—"} 个候选
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{r.winner ?? "不可读取"}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge
                            color={r.committed ? "teal" : "gray"}
                            variant="light"
                          >
                            {r.committed ? "已提交" : "仅预演"}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {date(r.at)}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Button
                            size="compact-sm"
                            variant="subtle"
                            onClick={() => setSelected(r.id)}
                            aria-label={"查看决策 " + r.question}
                          >
                            查看过程 <IconArrowRight size={14} />
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Paper>
              <Group justify="space-between" mt="md">
                <Button
                  variant="default"
                  disabled={!history.length}
                  onClick={() => {
                    setBefore(history.at(-1));
                    setHistory((h) => h.slice(0, -1));
                  }}
                >
                  上一页
                </Button>
                <Button
                  variant="light"
                  disabled={!d.next}
                  onClick={() => {
                    setHistory((h) => [...h, before]);
                    setBefore(d.next);
                  }}
                >
                  下一页
                </Button>
              </Group>
            </>
          )
        }
      </State>
      <Drawer
        opened={!!selected}
        onClose={() => setSelected(null)}
        title="决策过程"
        size="860px"
        position="right"
      >
        <DecisionDetail id={selected} revision={revision} />
      </Drawer>
    </>
  );
}
function VersionDiff({ role, from, to, revision }) {
  const state = useData(
    from && to ? "/api/diff?" + params({ role, from, to }) : null,
    revision,
  );
  const diff = useMemo(
    () =>
      state.data
        ? lineChanges(
            state.data.before?.content ?? null,
            state.data.after?.content ?? null,
          )
        : null,
    [state.data],
  );
  return (
    <State state={state}>
      {(d) =>
        !d ? (
          <Empty title="选择两个版本进行比较" />
        ) : (
          <>
            <Group justify="space-between" mb="md">
              <Text size="sm">
                {date(d.from.at)} <span className="muted">→</span>{" "}
                {date(d.to.at)}
              </Text>
              <Group gap="xs">
                {!diff.limited && (
                  <>
                    <Badge color="teal">+{diff.added} 行</Badge>
                    <Badge color="red">−{diff.removed} 行</Badge>
                  </>
                )}
                {(d.before?.redacted || d.after?.redacted) && (
                  <Badge color="yellow">已脱敏</Badge>
                )}
              </Group>
            </Group>
            <Text size="xs" c="dimmed" mb="md">
              旧版：{statusText[d.from.status] || d.from.status} · 新版：
              {statusText[d.to.status] || d.to.status}
              。删除与不可读取状态不会被当作已保存内容。
            </Text>
            {diff.limited ? (
              <>
                <Alert color="yellow" mb="md">
                  内容较大，已切换为原文对照，未计算逐行增删。
                </Alert>
                <div className="raw-compare">
                  <Code block>{diff.before}</Code>
                  <Code block>{diff.after}</Code>
                </div>
              </>
            ) : (
              <div className="diff" aria-label="版本逐行差异">
                {diff.lines.length ? (
                  diff.lines.map((l, i) => (
                    <div className={"diff-line " + l.kind} key={i}>
                      <span className="line-no">{l.left ?? ""}</span>
                      <span className="line-no">{l.right ?? ""}</span>
                      <span className="sign">
                        {l.kind === "added"
                          ? "+"
                          : l.kind === "removed"
                            ? "−"
                            : " "}
                      </span>
                      <span className="diff-text">{l.text || " "}</span>
                    </div>
                  ))
                ) : (
                  <Text size="sm" c="dimmed" p="lg">
                    两个版本均无可读取正文。
                  </Text>
                )}
              </div>
            )}
          </>
        )
      }
    </State>
  );
}
function Versions({ overview, revision }) {
  const [role, setRole] = useState("persona"),
    [before, setBefore] = useState(null),
    [history, setHistory] = useState([]),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [cache, setCache] = useState({});
  const state = useData("/api/versions?" + params({ role, before }), revision);
  useEffect(() => {
    if (overview.roles.length && !overview.roles.includes(role))
      setRole(overview.roles[0]);
  }, [overview.roles.join("|")]);
  useEffect(() => {
    setBefore(null);
    setHistory([]);
    setFrom("");
    setTo("");
    setCache({});
  }, [role]);
  useEffect(() => {
    if (state.data?.items.length) {
      setCache((previous) => ({
        ...previous,
        ...Object.fromEntries(state.data.items.map((v) => [v.id, v])),
      }));
      setTo((old) => old || state.data.items[0].id);
      setFrom(
        (old) => old || (state.data.items[1]?.id ?? state.data.items[0].id),
      );
    }
  }, [state.data]);
  const items = state.data?.items ?? [],
    optionItems = [
      ...items,
      ...[cache[from], cache[to]].filter(
        (v) => v && !items.some((i) => i.id === v.id),
      ),
    ],
    options = [
      ...new Map(
        optionItems.map((v) => [
          v.id,
          {
            value: v.id,
            label: `${date(v.at)} · ${v.actor} · ${statusText[v.status] || v.status} · ${v.id.slice(0, 8)}`,
          },
        ]),
      ).values(),
    ];
  return (
    <>
      <Group className="toolbar" align="end">
        <NativeSelect
          label="关键文件"
          data={
            overview.roles.length
              ? overview.roles.map((r) => ({
                  value: r,
                  label: roles[r] ? `${roles[r]} · ${r}` : r,
                }))
              : [{ value: "persona", label: "人格文件 · persona" }]
          }
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={!overview.roles.length}
        />
        <Text size="sm" c="dimmed" pb={8}>
          这里只比较历史，不恢复文件或修改人设。
        </Text>
      </Group>
      <State state={state}>
        {(d) =>
          !d?.items.length ? (
            <Empty title="这个文件还没有版本记录" />
          ) : (
            <>
              <Paper withBorder radius="lg" p="lg">
                <div className="compare-controls">
                  <NativeSelect
                    label="旧版本"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    data={options}
                  />
                  <IconArrowRight className="compare-arrow" size={20} />
                  <NativeSelect
                    label="新版本"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    data={options}
                  />
                </div>
                <Divider my="lg" />
                <VersionDiff
                  role={role}
                  from={from}
                  to={to}
                  revision={revision}
                />
              </Paper>
              <Group justify="space-between" mt="md">
                <Text size="xs" c="dimmed">
                  当前载入 {items.length} 个版本；已选版本可保留，支持跨页比较。
                </Text>
                <Group>
                  <Button
                    variant="default"
                    disabled={!history.length}
                    onClick={() => {
                      setBefore(history.at(-1));
                      setHistory((h) => h.slice(0, -1));
                    }}
                  >
                    更新的版本
                  </Button>
                  <Button
                    variant="light"
                    disabled={!d.next}
                    onClick={() => {
                      setHistory((h) => [...h, before]);
                      setBefore(d.next);
                    }}
                  >
                    更早的版本
                  </Button>
                </Group>
              </Group>
            </>
          )
        }
      </State>
    </>
  );
}
const pages = {
  collections: {
    title: "概念集合",
    sub: "查看观点、兴趣与表达素材怎样积累，保留每个成员的来历。",
    icon: IconCirclesRelation,
  },
  decisions: {
    title: "决策过程",
    sub: "沿着候选、权重、疲劳与扰动，回看程序建议和实际选择。",
    icon: IconRoute,
  },
  versions: {
    title: "人格与版本",
    sub: "比较人格文件和关键状态的变化，区分磁盘版本与实际注入。",
    icon: IconHistory,
  },
};
function App() {
  const [page, setPage] = useState("collections"),
    [revision, setRevision] = useState(0);
  const state = useData("/api/overview", revision);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">
            <IconFish size={25} />
          </span>
          <div>
            <Text fw={750}>鱼的观察室</Text>
            <Text size="xs" c="dimmed">
              LOCAL OBSERVATORY
            </Text>
          </div>
        </div>
        <Text className="nav-caption">观察记录</Text>
        <nav>
          {Object.entries(pages).map(([key, p]) => (
            <button
              className={"nav-item " + (page === key ? "active" : "")}
              key={key}
              onClick={() => {
                setPage(key);
                window.scrollTo({ top: 0 });
              }}
              aria-current={page === key ? "page" : undefined}
            >
              <p.icon size={19} stroke={1.6} />
              <span>{p.title}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <IconLock size={17} />
          <Text size="xs" c="dimmed">
            本机只读视图
            <br />
            不修改状态，不触发学习
          </Text>
        </div>
      </aside>
      <main className="main">
        <header className="page-header">
          <div>
            <Group gap="sm">
              <Text className="eyebrow">BILI WHALE</Text>
              <Badge variant="outline" color="teal" size="sm">
                只读
              </Badge>
            </Group>
            <Title order={1} size={29} mt="sm">
              {pages[page].title}
            </Title>
            <Text size="sm" c="dimmed" mt={6}>
              {pages[page].sub}
            </Text>
          </div>
          <Button
            leftSection={<IconRefresh size={16} />}
            variant="default"
            onClick={() => setRevision((r) => r + 1)}
            loading={state.loading}
          >
            刷新记录
          </Button>
        </header>
        <State state={state}>
          {(overview) => (
            <>
              {!overview.available && (
                <Alert
                  color="gray"
                  mb="lg"
                  title={
                    overview.legacy
                      ? "检测到旧版日志，页面不会自动迁移"
                      : "尚未创建观察数据库"
                  }
                >
                  {overview.legacy
                    ? "请先使用观察 CLI 完成迁移，再刷新此页。"
                    : "启用观察并产生记录后，会在这里显示。页面本身不会创建数据库或生成数据。"}
                </Alert>
              )}
              <div className="stats">
                <Stat label="概念集合" value={overview.counts.collections} />
                <Stat label="决策预演" value={overview.counts.previews} />
                <Stat label="关键文件版本" value={overview.counts.versions} />
                <Paper className="last-event" p="md">
                  <Text size="xs" c="dimmed">
                    最近一条观察事件
                  </Text>
                  <Text size="sm" fw={500} mt="xs">
                    {overview.last_event
                      ? date(overview.last_event)
                      : "暂无记录"}
                  </Text>
                  <Text size="xs" c="dimmed" mt={4}>
                    北京时间 · 共 {overview.counts.events} 条事件
                  </Text>
                </Paper>
              </div>
              <section className="content" key={page}>
                {page === "collections" ? (
                  <Collections revision={revision} />
                ) : page === "decisions" ? (
                  <Decisions revision={revision} />
                ) : (
                  <Versions overview={overview} revision={revision} />
                )}
              </section>
            </>
          )}
        </State>
        <footer>
          本地 SQLite 与归档快照 · 观察记录说明行为，不能单独证明因果
        </footer>
      </main>
    </div>
  );
}
const theme = createTheme({
  primaryColor: "teal",
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
  defaultRadius: "md",
  components: {
    NativeSelect: {
      defaultProps: {
        rightSectionWidth: 38,
        styles: { input: { paddingInlineEnd: 46 } },
      },
    },
    Button: { defaultProps: { fw: 550 } },
    Drawer: {
      defaultProps: {
        padding: "lg",
        closeButtonProps: { "aria-label": "关闭详情" },
      },
    },
  },
});
createRoot(document.getElementById("root")).render(
  <MantineProvider theme={theme} forceColorScheme="light">
    <App />
  </MantineProvider>,
);
