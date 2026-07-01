// Define LogEntry locally to avoid importing from internal package paths
export interface LogEntry {
  level: "info" | "success" | "error" | "warning" | "debug";
  message: string;
  timestamp: string;
}
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Terminal, Copy, CheckCheck } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { Button } from "./ui/button";

interface LogPanelProps {
  logs: LogEntry[];
}

const levelColors: Record<LogEntry["level"], string> = {
  info: "text-blue-400",
  success: "text-green-400",
  error: "text-red-400",
  warning: "text-yellow-400",
  debug: "text-gray-500",
};

export function LogPanel({ logs }: LogPanelProps) {
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleCopy = () => {
    const text = logs
      .map(
        (l) =>
          `[${format(new Date(l.timestamp), "HH:mm:ss.SSS")}] [${l.level.toUpperCase()}] ${l.message}`
      )
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // We don't auto-scroll to bottom because we reverse the logs (newest at top).
  // But if we did want newest at bottom, we'd scroll down.
  // Newest at top is better for immediate feedback without scrolling.

  return (
    <div className="flex flex-col h-full border rounded-lg bg-[#0a0a0c] overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-4 py-2 border-b bg-card">
        <div className="flex items-center gap-2 text-sm font-mono text-muted-foreground uppercase tracking-wider">
          <Terminal className="w-4 h-4" />
          <span>System Logs</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] font-mono">
            {logs.length} entries
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            className="w-7 h-7 text-muted-foreground hover:text-foreground"
            onClick={handleCopy}
            title="Copy logs"
          >
            {copied ? <CheckCheck className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          </Button>
        </div>
      </div>
      
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed"
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground italic">
            Waiting for activity...
          </div>
        ) : (
          <div className="space-y-1">
            {logs.map((log, i) => (
              <div key={i} className="flex items-start gap-3 hover:bg-white/[0.02] px-1 -mx-1 rounded">
                <span className="text-gray-500 shrink-0 select-none">
                  {format(new Date(log.timestamp), "HH:mm:ss.SSS")}
                </span>
                <span
                  className={cn(
                    "uppercase w-16 shrink-0 font-semibold select-none",
                    levelColors[log.level]
                  )}
                >
                  {log.level}
                </span>
                <span className="text-gray-300 break-all whitespace-pre-wrap">
                  {log.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Inline badge for the log panel header since we can't import easily if there are circular issues, but it's fine.
import { Badge } from "./ui/badge";
