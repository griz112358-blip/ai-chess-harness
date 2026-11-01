/**
 * apps/chess/web/components/HarnessLog.tsx —— Harness 运行日志
 *
 * 把适配器的内部过程摊开给你看：
 * 调模型 → 模型要调什么工具 → 本地执行结果是什么 → 棋子怎么落的。
 * 这是理解"大模型 + 本地业务适配器"最直接的窗口。
 */

export interface LogEntry {
  id: string;
  kind: "model" | "tool" | "status" | "error" | "reasoning";
  text: string;
  time: number;
}

interface HarnessLogProps {
  entries: LogEntry[];
}

const KIND_LABEL: Record<LogEntry["kind"], string> = {
  model: "模型",
  tool: "工具",
  status: "状态",
  error: "错误",
  reasoning: "思考",
};

function formatTime(value: number): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
    date.getSeconds(),
  ).padStart(2, "0")}`;
}

export function HarnessLog(props: HarnessLogProps) {
  const { entries } = props;
  return (
    <div className="harness-log">
      {entries.length === 0 ? (
        <p className="log-empty">还没有日志。走一步棋或发一句话，这里会显示模型的每一步动作。</p>
      ) : null}
      {entries.map((entry) => (
        <div key={entry.id} className={`log-row ${entry.kind}`}>
          <span className="log-time">{formatTime(entry.time)}</span>
          <span className="log-kind">{KIND_LABEL[entry.kind]}</span>
          <span className="log-text">{entry.text}</span>
        </div>
      ))}
    </div>
  );
}
