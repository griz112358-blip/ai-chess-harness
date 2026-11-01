/**
 * apps/chess/server/index.ts —— 后端服务
 *
 * 职责：
 * - 保存对局状态（唯一权威）
 * - 接收用户走子 → 本地校验执行 → 触发 AI 回合
 * - 用 SSE 把「模型说了什么、调了什么工具、工具执行结果、棋盘更新」实时推给前端
 *
 * API Key 处理：前端填好后随请求头 x-minimax-key 传过来，服务端只在本次请求里用，
 * 不落盘、不写日志。也可以用环境变量 MINIMAX_API_KEY 兜底。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import { Chess } from "chess.js";
import { callModel, listModels } from "../src/provider/minimax.js";
import type { MiniMaxConfig } from "../src/provider/minimax.js";
import { legalSanMoves } from "../shared/board.js";
import type { CoachLevel, PlayerColor, ServerEvent } from "../shared/protocol.js";
import { runAITurn, snapshotOf } from "./adapter.js";
import { createSession, getSession, pushChat, undoPlies, type GameSession } from "./gameStore.js";

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(here, "..", "web", "dist");

const DEFAULT_BASE_URL = process.env["MINIMAX_BASE_URL"] ?? "https://api.minimax.io/v1";
const DEFAULT_MODEL = process.env["MINIMAX_MODEL"] ?? "MiniMax-M3";
const MOCK = process.env["MINIMAX_MOCK"] === "1";

const app = express();
app.use(express.json({ limit: "256kb" }));

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

interface ClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  disableThinking: boolean;
  mock: boolean;
}

function readConfig(req: Request): ClientConfig {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const headerKey = req.header("x-minimax-key") ?? "";
  const bodyKey = typeof body["apiKey"] === "string" ? body["apiKey"] : "";
  const apiKey = (bodyKey || headerKey || (process.env["MINIMAX_API_KEY"] ?? "")).trim();
  const baseUrl =
    (typeof body["baseUrl"] === "string" && body["baseUrl"].trim()) || DEFAULT_BASE_URL;
  const model = (typeof body["model"] === "string" && body["model"].trim()) || DEFAULT_MODEL;
  const temperature = typeof body["temperature"] === "number" ? body["temperature"] : 0.7;
  const disableThinking = body["disableThinking"] === true;
  const mock = MOCK || body["mock"] === true;
  return { apiKey, baseUrl, model, temperature, disableThinking, mock };
}

function toMiniMaxConfig(config: ClientConfig): MiniMaxConfig {
  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    maxTokens: 4096,
    timeoutMs: 120_000,
    thinking: config.disableThinking ? "disabled" : undefined,
  };
}

/** 打开 SSE 通道，返回一个下发事件的函数。 */
function openSse(res: Response): (event: ServerEvent) => void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  return (event: ServerEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

function requireSession(req: Request, res: Response): GameSession | undefined {
  const id = String(req.params["id"] ?? "");
  const session = getSession(id);
  if (!session) {
    res.status(404).json({ error: "对局不存在或已过期，请新建一局。" });
    return undefined;
  }
  return session;
}

function errorHint(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const e = error as { hint?: string; message?: string };
    if (typeof e.hint === "string") return e.hint;
    if (typeof e.message === "string" && e.message.length > 0) return e.message;
  }
  return undefined;
}

/** 用户走子：本地校验 + 执行。 */
function applyUserMove(
  session: GameSession,
  from: string,
  to: string,
  promotion?: string,
): { ok: true; san: string } | { ok: false; error: string } {
  if (session.gameOver) return { ok: false, error: "对局已经结束了。" };
  if (session.chess.turn() !== session.userColor) return { ok: false, error: "现在不是你的回合。" };
  const legal = session.chess.moves({ verbose: true });
  const match = legal.find((m) => {
    if (m.from !== from || m.to !== to) return false;
    if (m.promotion) return promotion ? m.promotion === promotion : false;
    return true;
  });
  if (!match) {
    if (legal.some((m) => m.from === from && m.to === to && m.promotion)) {
      return { ok: false, error: "这是一步升变，请选择后/车/象/马。" };
    }
    return {
      ok: false,
      error: `这一步不合法。当前合法走法：${legalSanMoves(session.chess).join(" ")}`,
    };
  }
  const move = session.chess.move(match.san);
  return { ok: true, san: move.san };
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

/** 新建一局。 */
app.post("/api/session", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const userColor: PlayerColor = body["userColor"] === "b" ? "b" : "w";
  const level: CoachLevel =
    body["level"] === "beginner" || body["level"] === "club" || body["level"] === "master"
      ? body["level"]
      : "amateur";
  const coaching = body["coaching"] !== false;
  const session = createSession({ userColor, level, coaching });
  res.json({ gameId: session.id, snapshot: snapshotOf(session) });
});

/** 查询一局。 */
app.get("/api/game/:id", (req: Request, res: Response) => {
  const session = requireSession(req, res);
  if (!session) return;
  res.json({ snapshot: snapshotOf(session) });
});

/** 用户走子 + AI 回合（SSE）。 */
app.post("/api/game/:id/move", async (req: Request, res: Response) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const from = typeof body["from"] === "string" ? body["from"] : "";
  const to = typeof body["to"] === "string" ? body["to"] : "";
  const promotion = typeof body["promotion"] === "string" ? body["promotion"] : undefined;

  const result = applyUserMove(session, from, to, promotion);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  const emit = openSse(res);
  try {
    const config = readConfig(req);
    if (!config.mock && !config.apiKey) {
      emit({ type: "error", message: "还没有配置 API Key，请先在设置里填写。", hint: "设置 → API Key" });
      emit({ type: "done" });
      res.end();
      return;
    }
    emit({ type: "board", snapshot: snapshotOf(session) });
    emit({ type: "status", text: `你走了 ${result.san}，AI 正在想……` });

    if (!session.gameOver && session.chess.turn() === session.aiColor) {
      await runAITurn(session, { config: toMiniMaxConfig(config), emit, mock: config.mock });
    }
    emit({ type: "board", snapshot: snapshotOf(session) });
    emit({ type: "done" });
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error), hint: errorHint(error) });
    emit({ type: "done" });
  } finally {
    res.end();
  }
});

