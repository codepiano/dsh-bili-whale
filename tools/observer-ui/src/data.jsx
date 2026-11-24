import React, { useEffect, useState } from "react";
import { Alert, Button, Loader, Text, Title } from "@mantine/core";
import { IconAlertCircle, IconCirclesRelation } from "@tabler/icons-react";

export const params = (values) =>
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
export function useData(url, revision = 0, retain = false) {
  const [attempt, retry] = useState(0);
  const [state, set] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    if (!url) {
      set({ loading: false, data: null, error: null });
      return;
    }
    const abort = new AbortController();
    set((previous) => ({
      loading: true,
      data: retain ? previous.data : null,
      error: null,
    }));
    api(url, abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) set({ loading: false, data, error: null });
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          set((previous) => ({
            loading: false,
            data: retain ? previous.data : null,
            error: e.message,
          }));
      });
    return () => abort.abort();
  }, [url, revision, attempt, retain]);
  return { ...state, retry: () => retry((n) => n + 1) };
}
export function State({ state, children }) {
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
export function Empty({
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
