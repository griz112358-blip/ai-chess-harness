/**
 * apps/chess/check/adapter.check.ts —— 棋类适配器的端到端验收
 * 用法：npx tsx apps/chess/check/adapter.check.ts
 *
 * 验收标准（全程离线，用 mock 模型）：
 * - 本地走法校验：SAN / UCI 都认，非法走法被拒绝并返回合法走法列表
 * - 知识库能按阶段检索出来
 * - 工具表：轮次校验、落子、认输、和棋提议
 * - 自修复回路：模型先给非法走法 → 工具报错 → 模型改走合法步 → 落子成功
 * - 完整回合：用户走一步 → AI 回合 → 棋盘前进两手
 */

import { createAgentState } from "../src/agentState.js";
import { runAgentLoop } from "../src/loop.js";
import { createMockCallModel, makeToolCallResponse } from "../src/provider/mock.js";
import {
  applyNotation,
  asciiBoard,
  describePosition,
  gamePhase,
  legalSanMoves,
  materialDiff,
} from "../shared/board.js";
import { runAITurn } from "../server/adapter.js";
import { loadKnowledge, selectKnowledge } from "../server/knowledge.js";
import { applyUserMove, createSession } from "../server/gameStore.js";
import { createChessTools } from "../server/tools.js";
import type { ServerEvent } from "../shared/protocol.js";

function line(t = "") {
  console.log(t);
}

/** 假配置：mock / 注入模型时不会真的发网络请求。 */
const mockConfig = {
  apiKey: "mock",
  baseUrl: "https://api.minimax.io/v1",
  model: "MiniMax-M3",
};

let failures = 0;
function assert(cond: boolean, label: string) {
  if (!cond) {
    failures += 1;
    line(`❌ FAIL: ${label}`);
  } else {
    line(`✅ ${label}`);
  }
}

// ---------- 1. 走法解析 ----------
line("=== 1. 本地走法校验 ===");
const game = createSession({ userColor: "w", level: "amateur" });
const legal = legalSanMoves(game.chess);
line(`开局合法走法（${legal.length} 个）：${legal.join(" ")}`);
assert(legal.includes("e4") && legal.includes("Nf3"), "初始局面的合法走法正确");

const sanResult = applyNotation(game.chess, "e4");
assert(sanResult.ok && sanResult.ok && sanResult.san === "e4", "SAN 走法 e4 被接受");

const uciGame = createSession({ userColor: "w" });
const uciResult = applyNotation(uciGame.chess, "g1f3");
assert(uciResult.ok && uciResult.ok && uciResult.san === "Nf3", "UCI 走法 g1f3 被接受");

const badGame = createSession({ userColor: "w" });
const badResult = applyNotation(badGame.chess, "Qh5");
assert(!badResult.ok, "非法走法 Qh5 被拒绝");
if (!badResult.ok) {
  line(`拒绝原因：${badResult.error}`);
  assert(badResult.legal.includes("e4"), "拒绝时把合法走法列表回给了模型");
}

// ---------- 2. 局面信息 ----------
line();
line("=== 2. 局面信息 ===");
line(asciiBoard(game.chess));
line(describePosition(game.chess));
assert(materialDiff(game.chess) === 0, "初始局面子力持平");
assert(gamePhase(game.chess) === "opening", "初始局面判定为开局阶段");
assert(game.chess.turn() === "b", "用户走 e4 后轮到黑方（AI）");

// ---------- 3. 知识库检索 ----------
line();
line("=== 3. 知识库检索 ===");
const knowledge = loadKnowledge();
line(`载入 ${knowledge.length} 个小节`);
assert(knowledge.length >= 8, "知识库小节数量足够");
const openingKb = selectKnowledge(knowledge, { phase: "opening", userMessage: "开局该怎么走？" });
line(`开局检索片段（${openingKb.length} 字）：`);
line(openingKb.slice(0, 200) + "…");
assert(openingKb.includes("中心"), "开局检索包含开局相关内容");
assert(openingKb.includes("核心") || openingKb.includes("中心优先"), "检索结果包含核心原则");

const endgameKb = selectKnowledge(knowledge, { phase: "endgame", userMessage: "" });
assert(endgameKb.includes("王"), "残局检索包含残局内容");

// ---------- 4. 工具表 ----------
line();
line("=== 4. 棋类工具表 ===");
const toolSession = createSession({ userColor: "w" });
const tools = createChessTools(toolSession);
assert(Object.keys(tools).join(",") === "make_move,say,resign,offer_draw", "工具表就是约定的 4 个动作");

const early = await tools["make_move"]!.execute({ move: "e5" });
line(`轮次不对时：${JSON.stringify(early)}`);
assert((early as { ok: boolean }).ok === false, "不是 AI 的回合时拒绝走子");

toolSession.chess.move("e4"); // 用户走了 e4，现在轮到 AI
const illegal = await tools["make_move"]!.execute({ move: "Qh5" });
line(`非法走法：${JSON.stringify(illegal).slice(0, 160)}`);
assert((illegal as { ok: boolean }).ok === false, "非法走法被拒绝");
assert(
  JSON.stringify(illegal).includes("合法走法"),
  "拒绝信息里带上了合法走法列表",
);

const legalMove = await tools["make_move"]!.execute({ move: "e5" });
line(`合法走法：${JSON.stringify(legalMove).slice(0, 200)}`);
assert((legalMove as { ok: boolean }).ok === true, "合法走法被接受并执行");
assert(toolSession.chess.history().join(",") === "e4,e5", "棋盘上真的落了两步棋");

const twice = await tools["make_move"]!.execute({ move: "Nf3" });
assert((twice as { ok: boolean }).ok === false, "同一回合不能连走两步");

