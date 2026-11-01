/**
 * apps/chess/web/components/ChatPanel.tsx —— 对话区
 *
 * 对话和棋局是两条通道：
 * - 棋盘负责"做了什么"
 * - 对话负责"说了什么"（AI 的点评、你的提问）
 */

import { useEffect, useRef, useState } from "react";

/** 一回合的 token 用量。 */
export interface TurnUsage {
  /** 本回合模型调用了几次。 */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 模型耗时合计（毫秒）。 */
  elapsedMs: number;
  /** true = 接口没返回 usage，这是本地估算值。 */
  estimated: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "ai" | "system";
  text: string;
  /** "usage" 表示这是一条用量小结，不是对话气泡。 */
  kind?: "chat" | "usage";
  usage?: TurnUsage;
}

/** 千分位格式化。 */
function formatTokens(value: number): string {
  return value.toLocaleString("zh-CN");
}

interface ChatPanelProps {
  messages: ChatMessage[];
  busy: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
}

export function ChatPanel(props: ChatPanelProps) {
  const { messages, busy, disabled, onSend } = props;
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy]);

  const send = (): void => {
    const text = input.trim();
    if (text.length === 0 || busy) return;
    onSend(text);
    setInput("");
  };

  return (
    <div className="chat">
      <div className="chat-list">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p>开局吧。也可以先问一句：</p>
            <ul>
              <li>开局我该怎么走？</li>
              <li>我刚才那步为什么不好？</li>
              <li>现在该注意什么？</li>
            </ul>
          </div>
        ) : null}
        {messages.map((message) =>
          message.kind === "usage" && message.usage ? (
            <div key={message.id} className="usage-line">
              <span className="usage-dot" />
              <span className="usage-text">
                本回合 {message.usage.calls} 次调用 · 输入 {formatTokens(message.usage.promptTokens)} / 输出{" "}
                {formatTokens(message.usage.completionTokens)} tokens · 耗时{" "}
                {(message.usage.elapsedMs / 1000).toFixed(1)}s
                {message.usage.estimated ? " · 估算值" : ""}
              </span>
            </div>
          ) : (
            <div key={message.id} className={`bubble ${message.role}`}>
              <span className="who">
                {message.role === "user" ? "你" : message.role === "ai" ? "AI 陪练" : "系统"}
              </span>
              <p>{message.text}</p>
            </div>
          ),
        )}
        {busy ? <div className="bubble ai thinking">正在思考……</div> : null}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input">
        <textarea
          value={input}
          placeholder="聊两句，或问它这步怎么想的…"
          rows={2}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="button" onClick={send} disabled={busy || disabled || input.trim().length === 0}>
          发送
        </button>
      </div>
    </div>
  );
}
