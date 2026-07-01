import { useEffect, useState } from "react";
import { TerminalSquare, CheckCircle, XCircle, Loader2 } from "lucide-react";

/**
 * OAuthCallback — rendered when Google redirects back after the user grants consent.
 * Reads ?code= from the URL, POSTs it to the backend for token exchange, then
 * shows success or failure and closes the tab automatically.
 */
export function OAuthCallback() {
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Exchanging authorization code for tokens…");
  const [logs, setLogs] = useState<Array<{ level: string; message: string; timestamp: string }>>([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");

    if (error) {
      setStatus("error");
      setMessage(`Google denied access: ${error}`);
      return;
    }

    if (!code) {
      setStatus("error");
      setMessage("No authorization code found in the callback URL.");
      return;
    }

    fetch("/api/gmail/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then((r) => r.json())
      .then((data: { success?: boolean; error?: string; logs?: typeof logs }) => {
        if (data.logs) setLogs(data.logs);
        if (data.success) {
          setStatus("success");
          setMessage("Authentication successful — token saved. You can close this tab.");
          // Auto-close after 3 s
          setTimeout(() => window.close(), 3000);
        } else {
          setStatus("error");
          setMessage(data.error ?? "Token exchange failed.");
        }
      })
      .catch((e: Error) => {
        setStatus("error");
        setMessage(`Network error: ${e.message}`);
      });
  }, []);

  const levelColor: Record<string, string> = {
    info: "text-blue-400",
    success: "text-green-400",
    error: "text-red-400",
    warning: "text-yellow-400",
    debug: "text-slate-400",
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 flex flex-col items-center justify-start p-8">
      {/* Header */}
      <div className="flex items-center gap-2 mb-8 text-slate-400">
        <TerminalSquare className="w-5 h-5" />
        <span className="font-mono text-sm">Gmail API Tester — OAuth Callback</span>
      </div>

      {/* Status card */}
      <div className="w-full max-w-xl bg-slate-800 border border-slate-700 rounded-lg p-8 flex flex-col items-center gap-4 mb-6">
        {status === "loading" && (
          <Loader2 className="w-16 h-16 text-blue-400 animate-spin" />
        )}
        {status === "success" && (
          <CheckCircle className="w-16 h-16 text-green-400" />
        )}
        {status === "error" && (
          <XCircle className="w-16 h-16 text-red-400" />
        )}

        <p className="text-center text-lg font-medium">{message}</p>

        {status === "success" && (
          <p className="text-sm text-slate-400">This tab will close automatically in 3 seconds.</p>
        )}

        {status !== "loading" && (
          <button
            onClick={() => window.close()}
            className="mt-2 px-5 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
          >
            Close tab
          </button>
        )}
      </div>

      {/* Log panel */}
      {logs.length > 0 && (
        <div className="w-full max-w-xl">
          <p className="text-xs text-slate-500 font-mono mb-2">Exchange log</p>
          <div className="bg-slate-950 border border-slate-800 rounded p-4 font-mono text-xs space-y-1 max-h-72 overflow-y-auto">
            {logs.map((l, i) => (
              <div key={i} className={levelColor[l.level] ?? "text-slate-300"}>
                [{l.level.toUpperCase()}] {l.timestamp} — {l.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