// ---------- 5. 自修复回路 ----------
line();
line("=== 5. 自修复回路（先非法、后合法） ===");
const repairSession = createSession({ userColor: "w" });
repairSession.chess.move("e4"); // 用户先走一步，现在轮到 AI（黑方）
const repairTools = createChessTools(repairSession);
const repairState = createAgentState("你是国际象棋陪练。");
const repairScript = [
  makeToolCallResponse("make_move", { move: "Qh5" }), // 非法
  makeToolCallResponse("make_move", { move: "e5" }), // 改正
  makeToolCallResponse("say", { message: "我先发展马翼。" }),
];
const repairOutcome = await runAgentLoop({
  state: repairState,
  tools: repairTools,
  callModel: createMockCallModel(repairScript),
  maxSteps: 5,
});
line(`跑了 ${repairOutcome.steps} 轮，最终文本：${repairOutcome.text}`);
assert(repairOutcome.steps >= 2, "非法走法后循环继续跑");
assert(repairSession.chess.history().join(",") === "e4,e5", "非法走法被拒后改走合法棋（e4/e5）");

// ---------- 6. 完整回合 ----------
line();
line("=== 6. 完整 AI 回合（mock 模型） ===");
const session = createSession({ userColor: "w", level: "club", coaching: true });
session.chess.move("e4");
const events: ServerEvent[] = [];
const turn = await runAITurn(session, {
  config: {
    apiKey: "mock",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
  },
  userMessage: "开局我该怎么走？",
  emit: (event) => {
    events.push(event);
    if (event.type === "tool_call") line(`→ ${event.name}(${JSON.stringify(event.arguments)})`);
    if (event.type === "tool_result") line(`← ${event.name} ok=${event.ok} ${event.summary.slice(0, 80)}`);
  },
  mock: true,
});
line(`AI 回合：moved=${turn.moved} rounds=${turn.rounds}`);
line(`棋谱：${session.chess.history().join(" ")}`);
assert(turn.moved, "AI 落子了");
assert(session.chess.history().length === 2, "棋盘上正好两手棋");
assert(
  events.some((e) => e.type === "tool_call" && e.name === "make_move"),
  "日志里有 make_move 工具调用",
);
assert(
  events.some((e) => e.type === "tool_result" && e.name === "make_move" && e.ok),
  "日志里有工具执行结果",
);

// ---------- 7. 认输 / 和棋 ----------
line();
line("=== 7. 认输与和棋提议 ===");
const resignSession = createSession({ userColor: "w" });
const resignTools = createChessTools(resignSession);
await resignTools["resign"]!.execute({});
assert(resignSession.gameOver === true, "认输后对局结束");
assert(resignSession.result === "1-0", "AI（黑方）认输 → 白方胜（1-0）");

const drawSession = createSession({ userColor: "w" });
const drawTools = createChessTools(drawSession);
await drawTools["offer_draw"]!.execute({});
assert(drawSession.drawOffer?.by === "b", "和棋提议记录了发起方");

// ---------- 8. 多回合回归：第二轮 AI 仍能落子 ----------
line();
line("=== 8. 多回合回归（第二轮 AI 仍能落子）===");
const multiSession = createSession({ userColor: "w" });
const firstUserMove = applyUserMove(multiSession, "d2", "d4");
assert(firstUserMove.ok, "用户第一手 d4 被接受");
await runAITurn(multiSession, {
  config: mockConfig,
  emit: () => {},
  mock: true,
});
assert(multiSession.chess.history().length === 2, "第一回合 AI 落子了");

// 用户第二手：挑一个当前合法走法
const secondOptions = multiSession.chess.moves({ verbose: true });
const secondPick = secondOptions.find((m) => m.piece === "p") ?? secondOptions[0]!;
const secondUserMove = applyUserMove(multiSession, secondPick.from, secondPick.to);
assert(secondUserMove.ok, `用户第二手 ${secondPick.san} 被接受`);
await runAITurn(multiSession, {
  config: mockConfig,
  emit: () => {},
  mock: true,
});
line(`两轮后棋谱：${multiSession.chess.history().join(" ")}`);
assert(
  multiSession.chess.history().length === 4,
  "第二轮 AI 仍然落子了（aiMoved 标记已正确重置）",
);

// ---------- 9. 模型只回文字不调工具：文字进聊天 + 兜底不卡死 ----------
line();
line("=== 9. 模型只回文字（不调工具）===");
const textOnlySession = createSession({ userColor: "w" });
applyUserMove(textOnlySession, "d2", "d4");
const textOnlyEvents: ServerEvent[] = [];
await runAITurn(textOnlySession, {
  config: mockConfig,
  emit: (event) => textOnlyEvents.push(event),
  // 模拟真实故障：模型把走法用自然语言描述出来了，却没调 make_move
  callModel: async () => ({ text: "我想走 d5，但不确定合不合法。", toolCalls: [] }),
});
const chatTexts = textOnlyEvents.filter((e) => e.type === "chat").map((e) => (e as { text: string }).text);
line(`聊天区收到 ${chatTexts.length} 条：${chatTexts.join(" / ").slice(0, 120)}`);
assert(chatTexts.length > 0, "模型说的文字被送到了聊天区");
assert(
  textOnlySession.chess.history().length === 2,
  "模型始终不落子时，系统代走一步，对局没有卡死",
);
assert(
  textOnlyEvents.some((e) => e.type === "status" && e.text.includes("代走")),
  "日志里明确标注了「系统代走」，不冒充模型",
);

line();
if (failures === 0) {
  line("全部通过 ✅");
} else {
  line(`${failures} 项未通过 ❌`);
  process.exitCode = 1;
}
