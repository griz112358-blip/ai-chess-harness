/**
 * agentState.ts 的验收脚本（任务 1.2）
 * 用法：npx tsx src/agentState.check.ts
 *
 * 验收标准：临时脚本 add 若干消息后打印正确数组和估算 token 数。
 */

import {
  addAssistantMessage,
  addToolMessage,
  addUserMessage,
  createAgentState,
  estimateTokens,
  getMessagesForModel,
} from "./agentState.js";
import type { ToolCall } from "./types.js";

function line(t = "") {
  console.log(t);
}

// ---------- 建状态 + 加消息 ----------
const state = createAgentState("你是一个简洁的助手。");

addUserMessage(state, "你好，帮我读一下 package.json");
addAssistantMessage(state, "好的，我先调用 readFile 工具。", [
  {
    id: "call_001",
    name: "readFile",
    arguments: { path: "package.json" },
  } satisfies ToolCall,
]);
addToolMessage(state, {
  toolCallId: "call_001",
  name: "readFile",
  ok: true,
  result: '{"name":"harness-dev"}',
});
addAssistantMessage(state, "项目名叫 harness-dev。");

// ---------- 打印消息数组 ----------
line("=== 内部消息数组 ===");
for (const m of state.messages) {
  const extra =
    m.role === "assistant" && m.toolCalls
      ? ` toolCalls=[${m.toolCalls.map((c) => c.id).join(",")}]`
      : m.role === "tool"
        ? ` toolCallId=${m.toolCallId}`
        : "";
  line(`[${m.role}] id=${m.id} ${JSON.stringify(m.content)}${extra}`);
}

// ---------- 打印给模型的数组 ----------
line();
line("=== getMessagesForModel ===");
console.log(JSON.stringify(getMessagesForModel(state), null, 2));

// ---------- 打印估算 token ----------
line();
line("=== estimateTokens ===");
const total = estimateTokens(state.messages);
line(`整段会话: ${state.messages.length} 条消息, 估算 ${total} tokens`);
for (const m of state.messages) {
  line(`  ${m.role.padEnd(9)} ${String(estimateTokens(m)).padStart(5)} tokens  ${JSON.stringify(m.content.slice(0, 24))}`);
}
line(`纯字符串 "hello world" -> ${estimateTokens("hello world")} tokens`);
line(`空串 -> ${estimateTokens("")} tokens`);

// ---------- 自检断言 ----------
const model = getMessagesForModel(state);
let failures = 0;
function assert(cond: boolean, label: string) {
  if (!cond) {
    failures += 1;
    line(`❌ FAIL: ${label}`);
  } else {
    line(`✅ ${label}`);
  }
}

assert(state.messages.length === 5, "内部消息数组有 5 条（system+user+assistant+tool+assistant）");
assert(model.length === 5, "给模型的消息有 5 条");
assert(model[0]?.role === "system", "第 1 条是 system");
assert(model[1]?.role === "user", "第 2 条是 user");
assert(model[2]?.role === "assistant", "第 3 条是 assistant");
assert(model[2]?.toolCalls?.[0]?.id === "call_001", "assistant 消息带上了 toolCalls");
assert(model[3]?.role === "tool", "第 4 条是 tool");
assert(model[3]?.toolCallId === "call_001", "tool 消息带上了 toolCallId");
assert(
  model[2]?.toolCalls?.[0]?.id === model[3]?.toolCallId,
  "assistant.toolCall.id 与 tool.toolCallId 严格一致",
);
assert(!("id" in (model[0] ?? {})), "发给模型的消息不含本地 id 元信息");
const perMessageSum = state.messages.reduce((s, m) => s + estimateTokens(m), 0);
assert(
  perMessageSum >= total && perMessageSum - total < state.messages.length,
  `逐条相加(${perMessageSum}) 与整体估算(${total}) 只差分隔符开销`,
);
assert(
  estimateTokens("hello world") === Math.ceil("hello world".length / 4),
  "字符串估算 = ceil(字符数/4)",
);

line();
if (failures === 0) {
  line("全部通过 ✅");
} else {
  line(`${failures} 项未通过 ❌`);
  process.exitCode = 1;
}
