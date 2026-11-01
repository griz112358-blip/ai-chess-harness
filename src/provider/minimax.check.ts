/**
 * provider/minimax.ts 的验收脚本（任务 1.3 / 1.6b）
 * 用法：npx tsx src/provider/minimax.check.ts
 *
 * 验收标准：
 * - provider 各家字段差异被抹平成统一的 ToolCall（arguments 已解析成对象）
 * - 消息/工具能正确映射成 OpenAI 兼容格式
 * - MiniMax 的 base_resp 业务错误能被识别（HTTP 200 也可能是失败）
 */

import {
  assertBusinessOk,
  MiniMaxError,
  parseText,
  parseToolArguments,
  parseToolCalls,
  parseUsage,
  toWireMessages,
  toWireTools,
} from "./minimax.js";
import type { ToolTable } from "../types.js";

function line(t = "") {
  console.log(t);
}

let failures = 0;
function assert(cond: boolean, label: string) {
  if (!cond) {
    failures += 1;
    line(`❌ FAIL: ${label}`);
  } else {
    line(`✅ ${label}`);
  }
}

// ---------- 1. tool_calls 字段映射 ----------
const rawResponse = {
  choices: [
    {
      message: {
        role: "assistant",
        content: "我来走一步。",
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "make_move", arguments: '{"move":"e4"}' },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
};

const calls = parseToolCalls(rawResponse);
line("=== parseToolCalls ===");
console.log(JSON.stringify(calls, null, 2));

assert(calls.length === 1, "解析出 1 个工具调用");
assert(calls[0]?.id === "call_abc", "工具调用 id 来自 provider");
assert(calls[0]?.name === "make_move", "工具名正确");
assert(calls[0]?.arguments["move"] === "e4", "arguments 字符串被解析成对象");
assert(parseText(rawResponse) === "我来走一步。", "文本内容解析正确");
assert(parseUsage(rawResponse)?.totalTokens === 150, "token 用量解析正确");

// ---------- 2. arguments 兼容：对象 / 裸字符串 / 空 ----------
assert(
  parseToolArguments({ a: 1 }).a === 1,
  "arguments 已经是对象时原样返回",
);
assert(
  parseToolArguments('{"b":2}').b === 2,
  "arguments 是 JSON 字符串时解析",
);
assert(
  (parseToolArguments("e4") as Record<string, unknown>)["value"] === "e4",
  "arguments 是裸字符串时兜底成 { value }",
);
assert(Object.keys(parseToolArguments("")).length === 0, "arguments 为空返回空对象");

// ---------- 3. 缺字段的健壮性 ----------
assert(parseToolCalls({}).length === 0, "空响应不炸");
assert(parseToolCalls({ choices: [{}] }).length === 0, "缺 message 不炸");
assert(parseText({ choices: [{ message: { content: null } }] }) === "", "content 为 null 返回空串");

// ---------- 4. 消息映射 ----------
const wireMessages = toWireMessages([
  { role: "system", content: "你是陪练" },
  { role: "user", content: "走一步" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "c1", name: "make_move", arguments: { move: "e4" } }],
  },
  { role: "tool", content: '{"ok":true}', toolCallId: "c1" },
]);
line();
line("=== toWireMessages ===");
console.log(JSON.stringify(wireMessages, null, 2));

assert(wireMessages[2]?.tool_calls?.[0]?.function?.arguments === '{"move":"e4"}', "工具参数序列化回字符串");
assert(wireMessages[2]?.tool_calls?.[0]?.id === "c1", "tool_calls 带 id");
assert(wireMessages[3]?.tool_call_id === "c1", "tool 消息映射成 tool_call_id");
assert(wireMessages[3]?.role === "tool", "tool 消息 role 正确");

// ---------- 5. 工具声明映射 ----------
const tools: ToolTable = {
  make_move: {
    name: "make_move",
    description: "走一步棋",
    parameters: {
      type: "object",
      properties: { move: { type: "string" } },
      required: ["move"],
    },
    execute: () => ({ ok: true }),
  },
};
const wireTools = toWireTools(tools);
line();
line("=== toWireTools ===");
console.log(JSON.stringify(wireTools, null, 2));
assert(wireTools[0]?.type === "function", "工具声明带 type=function");
assert(wireTools[0]?.function?.name === "make_move", "工具声明带 name");

// ---------- 6. 业务错误识别（HTTP 200 也可能是失败） ----------
let threw = false;
try {
  assertBusinessOk({ base_resp: { status_code: 1004, status_msg: "invalid api key" } }, 200);
} catch (error) {
  threw = true;
  const e = error as MiniMaxError;
  line();
  line(`捕获错误：${e.message} | code=${e.code} | hint=${e.hint}`);
  assert(e.code === 1004, "错误码被提取");
  assert(typeof e.hint === "string" && e.hint.length > 0, "给出了中文提示");
}
assert(threw, "base_resp.status_code != 0 时抛出异常");

let ok = true;
try {
  assertBusinessOk({ base_resp: { status_code: 0, status_msg: "success" } }, 200);
} catch {
  ok = false;
}
assert(ok, "status_code = 0 时不抛异常");

line();
if (failures === 0) {
  line("全部通过 ✅");
} else {
  line(`${failures} 项未通过 ❌`);
  process.exitCode = 1;
}