/** 用户聊天 + AI 回合（SSE）。 */
app.post("/api/game/:id/chat", async (req: Request, res: Response) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof body["message"] === "string" ? body["message"].trim() : "";

  const emit = openSse(res);
  try {
    const config = readConfig(req);
    if (!config.mock && !config.apiKey) {
      emit({ type: "error", message: "还没有配置 API Key，请先在设置里填写。", hint: "设置 → API Key" });
      emit({ type: "done" });
      res.end();
      return;
    }
    if (message.length > 0) {
      pushChat(session, "user", message);
      emit({ type: "chat", role: "user", text: message });
    }
    emit({ type: "status", text: "AI 正在想……" });
    const aiTurn = !session.gameOver && session.chess.turn() === session.aiColor;
    if (aiTurn) {
      // 轮到 AI：必须走一步棋（没走成就纠偏重试）
      await runAITurn(session, {
        config: toMiniMaxConfig(config),
        userMessage: message,
        emit,
        mock: config.mock,
        requireMove: true,
      });
    } else if (message.length > 0) {
      // 轮到用户：AI 只回应，不落子
      await runAITurn(session, {
        config: toMiniMaxConfig(config),
        userMessage: message,
        emit,
        mock: config.mock,
        requireMove: false,
      });
    }
    emit({ type: "board", snapshot: snapshotOf(session) });
    emit({ type: "done" });
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error), hint: errorHint(error) });
    emit({ type: "done" });
  } finally {
    res.end();
  }
});

/** 悔棋。 */
app.post("/api/game/:id/undo", (req: Request, res: Response) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const count = typeof body["count"] === "number" ? Math.max(1, Math.min(4, body["count"])) : 2;
  const undone = undoPlies(session, count);
  res.json({ undone, snapshot: snapshotOf(session) });
});

/** 用户认输。 */
app.post("/api/game/:id/resign", (req: Request, res: Response) => {
  const session = requireSession(req, res);
  if (!session) return;
  session.gameOver = true;
  session.reason = "resign";
  session.result = session.userColor === "w" ? "0-1" : "1-0";
  res.json({ snapshot: snapshotOf(session) });
});

/** 处理和棋提议（接受 / 拒绝）。 */
app.post("/api/game/:id/draw", (req: Request, res: Response) => {
  const session = requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const accept = body["accept"] === true;
  if (accept && session.drawOffer) {
    session.gameOver = true;
    session.reason = "draw_agreed";
    session.result = "1/2-1/2";
    session.drawOffer = null;
  } else {
    session.drawOffer = null;
  }
  res.json({ snapshot: snapshotOf(session) });
});

/** 重开一局（保留 gameId）。 */
app.post("/api/game/:id/restart", (req: Request, res: Response) => {
  const session = requireSession(req, res);
  if (!session) return;
  session.chess = new Chess();
  session.chat = [];
  session.aiMoved = false;
  session.gameOver = false;
  session.result = null;
  session.reason = null;
  session.drawOffer = null;
  session.greeted = false;
  res.json({ snapshot: snapshotOf(session) });
});

/** 测试 API Key 是否可用。 */
app.post("/api/key/test", async (req: Request, res: Response) => {
  const config = readConfig(req);
  if (!config.apiKey) {
    res.status(400).json({ ok: false, error: "请先填写 API Key。" });
    return;
  }
  const started = Date.now();
  try {
    const models = await listModels({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    res.json({
      ok: true,
      latencyMs: Date.now() - started,
      models: models.slice(0, 40),
      modelCount: models.length,
    });
  } catch (error) {
    // 模型列表接口不可用时，退化成一次最小对话
    try {
      await callModel(
        {
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
          maxTokens: 32,
          temperature: 0,
          timeoutMs: 30_000,
        },
        [{ role: "user", content: "ping" }],
      );
      res.json({ ok: true, latencyMs: Date.now() - started, models: [], modelCount: 0 });
    } catch (fallbackError) {
      const hint = errorHint(fallbackError);
      res.status(200).json({
        ok: false,
        latencyMs: Date.now() - started,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        hint,
      });
    }
  }
});

/** 拉取可用模型列表。 */
app.get("/api/models", async (req: Request, res: Response) => {
  const config = readConfig(req);
  if (!config.apiKey) {
    res.status(400).json({ error: "缺少 API Key。" });
    return;
  }
  try {
    const models = await listModels({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    res.json({ models });
  } catch (error) {
    res.status(200).json({ models: [], error: error instanceof Error ? error.message : String(error) });
  }
});

/** 健康检查。 */
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true, mock: MOCK, time: Date.now() });
});

/** 生产模式下托管构建好的前端。 */
if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get(/^(?!\/api\/).*/, (_req: Request, res: Response) => {
    res.sendFile(join(WEB_DIST, "index.html"));
  });
}

const PORT = Number(process.env["PORT"] ?? 8787);
app.listen(PORT, () => {
  console.log(`[chess] 后端已启动： http://localhost:${PORT}`);
  if (MOCK) console.log("[chess] 当前为 MOCK 模式（不调用真实模型）");
});
