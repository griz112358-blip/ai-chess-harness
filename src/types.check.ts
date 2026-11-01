/**
 * 任务 1.1 的类型层验收（不写运行时断言，靠 tsc 编译报错来验证）。
 * 1) assistant 消息可以携带 toolCalls
 * 2) tool 消息必须携带 toolCallId
 * 3) 缺 toolCallId / 多余 toolCalls 应当编译报错
 */
import type { AssistantMessage, Message, ToolCall, ToolMessage } from "./types.js";

const call: ToolCall = {
  id: "call_1",
  name: "readFile",
  arguments: { path: "package.json" },
};

// 1) assistant 消息携带 toolCalls ✅
const assistant: AssistantMessage = {
  id: "m1",
  createdAt: Date.now(),
  role: "assistant",
  content: "我来读一下文件。",
  toolCalls: [call],
};

// 2) tool 消息携带 toolCallId ✅
const toolMsg: ToolMessage = {
  id: "m2",
  createdAt: Date.now(),
  role: "tool",
  content: "{\"name\":\"harness-dev\"}",
  toolCallId: call.id,
  ok: true,
};

const messages: Message[] = [assistant, toolMsg];

// 窄化后能安全访问：只有 assistant 才有 toolCalls，只有 tool 才有 toolCallId
for (const m of messages) {
  if (m.role === "assistant") {
    const n = m.toolCalls?.length ?? 0;
    void n;
  } else if (m.role === "tool") {
    const id: string = m.toolCallId;
    void id;
  }
}

// @ts-expect-error tool 消息缺少必填的 toolCallId 应该报错
const badTool: ToolMessage = {
  id: "m3",
  createdAt: Date.now(),
  role: "tool",
  content: "x",
  ok: true,
};

const badAssistant: AssistantMessage = {
  id: "m4",
  createdAt: Date.now(),
  role: "assistant",
  content: "x",
  // @ts-expect-error assistant 消息不允许出现 toolCallId
  toolCallId: "call_1",
};

void badTool;
void badAssistant;
