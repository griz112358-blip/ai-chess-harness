/**
 * apps/chess/web/components/ChatPanel.tsx —— 对话区
 *
 * 对话和棋局是两条通道：
 * - 棋盘负责"做了什么"
 * - 对话负责"说了什么"（AI 的点评、你的提问）
 */

import { useEffect, useRef, useState } from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "ai" | "system";
  text: string;
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
        {messages.map((message) => (
          <div key={message.id} className={`bubble ${message.role}`}>
            <span className="who">
              {message.role === "user" ? "你" : message.role === "ai" ? "AI 陪练" : "系统"}
            </span>
            <p>{message.text}</p>
          </div>
        ))}
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
