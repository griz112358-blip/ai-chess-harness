/**
 * loop.ts 的验收脚本（任务 1.6a ~ 1.6e）
 * 用法：npx tsx src/loop.check.ts
 *
 * 验收标准（用 mock 模型，不联网）：
 * - 模型给出工具调用 → 本地执行 → 结果写回消息 → 再调模型 → 直到模型不再要工具
 * - 工具抛异常不会炸掉循环，而是变成 ok:false 的 ToolResult 回给模型
 * - toolCallId 在 assistant 消息和 tool 消息之间严格一致
 */

import { addAssistantMessage, createAgentState, getMessagesForModel } from "./agentState.js";
import { executeToolCall, runAgentLoop, summarizeResult } from "./loop.js";
import type { LoopEvent } from "./loop.js";
import { createMockCallModel, makeTextResponse, makeToolCallResponse } from "./provider/mock.js";
import type { ToolTable } from "./types.js";

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

// ---------- 工具表 ----------
const tools: ToolTable = {
  make_move: {
    name: "make_move",
    description: "走一步棋",
    parameters: {
      type: "object",
      properties: { move: { type: "string" } },
      required: ["move"],
    },
    execute: (args) => {
      const move = String(args["move"] ?? "");
      if (move === "illegal") throw new Error("不是合法走法");
      return { ok: true, san: move };
    },
  },
  say: {
    name: "say",
    description: "说一句话",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    execute: (args) => ({ ok: true, echoed: String(args["message"] ?? "") }),
  },
};

// ---------- 场景 1：正常闭环：工具调用 → 执行 → 写回 → 再调模型 ----------
line("=== 场景 1：工具调用闭环 ===");
const state = createAgentState("你是测试助手。");
const events: LoopEvent[] = [];
const script = [
  makeToolCallResponse("make_move", { move: "e4" }, { text: "我先走 e4。" }),
  makeTextResponse("走完了。"),
];
const outcome = await runAgentLoop({
  state,
  tools,
  callModel: createMockCallModel(script),
  onEvent: (event) => {
    events.push(event);
    if (event.type === "tool_call") line(`→ tool_call ${event.name}(${JSON.stringify(event.arguments)})`);
    if (event.type === "tool_result") line(`← tool_result ${event.name} ok=${event.ok}`);
    if (event.type === "model_text_done") line(`  text: ${event.text}`);
  },
});

const modelMessages = getMessagesForModel(state);
line();
console.log(JSON.stringify(modelMessages, null, 2));

assert(outcome.steps === 2, "跑了两轮模型调用");
assert(outcome.text === "走完了。", "最终文本来自最后一轮");
assert(
  events.some((e) => e.type === "tool_call" && e.name === "make_move"),
  "收到了 make_move 工具调用",
);
assert(
  events.some((e) => e.type === "tool_result" && e.name === "make_move" && e.ok),
  "工具执行成功",
);
const assistantWithTool = modelMessages.find((m) => m.role === "assistant" && m.toolCalls);
const toolMessage = modelMessages.find((m) => m.role === "tool");
assert(Boolean(assistantWithTool), "assistant 消息带上了 toolCalls");
assert(Boolean(toolMessage), "工具结果被写回成 tool 消息");
assert(
  assistantWithTool?.toolCalls?.[0]?.id === toolMessage?.toolCallId,
  "assistant.toolCall.id 与 tool.toolCallId 严格一致",
);
assert(toolMessage?.content.includes("e4") === true, "工具结果内容写回了 tool 消息");

// ---------- 场景 2：工具抛异常 → 包成 ok:false，不炸循环 ----------
line();
line("=== 场景 2：工具异常不炸循环 ===");
const state2 = createAgentState("你是测试助手。");
const outcome2 = await runAgentLoop({
  state: state2,
  tools,
  callModel: createMockCallModel([
    makeToolCallResponse("make_move", { move: "illegal" }),
    makeTextResponse("抱歉，刚才那步不合法。"),
  ]),
});
const toolMessage2 = getMessagesForModel(state2).find((m) => m.role === "tool");
line(`tool 消息：${toolMessage2?.content}`);
assert(outcome2.steps === 2, "工具失败后循环继续跑完了");
assert(
  toolMessage2?.content.includes("不是合法走法") === true,
  "工具异常被包装成错误结果回给模型",
);

// ---------- 场景 3：未知工具 ----------
line();
line("=== 场景 3：未知工具名 ===");
const unknown = await executeToolCall(
  { id: "x1", name: "not_exists", arguments: {} },
  tools,
);
line(String(unknown.result));
assert(!unknown.ok, "未知工具返回 ok:false");
assert(String(unknown.result).includes("可用工具"), "错误信息告诉模型有哪些工具可用");

// ---------- 场景 4：模型不再要工具时退出 ----------
line();
line("=== 场景 4：没有工具调用就退出 ===");
const state4 = createAgentState("你是测试助手。");
const outcome4 = await runAgentLoop({
  state: state4,
  tools,
  callModel: createMockCallModel([makeTextResponse("只是聊天。")]),
});
assert(outcome4.steps === 1, "一轮就结束");
assert(getMessagesForModel(state4).length === 2, "只写回了一条 assistant 消息");

// ---------- 场景 5：最大轮数保护 ----------
line();
line("=== 场景 5：最大轮数保护 ===");
const state5 = createAgentState("你是测试助手。");
let calls = 0;
const outcome5 = await runAgentLoop({
  state: state5,
  tools,
  maxSteps: 3,
  callModel: async () => {
    calls += 1;
    return {
      text: "",
      toolCalls: [{ id: `c${calls}`, name: "say", arguments: { message: "hi" } }],
    };
  },
});
line(`实际调用模型 ${calls} 次`);
assert(calls === 3, "达到 maxSteps 后停手");
assert(outcome5.hitMaxSteps, "标记了 hitMaxSteps");

// ---------- 场景 6：摘要函数 ----------
line();
line("=== 场景 6：结果摘要 ===");
const summary = summarizeResult({ toolCallId: "a", name: "n", ok: true, result: "x".repeat(500) });
assert(summary.length <= 221, "超长结果被截断");

line();
if (failures === 0) {
  line("全部通过 ✅");
} else {
  line(`${failures} 项未通过 ❌`);
  process.exitCode = 1;
}
