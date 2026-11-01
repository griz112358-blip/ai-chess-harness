# AI 国际象棋陪练 · ai-chess-harness

一个**「大模型 + 本地业务适配器」**的完整 Demo：让 MiniMax 大模型陪人下国际象棋，
但大模型**不能直接碰棋盘**——它只能通过约定好的工具表达意图，真正的落子由本地代码执行。

> 这是独立项目，和 `harness-dev`（最小 Agent Harness 学习工程）互不依赖。
> 本项目自带一份 harness 核心（`src/`），可以单独运行、单独演进。

## 它在演示什么

大模型只能对话，通用模型不知道你的业务要什么。想让它「帮我做事」，得做一个适配器：

> 把本地业务信息、知识库、需求、约定好的操作方式发给大模型；
> 大模型理解规则后按规则返回结果；本地逻辑按返回的结果执行具体操作。

国际象棋是这套模式的最小完整样本：

| 适配器要素 | 本项目的实现 |
|---|---|
| 本地业务信息 | 棋盘 FEN、ASCII 棋盘、轮到谁、上一步、**当前合法走法列表** |
| 知识库 | `knowledge/*.md`，按开局/中局/残局 + 用户提问检索后注入 |
| 需求 | 陪练水平档位（新手/业余/俱乐部/大师）、人格、是否教学点评 |
| 约定好的操作方式 | 4 个工具：`make_move` / `say` / `resign` / `offer_draw` |

**最关键的一条边界**：模型永远不能直接改棋盘。它只能表达意图，
真正的落子由 `applyNotation` + chess.js 在本地执行，执行结果再回灌给模型。
模型说了不算，本地执行了才算。

## 快速开始

```bash
npm install

npm run dev     # 后端 8787 + 前端 5178，浏览器打开 http://localhost:5178
```

打开页面 → **先填 MiniMax API Key**（设置门）：

- 接入区域：国际站 `https://api.minimax.io/v1` / 国内站 `https://api.minimaxi.com/v1`
- 模型：默认 `MiniMax-M3`，可点「拉取」获取账号下可用模型
- 「测试连接」会先验证 Key 再进对局

Key 只存在浏览器 localStorage，每次请求随 `x-minimax-key` 头发给**本地**后端，不落盘。
也可以用环境变量 `MINIMAX_API_KEY` 兜底。

**没有 Key 也能先看效果**：

```bash
MINIMAX_MOCK=1 npm start   # 后端用假模型走棋，走法合法、事件链路完全一致
```

## 一次回合的完整链路

```
用户点格子 e2→e4
   ↓
后端校验走法合法 → 本地落子 → 快照下发前端
   ↓
组装上下文：system prompt(规则+人格) + 知识库片段 + 对话记忆 + 当前局面(含合法走法列表)
   ↓
调 MiniMax（流式） ── 模型返回 tool_calls: [say("你这步挺激进"), make_move("d5")]
   ↓
本地执行工具：
   say      → ok，把话推给前端
   make_move→ 校验 d5 是否在合法走法里 → 落子 → 返回**新的权威局面**给模型
   ↓
写回消息（toolCallId 严格对齐）→ 再次调模型 → 模型不再要工具 → 回合结束
```

界面右侧是聊天区，下面是 **Harness 运行日志**：实时显示
「请求模型 → 模型要调什么工具 → 工具返回了什么 → 棋子怎么落的」。

## token 用量与耗时

每步棋都会在**右侧聊天区**底部显示一条用量小结：

```
本回合 1 次调用 · 输入 826 / 输出 20 tokens · 耗时 3.4s
```

- **输入 / 输出 tokens**：来自接口返回的真实 usage。请求里开了 `stream_options.include_usage`，
  流末尾会带完整 usage 对象；若某些网关不认这个参数，会自动去掉重试一次。
- **耗时**：服务端实测的模型调用耗时（流式过程中逐块计时）。
- **多轮调用**：一个回合里模型可能被纠偏重试多次，会累计成"本回合 N 次调用"。
- **估算值**：接口没返回 usage 时（例如流被中断），退回本地按"字符数/4"粗估，
  界面会明确标注"估算值"，不冒充真实账单数据。

Harness 运行日志里还会逐次列出每次调用的用量，方便对比"哪一步思考最久"。

## 三个关键机制

**1. 自修复回路（`src/loop.ts`）**
模型给了非法走法？工具返回 `ok:false` + 当前合法走法列表，模型看到错误后自己改。
模型整轮没走子？适配器纠偏后重试（最多 3 次）。全程不让单个失败炸掉循环。

