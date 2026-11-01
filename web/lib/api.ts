/**
 * apps/chess/web/lib/api.ts —— 前端与后端的通信
 *
 * 后端用 SSE 推事件，但 SSE 原生只支持 GET。
 * 这里用 fetch + ReadableStream 自己解 SSE 帧，POST 也能拿到流式事件。
 */

import type { ServerEvent } from "../../shared/protocol";

/** 发一次请求并逐条接收服务端事件。 */
export async function streamEvents(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  onEvent: (event: ServerEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const json = JSON.parse(text) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      /* 保留原始文本 */
    }
    throw new Error(message || `请求失败（HTTP ${res.status}）`);
  }

  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as ServerEvent);
        } catch {
          /* 忽略坏帧 */
        }
      }
    }
  }
}

/** 普通 JSON 请求。 */
export async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  if (!res.ok) {
    const message = (parsed as { error?: string }).error ?? `请求失败（HTTP ${res.status}）`;
    throw new Error(message);
  }
  return parsed as T;
}

export async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as T) : ({} as T);
  return parsed;
}
