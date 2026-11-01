/**
 * apps/chess/web/App.tsx —— 应用主组件
 *
 * 状态流：
 *   设置（Key/模型/水平）→ 建局 → 用户走子 → 服务端跑 AI 回合 → SSE 事件实时刷新棋盘/对话/日志
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChessBoard } from "./components/ChessBoard";
import { ChatPanel } from "./components/ChatPanel";
import type { ChatMessage } from "./components/ChatPanel";
import { HarnessLog } from "./components/HarnessLog";
import type { LogEntry } from "./components/HarnessLog";
import { SetupGate } from "./components/SetupGate";
import { getJson, postJson, streamEvents } from "./lib/api";
import { DEFAULT_SETTINGS, hasApiKey, loadSettings, saveSettings } from "./lib/settings";
import type { AppSettings, GameSnapshot, ServerEvent } from "../shared/protocol";

let idSeq = 0;
const nextId = (): string => {
  idSeq += 1;
  return `m${idSeq}_${Date.now().toString(36)}`;
};

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [showSetup, setShowSetup] = useState(true);
  const [mockMode, setMockMode] = useState(false);
  const [gameId, setGameId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const textBuffer = useRef<string>("");

  /* ---------------- 初始化 ---------------- */
  useEffect(() => {
    const stored = loadSettings();
    setSettings(stored);
    void (async () => {
      try {
        const health = await getJson<{ ok: boolean; mock: boolean }>("/api/health");
        setMockMode(health.mock === true);
        if (health.mock) {
          setShowSetup(false);
          await startGame(stored, health.mock);
        } else {
          setShowSetup(!hasApiKey(stored));
        }
      } catch {
        setShowSetup(!hasApiKey(stored));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pushLog = useCallback((kind: LogEntry["kind"], text: string) => {
    setLogs((prev) => {
      const next = [...prev, { id: nextId(), kind, text, time: Date.now() }];
      return next.length > 300 ? next.slice(next.length - 300) : next;
    });
  }, []);

  const flushText = useCallback(() => {
    const text = textBuffer.current.trim();
    textBuffer.current = "";
    if (text.length > 0) pushLog("model", text);
  }, [pushLog]);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case "board":
          setSnapshot(event.snapshot);
          break;
        case "chat":
          setMessages((prev) => [...prev, { id: nextId(), role: event.role, text: event.text }]);
          break;
        case "model_call":
          flushText();
          pushLog("model", `第 ${event.step} 轮：请求模型（工具：${event.toolNames.join(", ")}）`);
          break;
        case "model_text":
          textBuffer.current += event.text;
          break;
        case "reasoning":
          pushLog("reasoning", event.text);
          break;
        case "tool_call":
          pushLog("tool", `调用 ${event.name}(${JSON.stringify(event.arguments)})`);
          break;
        case "tool_result":
          pushLog("tool", `返回 ${event.name} ${event.ok ? "成功" : "失败"}：${event.summary}`);
          break;
        case "status":
          pushLog("status", event.text);
          break;
        case "error":
          pushLog("error", event.hint ? `${event.message}｜${event.hint}` : event.message);
          setMessages((prev) => [
            ...prev,
            { id: nextId(), role: "system", text: event.hint ? `${event.message}\n${event.hint}` : event.message },
          ]);
          break;
        case "done":
          flushText();
          break;
        default:
          break;
      }
    },
    [flushText, pushLog],
  );

  /* ---------------- 对局动作 ---------------- */
  const startGame = useCallback(
    async (config: AppSettings, mock = false): Promise<void> => {
      try {
        const res = await postJson<{ gameId: string; snapshot: GameSnapshot }>("/api/session", {
          userColor: config.userColor,
          level: config.level,
          coaching: config.coaching,
        });
        setGameId(res.gameId);
        setSnapshot(res.snapshot);
        setMessages([]);
        setLogs([]);
        setShowSetup(false);
        pushLog("status", mock ? "进入 Mock 模式：用假模型走棋" : "新局开始");
        pushLog("status", `你执${res.snapshot.userColor === "w" ? "白" : "黑"}方，AI 陪练水平：${config.level}`);
      } catch (error) {
        pushLog("error", error instanceof Error ? error.message : String(error));
      }
    },
    [pushLog],
  );

  const requestHeaders = useCallback(
    (): Record<string, string> =>
      settings.apiKey ? { "x-minimax-key": settings.apiKey } : {},
    [settings.apiKey],
  );

  const handleMove = useCallback(
    (from: string, to: string, promotion?: string): void => {
      if (!gameId || busy) return;
      setBusy(true);
      void streamEvents(
        `/api/game/${gameId}/move`,
        {
          from,
          to,
          promotion,
          baseUrl: settings.baseUrl,
          model: settings.model,
          temperature: settings.temperature,
          disableThinking: settings.disableThinking,
          mock: mockMode,
        },
        requestHeaders(),
        handleEvent,
      )
        .catch((error: unknown) => {
          pushLog("error", error instanceof Error ? error.message : String(error));
        })
        .finally(() => setBusy(false));
    },
    [gameId, busy, settings, mockMode, requestHeaders, handleEvent, pushLog],
  );

  const handleSend = useCallback(
    (text: string): void => {
      if (!gameId || busy) return;
      setBusy(true);
      setMessages((prev) => [...prev, { id: nextId(), role: "user", text }]);
      void streamEvents(
        `/api/game/${gameId}/chat`,
        {
          message: text,
          baseUrl: settings.baseUrl,
          model: settings.model,
          temperature: settings.temperature,
          disableThinking: settings.disableThinking,
          mock: mockMode,
        },
        requestHeaders(),
        handleEvent,
      )
        .catch((error: unknown) => {
          pushLog("error", error instanceof Error ? error.message : String(error));
        })
        .finally(() => setBusy(false));
    },
    [gameId, busy, settings, mockMode, requestHeaders, handleEvent, pushLog],
  );

  const handleUndo = useCallback((): void => {
    if (!gameId || busy) return;
    void postJson<{ snapshot: GameSnapshot }>(`/api/game/${gameId}/undo`, { count: 2 })
      .then((res) => {
        setSnapshot(res.snapshot);
        pushLog("status", "已悔棋");
      })
      .catch((error: unknown) => pushLog("error", String(error)));
  }, [gameId, busy, pushLog]);

  const handleResign = useCallback((): void => {
    if (!gameId || busy) return;
    void postJson<{ snapshot: GameSnapshot }>(`/api/game/${gameId}/resign`, {})
      .then((res) => {
        setSnapshot(res.snapshot);
        pushLog("status", "你认输了");
      })
      .catch((error: unknown) => pushLog("error", String(error)));
  }, [gameId, busy, pushLog]);

  const handleDraw = useCallback(
    (accept: boolean): void => {
      if (!gameId) return;
      void postJson<{ snapshot: GameSnapshot }>(`/api/game/${gameId}/draw`, { accept })
        .then((res) => {
          setSnapshot(res.snapshot);
          pushLog("status", accept ? "双方同意和棋" : "拒绝了和棋");
        })
        .catch((error: unknown) => pushLog("error", String(error)));
    },
    [gameId, pushLog],
  );

  const handleRestart = useCallback((): void => {
    if (!gameId) return;
    void postJson<{ snapshot: GameSnapshot }>(`/api/game/${gameId}/restart`, {})
      .then((res) => {
        setSnapshot(res.snapshot);
        setMessages([]);
        setLogs([]);
        pushLog("status", "已重开一局");
      })
      .catch((error: unknown) => pushLog("error", String(error)));
  }, [gameId, pushLog]);

  const handleSaveSettings = useCallback((next: AppSettings): void => {
    setSettings(next);
    saveSettings(next);
  }, []);

  /* ---------------- 渲染 ---------------- */
  const userTurn = snapshot !== null && snapshot.turn === snapshot.userColor && !snapshot.gameOver;
  const statusText = (() => {
    if (!snapshot) return "准备中…";
    if (snapshot.gameOver) {
      const map: Record<string, string> = {
        "1-0": "白方胜",
        "0-1": "黑方胜",
        "1/2-1/2": "和棋",
      };
      const reason: Record<string, string> = {
        checkmate: "将死",
        stalemate: "逼和",
        resign: "认输",
        draw_agreed: "协议和棋",
        insufficient_material: "子力不足",
        threefold_repetition: "三次重复局面",
        fifty_move_rule: "50 步规则",
      };
      return `对局结束：${map[snapshot.result ?? ""] ?? "结束"}${snapshot.reason ? `（${reason[snapshot.reason] ?? snapshot.reason}）` : ""}`;
    }
    if (busy) return "AI 正在思考…";
    return userTurn ? "轮到你走" : "等待 AI 落子";
  })();

  const exportPgn = (): void => {
    if (!snapshot?.pgn) return;
    const blob = new Blob([snapshot.pgn], { type: "application/x-chess-pgn" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `chess-${snapshot.gameId}.pgn`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">♞</span>
          <div>
            <strong>AI 国际象棋陪练</strong>
            <small>大模型 + 本地业务适配器 Demo</small>
          </div>
        </div>
        <div className="status">
          <span className={`dot ${busy ? "busy" : userTurn ? "you" : "ai"}`} />
          {statusText}
          <em>第 {snapshot?.moveNumber ?? 1} 手</em>
        </div>
        <div className="top-actions">
          <button type="button" className="ghost" onClick={() => setShowSetup(true)}>
            设置
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="left">
          <div className="board-panel">
            <ChessBoard
              fen={snapshot?.fen ?? "start"}
              orientation={snapshot?.userColor ?? "w"}
              lastMove={snapshot?.lastMove ?? null}
              interactive={userTurn && !busy}
              busy={busy}
              onMove={handleMove}
            />
            <div className="board-actions">
              <button type="button" onClick={handleRestart} disabled={busy}>
                重开
              </button>
              <button type="button" onClick={handleUndo} disabled={busy || !snapshot}>
                悔棋
              </button>
              <button type="button" onClick={handleResign} disabled={busy || !snapshot}>
                认输
              </button>
              <button type="button" className="ghost" onClick={exportPgn} disabled={!snapshot?.pgn}>
                导出 PGN
              </button>
            </div>
            {snapshot?.drawOffer ? (
              <div className="draw-offer">
                <span>AI 提出和棋，接受吗？</span>
                <button type="button" onClick={() => handleDraw(true)}>
                  接受
                </button>
                <button type="button" className="ghost" onClick={() => handleDraw(false)}>
                  拒绝
                </button>
              </div>
            ) : null}
          </div>

          <details className="log-panel" open>
            <summary>Harness 运行日志</summary>
            <HarnessLog entries={logs} />
          </details>
        </section>

        <section className="right">
          <ChatPanel messages={messages} busy={busy} onSend={handleSend} />
        </section>
      </main>

      {showSetup ? (
        <SetupGate
          settings={settings}
          onChange={handleSaveSettings}
          onStart={() => void startGame(settings, mockMode)}
          onClose={gameId ? () => setShowSetup(false) : undefined}
          mockMode={mockMode}
        />
      ) : null}
    </div>
  );
}