**2. 权威状态**
前端不持有规则。它拿服务端下发的 FEN 只做渲染和高亮，落子合法性 100% 由后端判定。
模型拿到的局面也是后端算出来的，不会出现"模型以为的棋盘"和"真实棋盘"不一致。

**3. 知识库按需注入**
整本棋书塞进上下文既费 token 又稀释重点。`server/knowledge.ts` 按阶段
（开局/中局/残局）和用户提问关键词挑小节，`[核心]` 标签的小节每回合都带。

## 目录结构

```
src/                    harness 核心（业务无关，可直接搬走复用）
  types.ts                Message / ToolCall / ToolResult / Tool / ModelResponse
  agentState.ts           会话状态：addMessage / getMessagesForModel / estimateTokens
  loop.ts                 通用「模型 → 工具 → 执行 → 写回」循环
  provider/
    minimax.ts            MiniMax（OpenAI 兼容）接入：流式 / 工具调用 / 错误码映射
    mock.ts               离线假模型
  *.check.ts              各层验收脚本

server/                 后端（Express）
  index.ts                路由 + SSE 事件流
  adapter.ts              适配器核心：组装上下文 → 调模型 → 执行工具 → 纠偏重试
  tools.ts                4 个工具：make_move / say / resign / offer_draw
  prompt.ts               system prompt + 局面消息
  knowledge.ts            知识库加载与检索
  gameStore.ts            对局会话（服务端唯一权威）

shared/                 前后端共享
  protocol.ts             协议类型
  board.ts                棋盘逻辑（合法走法、走法解析、快照）

knowledge/              本地知识库（principles / openings / endgame）
web/                    React 前端（棋盘 / 对话 / Harness 日志 / API Key 设置门）
check/adapter.check.ts  棋类适配器端到端验收
```

## 命令

```bash
npm run check      # 类型检查 + 5 个验收脚本，全量回归
npm run typecheck  # 只做类型检查（服务端 + 前端两套 tsconfig）
npm run build      # 打包前端到 web/dist
npm start          # 只起后端；若已 build，会顺带托管前端（http://localhost:8787）
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/session` | 新建对局，返回 `gameId` + 快照 |
| GET | `/api/game/:id` | 查当前快照 |
| POST | `/api/game/:id/move` | 用户走子 + AI 回合（SSE 事件流） |
| POST | `/api/game/:id/chat` | 聊天；轮到 AI 时顺带走子，轮到用户时只回应 |
| POST | `/api/game/:id/undo` | 悔棋（默认退 2 个半回合） |
| POST | `/api/game/:id/resign` | 认输 |
| POST | `/api/game/:id/draw` | 接受 / 拒绝和棋 |
| POST | `/api/game/:id/restart` | 重开 |
| POST | `/api/key/test` | 测 Key + 拉模型列表 |
| GET | `/api/models` | 账号下可用模型 |

## 想换成别的业务？

`src/loop.ts` 和 `src/provider/` 不认识「棋」，不用动。你只需要替换三样东西：

1. **工具表**（`server/tools.ts`）：换成你业务的动作声明 + 本地实现。
2. **上下文拼装**（`server/prompt.ts`）：换成你的业务信息 + 知识库。
3. **回合编排**（`server/adapter.ts`）：什么时候调模型、调几次、什么时候纠偏。

## 设计约定

- `Message` 是以 `role` 为判别字段的 discriminated union：
  - `assistant` → 可带 `toolCalls?: ToolCall[]`
  - `tool` → 必须带 `toolCallId: string`
- `ToolCall.arguments` 是**已解析对象**，provider 层负责把各家格式统一到这里。
- `ToolCall.id` 与 `ToolMessage.toolCallId` 必须严格一致。
- 工具抛出的异常由上层包装成 `ToolResult{ok:false}`，不让单个工具炸掉循环。
- 消息内部分两层：**内部 Message**（带 id/createdAt）↔ **ModelMessage**（provider 中立）。
- `estimateTokens` 是 ceil(字符数/4) 的粗估，不是真 tokenizer。
- MiniMax 的 `base_resp.status_code` 才是业务真相：HTTP 200 也可能是失败
  （1004 Key 无效 / 1008 余额不足 / 2056 Plan 窗口用尽 / 2013 参数不合法）。
- 工具返回 `{ ok: false, error }` 视为**业务失败**（`ToolResult.ok=false`），但保留原对象，
  这样模型能拿到结构化信息（比如哪些走法合法），而不是一句干巴巴的报错。
