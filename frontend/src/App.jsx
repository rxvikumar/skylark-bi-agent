import { useState, useRef, useEffect, useCallback } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "";

const WELCOME = {
  role: "assistant",
  content:
    "Hello! I'm your **Monday.com BI Agent** — powered by Gemini and live GraphQL.\n\nI have real-time access to your **Deal Funnel** (344 deals) and **Work Orders** (175 orders). Every answer pulls fresh data — no caching, no stale numbers.\n\nWhat would you like to know about the business?",
  tool_trace: [],
  id: "welcome",
};

const QUERIES = [
  {
    label: "Pipeline Overview",
    text: "How's our overall pipeline looking?",
    category: "Overview",
  },
  {
    label: "Top Sector",
    text: "Which sector has the highest deal value?",
    category: "Sectors",
  },
  {
    label: "Receivables",
    text: "What's our total receivables outstanding?",
    category: "Finance",
  },
  {
    label: "Top Owner",
    text: "Who is the top performing owner by win rate?",
    category: "People",
  },
  {
    label: "Mining Sector",
    text: "Show me all deals in the Mining sector",
    category: "Sectors",
  },
  {
    label: "Sector Comparison",
    text: "Compare all sectors by pipeline value",
    category: "Sectors",
  },
  {
    label: "This Quarter",
    text: "How's our energy sector pipeline this quarter?",
    category: "Time",
  },
  {
    label: "Collection Rate",
    text: "What's our collection efficiency on work orders?",
    category: "Finance",
  },
  {
    label: "Cross-Board",
    text: "How many won deals have matching work orders?",
    category: "Analysis",
  },
  {
    label: "Stale Deals",
    text: "Which deals have been open the longest?",
    category: "Risk",
  },
];

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function renderMd(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br/>");
}

function LiveClock() {
  const [t, setT] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }}>
      {t.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}
    </span>
  );
}

function TraceCard({ trace }) {
  const [open, setOpen] = useState(false);
  const count = trace.length;
  const hasError = trace.some((t) => t.status === "error");
  const totalMs = trace.reduce((s, t) => s + (t.duration || 0), 0);

  return (
    <div className="trace-wrap">
      <button
        className={`trace-pill ${hasError ? "trace-pill-err" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`trace-dot ${hasError ? "dot-red" : "dot-green"}`} />
        <span>
          {count} API call{count !== 1 ? "s" : ""}
        </span>
        {totalMs > 0 && <span className="trace-ms">{totalMs}ms</span>}
        <span className="trace-chevron">{open ? "↑" : "↓"}</span>
      </button>
      {open && (
        <div className="trace-panel">
          <div className="trace-panel-header">
            <span>Tool execution trace</span>
            <span className="trace-panel-sub">
              {count} calls · {totalMs}ms total
            </span>
          </div>
          {trace.map((t, i) => (
            <div key={i} className="trace-item">
              <div className="trace-item-top">
                <div className="trace-item-left">
                  <span
                    className={`trace-status-dot ${t.status === "done" ? "dot-green" : t.status === "error" ? "dot-red" : "dot-amber"}`}
                  />
                  <span className="trace-tool-name">{t.tool}</span>
                  {t.args && Object.keys(t.args).length > 0 && (
                    <span className="trace-args">{JSON.stringify(t.args)}</span>
                  )}
                </div>
                <div className="trace-item-right">
                  <span
                    className={`trace-badge ${t.status === "done" ? "badge-green" : t.status === "error" ? "badge-red" : "badge-amber"}`}
                  >
                    {t.status === "done"
                      ? "200 OK"
                      : t.status === "error"
                        ? "Error"
                        : "Running"}
                  </span>
                  {t.duration && (
                    <span className="trace-duration">{t.duration}ms</span>
                  )}
                </div>
              </div>
              {t.result && (
                <pre className="trace-result">
                  {JSON.stringify(t.result, null, 2).slice(0, 700)}
                  {JSON.stringify(t.result).length > 700 ? "\n  ..." : ""}
                </pre>
              )}
              {t.error && <pre className="trace-error">{t.error}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThinkingIndicator({ tools }) {
  const active = tools.find((t) => t.status === "running");
  const done = tools.filter((t) => t.status !== "running");
  return (
    <div className="thinking">
      <div className="thinking-dots">
        <span />
        <span />
        <span />
      </div>
      <span className="thinking-label">
        {active
          ? `Fetching ${active.tool.replace(/_/g, " ")}…`
          : done.length > 0
            ? `Analysing ${done.length} data source${done.length > 1 ? "s" : ""}…`
            : "Thinking…"}
      </span>
    </div>
  );
}

function AgentAvatar({ loading }) {
  return (
    <div className={`avatar ${loading ? "avatar-loading" : ""}`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2L2 7l10 5 10-5-10-5z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M2 17l10 5 10-5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M2 12l10 5 10-5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function Message({ msg }) {
  const isUser = msg.role === "user";
  if (isUser) {
    return (
      <div className="msg-user-wrap">
        <div className="msg-user-bubble">
          <p className="msg-user-text">{msg.content}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="msg-agent-wrap">
      <AgentAvatar />
      <div className="msg-agent-body">
        <p
          className="msg-agent-text"
          dangerouslySetInnerHTML={{ __html: renderMd(msg.content) }}
        />
        {msg.tool_trace?.length > 0 && <TraceCard trace={msg.tool_trace} />}
      </div>
    </div>
  );
}

export default function App() {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [toolProgress, setToolProgress] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 160) + "px";
    }
  }, [input]);

  const newSession = () => {
    setMessages([WELCOME]);
    setActiveChatId(null);
  };

  const send = useCallback(
    async (text) => {
      const userText = text || input.trim();
      if (!userText || loading) return;
      setInput("");
      setLoading(true);
      setToolProgress([]);

      const msgId = genId();
      const userMsg = { role: "user", content: userText, id: genId() };
      const agentMsg = {
        role: "assistant",
        content: "",
        tool_trace: [],
        id: msgId,
      };
      setMessages((prev) => [...prev, userMsg, agentMsg]);

      const history = messages
        .filter((m) => m.id !== "welcome" && m.content)
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        const res = await fetch(`${API_BASE}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: userText, history }),
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "",
          finalContent = "",
          finalTrace = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let d;
            try {
              d = JSON.parse(line.slice(6));
            } catch {
              continue;
            }

            if (d.type === "tool_start") {
              const entry = {
                tool: d.tool,
                args: d.args || {},
                status: "running",
              };
              setToolProgress((p) => [...p, entry]);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === msgId
                    ? { ...m, tool_trace: [...(m.tool_trace || []), entry] }
                    : m,
                ),
              );
            } else if (d.type === "tool_end") {
              setToolProgress((p) =>
                p.map((t) =>
                  t.tool === d.tool && t.status === "running"
                    ? {
                        ...t,
                        status: d.error ? "error" : "done",
                        result: d.result,
                        error: d.error,
                        duration: d.duration,
                      }
                    : t,
                ),
              );
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== msgId) return m;
                  return {
                    ...m,
                    tool_trace: (m.tool_trace || []).map((t) =>
                      t.tool === d.tool && t.status === "running"
                        ? {
                            ...t,
                            status: d.error ? "error" : "done",
                            result: d.result,
                            error: d.error,
                            duration: d.duration,
                          }
                        : t,
                    ),
                  };
                }),
              );
            } else if (d.type === "text") {
              finalContent += d.text;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === msgId ? { ...m, content: finalContent } : m,
                ),
              );
            } else if (d.type === "done") {
              finalContent = d.content || finalContent;
              finalTrace = d.tool_trace || [];
              const fin = {
                role: "assistant",
                content: finalContent,
                tool_trace: finalTrace,
                id: msgId,
              };
              setMessages((prev) =>
                prev.map((m) => (m.id === msgId ? fin : m)),
              );
              setChats((prev) => {
                const updated = activeChatId
                  ? prev.map((c) =>
                      c.id === activeChatId
                        ? { ...c, messages: [...messages, userMsg, fin] }
                        : c,
                    )
                  : [
                      {
                        id: genId(),
                        title: userText.slice(0, 40),
                        messages: [...messages, userMsg, fin],
                        ts: Date.now(),
                      },
                      ...prev,
                    ];
                return updated.slice(0, 20);
              });
            }
          }
        }
      } catch (e) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  content: `**Connection error:** ${e.message}\n\nMake sure the backend is running on port 3001.`,
                }
              : m,
          ),
        );
      } finally {
        setLoading(false);
        setToolProgress([]);
      }
    },
    [input, loading, messages, chats, activeChatId],
  );

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        {/* ── SIDEBAR ── */}
        <aside className={`sidebar ${sidebarOpen ? "" : "sidebar-hidden"}`}>
          <div className="sb-top">
            <div className="sb-brand">
              <div className="brand-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 2L2 7l10 5 10-5-10-5z"
                    stroke="white"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M2 17l10 5 10-5"
                    stroke="white"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M2 12l10 5 10-5"
                    stroke="white"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div>
                <div className="brand-name">Skylark BI</div>
                <div className="brand-sub">Intelligence Agent</div>
              </div>
            </div>
            <button className="new-chat-btn" onClick={newSession}>
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              New chat
            </button>
          </div>

          <div className="sb-section">
            <div className="sb-section-title">Live boards</div>
            <div className="board-row">
              <span className="live-dot" />
              <span className="board-label">Deal Funnel</span>
              <span className="board-count">344</span>
            </div>
            <div className="board-row">
              <span className="live-dot" />
              <span className="board-label">Work Orders</span>
              <span className="board-count">175</span>
            </div>
          </div>

          <div className="sb-section">
            <div className="sb-section-title">Suggested queries</div>
            {QUERIES.map((q, i) => (
              <button
                key={i}
                className="query-btn"
                onClick={() => send(q.text)}
              >
                <span className="query-category">{q.category}</span>
                <span className="query-label">{q.label}</span>
              </button>
            ))}
          </div>

          {chats.length > 0 && (
            <div className="sb-section sb-history">
              <div className="sb-section-title">Recent</div>
              {chats.slice(0, 8).map((c) => (
                <button
                  key={c.id}
                  className={`history-btn ${c.id === activeChatId ? "history-btn-active" : ""}`}
                  onClick={() => {
                    setMessages(c.messages);
                    setActiveChatId(c.id);
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                  </svg>
                  <span>{c.title}</span>
                </button>
              ))}
            </div>
          )}

          <div className="sb-footer">
            <div className="sb-footer-row">
              <span className="footer-live-dot" />
              <span>Monday.com · Live</span>
            </div>
            <div className="sb-footer-row">
              <span>Gemini · GraphQL v2024-01</span>
            </div>
            <div className="sb-footer-clock">
              <LiveClock />
            </div>
          </div>
        </aside>

        {/* ── MAIN ── */}
        <div className="main">
          {/* Header */}
          <header className="header">
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarOpen((s) => !s)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 12h18M3 6h18M3 18h18" />
              </svg>
            </button>
            <div className="header-center">
              <span className="header-title">Business Intelligence</span>
            </div>
            <div className="header-right">
              <div className="live-badge">
                <span className="live-badge-dot" />
                Live
              </div>
              <button className="header-new-btn" onClick={newSession}>
                New chat
              </button>
            </div>
          </header>

          {/* Messages */}
          <div className="messages-scroll">
            <div className="messages-container">
              {messages.length === 1 && messages[0].id === "welcome" && (
                <div className="welcome-hero">
                  <div className="welcome-icon">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M12 2L2 7l10 5 10-5-10-5z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M2 17l10 5 10-5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M2 12l10 5 10-5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <h2 className="welcome-title">
                    What would you like to know?
                  </h2>
                  <p className="welcome-sub">
                    Ask any founder-level question about your pipeline, revenue,
                    or work orders.
                  </p>
                </div>
              )}

              {messages.map((msg) => (
                <Message key={msg.id} msg={msg} />
              ))}

              {loading && (
                <div className="msg-agent-wrap">
                  <AgentAvatar loading />
                  <div className="msg-agent-body">
                    <ThinkingIndicator tools={toolProgress} />
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          </div>

          {/* Input */}
          <div className="input-area">
            <div className="input-box">
              <textarea
                ref={textareaRef}
                className="input-textarea"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Ask a business question…"
                rows={1}
                disabled={loading}
              />
              <button
                className={`input-send ${input.trim() && !loading ? "input-send-active" : ""}`}
                onClick={() => send()}
                disabled={loading || !input.trim()}
              >
                {loading ? (
                  <svg
                    className="spin"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                )}
              </button>
            </div>
            <div className="input-meta">
              <span>
                6 tools · Live Monday.com data · Shift+Enter for new line
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body,#root{height:100%;font-size:15px}

:root{
  --bg:       #0a0a0b;
  --surface:  #111114;
  --surface2: #18181c;
  --surface3: #1e1e24;
  --border:   #27272f;
  --border2:  #32323c;
  --accent:   #7c6ffd;
  --accent-h: #9488ff;
  --green:    #22c55e;
  --red:      #ef4444;
  --amber:    #f59e0b;
  --text:     #e8e8f0;
  --text2:    #8b8b9a;
  --text3:    #4a4a58;
  --sans:     'Geist', -apple-system, sans-serif;
  --mono:     'Geist Mono', monospace;
  --sidebar:  256px;
  --radius:   10px;
}

body{background:var(--bg);color:var(--text);font-family:var(--sans);overflow:hidden;-webkit-font-smoothing:antialiased}

.app{display:flex;height:100vh;overflow:hidden}

/* ── SIDEBAR ── */
.sidebar{
  width:var(--sidebar);flex-shrink:0;height:100vh;
  background:var(--surface);border-right:1px solid var(--border);
  display:flex;flex-direction:column;overflow:hidden;
  transition:width 0.2s ease,opacity 0.2s ease;
}
.sidebar-hidden{width:0;opacity:0;pointer-events:none}

.sb-top{padding:16px 14px 12px;border-bottom:1px solid var(--border);flex-shrink:0}

.sb-brand{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.brand-icon{
  width:32px;height:32px;border-radius:8px;
  background:linear-gradient(135deg,var(--accent),#5b4de8);
  display:flex;align-items:center;justify-content:center;flex-shrink:0;
}
.brand-name{font-size:13.5px;font-weight:600;color:var(--text);line-height:1.2}
.brand-sub{font-size:11px;color:var(--text3);margin-top:1px}

.new-chat-btn{
  width:100%;display:flex;align-items:center;justify-content:center;gap:6px;
  padding:8px 12px;border-radius:7px;border:1px solid var(--border2);
  background:transparent;color:var(--text2);font-family:var(--sans);font-size:13px;
  font-weight:500;cursor:pointer;transition:all 0.15s;
}
.new-chat-btn:hover{background:var(--surface2);color:var(--text);border-color:var(--border2)}

.sb-section{padding:14px 14px 6px;border-bottom:1px solid var(--border);flex-shrink:0}
.sb-section-title{font-size:11px;font-weight:600;color:var(--text3);letter-spacing:0.05em;text-transform:uppercase;margin-bottom:8px}

.board-row{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;margin-bottom:2px}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0;animation:livePulse 2.5s ease-in-out infinite}
@keyframes livePulse{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,0.4)}50%{box-shadow:0 0 0 4px rgba(34,197,94,0)}}
.board-label{font-size:13px;color:var(--text2);flex:1}
.board-count{font-size:11.5px;color:var(--text3);font-variant-numeric:tabular-nums;background:var(--surface3);padding:1px 7px;border-radius:10px}

.query-btn{
  width:100%;display:flex;align-items:center;gap:8px;
  padding:6px 6px;border-radius:6px;background:transparent;border:none;
  cursor:pointer;text-align:left;transition:background 0.12s;margin-bottom:1px;
}
.query-btn:hover{background:var(--surface2)}
.query-category{
  font-size:9.5px;font-weight:600;color:var(--accent);letter-spacing:0.04em;
  background:rgba(124,111,253,0.12);padding:1px 6px;border-radius:4px;
  white-space:nowrap;flex-shrink:0;
}
.query-label{font-size:12.5px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.query-btn:hover .query-label{color:var(--text)}

.sb-history{overflow-y:auto;flex:1}
.history-btn{
  width:100%;display:flex;align-items:center;gap:7px;
  padding:6px 6px;border-radius:6px;background:transparent;border:none;
  cursor:pointer;text-align:left;transition:background 0.12s;color:var(--text3);
  margin-bottom:1px;
}
.history-btn:hover{background:var(--surface2);color:var(--text2)}
.history-btn-active{background:var(--surface2);color:var(--text2)}
.history-btn span{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.sb-footer{
  margin-top:auto;padding:12px 14px;border-top:1px solid var(--border);flex-shrink:0;
  display:flex;flex-direction:column;gap:4px;
}
.sb-footer-row{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text3)}
.footer-live-dot{width:5px;height:5px;border-radius:50%;background:var(--green);flex-shrink:0}
.sb-footer-clock{font-size:12.5px;color:var(--text2);font-variant-numeric:tabular-nums;margin-top:2px}

/* ── MAIN ── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;background:var(--bg)}

.header{
  display:flex;align-items:center;gap:10px;padding:0 20px;
  height:52px;flex-shrink:0;border-bottom:1px solid var(--border);
  background:var(--bg);
}
.sidebar-toggle{
  width:32px;height:32px;display:flex;align-items:center;justify-content:center;
  border-radius:7px;border:none;background:transparent;color:var(--text3);
  cursor:pointer;transition:all 0.15s;flex-shrink:0;
}
.sidebar-toggle:hover{background:var(--surface);color:var(--text2)}
.header-center{flex:1;text-align:center}
.header-title{font-size:14px;font-weight:600;color:var(--text2)}
.header-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
.live-badge{
  display:flex;align-items:center;gap:5px;padding:4px 10px;
  border-radius:20px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.2);
  font-size:12px;color:var(--green);font-weight:500;
}
.live-badge-dot{width:5px;height:5px;border-radius:50%;background:var(--green);animation:livePulse 2s infinite}
.header-new-btn{
  padding:5px 12px;border-radius:7px;border:1px solid var(--border2);
  background:transparent;color:var(--text2);font-family:var(--sans);
  font-size:12.5px;font-weight:500;cursor:pointer;transition:all 0.15s;
}
.header-new-btn:hover{background:var(--surface);color:var(--text)}

/* Messages */
.messages-scroll{flex:1;overflow-y:auto;padding:24px 0}
.messages-scroll::-webkit-scrollbar{width:4px}
.messages-scroll::-webkit-scrollbar-thumb{background:var(--surface3);border-radius:2px}
.messages-container{max-width:760px;margin:0 auto;padding:0 24px;display:flex;flex-direction:column;gap:6px}

/* Welcome hero */
.welcome-hero{text-align:center;padding:48px 0 32px}
.welcome-icon{
  width:56px;height:56px;border-radius:14px;
  background:linear-gradient(135deg,var(--accent),#5b4de8);
  display:flex;align-items:center;justify-content:center;
  margin:0 auto 16px;color:white;
  box-shadow:0 8px 32px rgba(124,111,253,0.25);
}
.welcome-title{font-size:22px;font-weight:600;color:var(--text);margin-bottom:8px}
.welcome-sub{font-size:14px;color:var(--text2);line-height:1.6}

/* User message */
.msg-user-wrap{display:flex;justify-content:flex-end;padding:4px 0}
.msg-user-bubble{
  max-width:72%;padding:11px 16px;border-radius:14px 14px 4px 14px;
  background:var(--surface2);border:1px solid var(--border2);
}
.msg-user-text{font-size:14.5px;line-height:1.65;color:var(--text)}

/* Agent message */
.msg-agent-wrap{display:flex;gap:12px;align-items:flex-start;padding:4px 0}
.avatar{
  width:30px;height:30px;border-radius:8px;flex-shrink:0;margin-top:2px;
  background:linear-gradient(135deg,var(--accent),#5b4de8);
  display:flex;align-items:center;justify-content:center;color:white;
  position:relative;
}
.avatar-loading::after{
  content:'';position:absolute;inset:-2px;border-radius:10px;
  border:1.5px solid transparent;
  background:linear-gradient(var(--bg),var(--bg)) padding-box,
             linear-gradient(90deg,var(--accent),transparent,var(--accent)) border-box;
  animation:avatarSpin 1.5s linear infinite;
}
@keyframes avatarSpin{to{transform:rotate(360deg)}}

.msg-agent-body{flex:1;min-width:0;padding-top:4px}
.msg-agent-text{font-size:14.5px;line-height:1.75;color:var(--text);word-break:break-word}
.msg-agent-text strong{color:var(--text);font-weight:600}
.msg-agent-text em{color:var(--text2);font-style:italic}
.msg-agent-text code{
  font-family:var(--mono);font-size:12.5px;color:var(--accent-h);
  background:rgba(124,111,253,0.1);padding:1px 6px;border-radius:4px;
}

/* Thinking */
.thinking{display:flex;align-items:center;gap:10px;padding:4px 0}
.thinking-dots{display:flex;gap:4px;align-items:center}
.thinking-dots span{
  width:6px;height:6px;border-radius:50%;background:var(--text3);
  animation:dotBounce 1.2s ease-in-out infinite;
}
.thinking-dots span:nth-child(2){animation-delay:0.15s}
.thinking-dots span:nth-child(3){animation-delay:0.3s}
@keyframes dotBounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}
.thinking-label{font-size:13px;color:var(--text3)}

/* Trace */
.trace-wrap{margin-top:12px}
.trace-pill{
  display:inline-flex;align-items:center;gap:7px;padding:5px 11px;
  border-radius:20px;border:1px solid var(--border2);background:var(--surface);
  color:var(--text2);font-family:var(--sans);font-size:12.5px;font-weight:500;
  cursor:pointer;transition:all 0.15s;
}
.trace-pill:hover{border-color:var(--border2);background:var(--surface2);color:var(--text)}
.trace-pill-err{border-color:rgba(239,68,68,0.3);color:var(--red)}
.trace-dot,.trace-status-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.dot-green{background:var(--green)}
.dot-red{background:var(--red)}
.dot-amber{background:var(--amber)}
.trace-ms{font-size:11.5px;color:var(--text3)}
.trace-chevron{font-size:11px;color:var(--text3);margin-left:2px}

.trace-panel{
  margin-top:8px;border:1px solid var(--border);border-radius:var(--radius);
  background:var(--surface);overflow:hidden;
}
.trace-panel-header{
  padding:10px 14px;border-bottom:1px solid var(--border);
  display:flex;justify-content:space-between;align-items:center;
  font-size:12.5px;font-weight:600;color:var(--text2);
}
.trace-panel-sub{font-size:11.5px;color:var(--text3);font-weight:400}

.trace-item{padding:10px 14px;border-bottom:1px solid var(--border)}
.trace-item:last-child{border-bottom:none}
.trace-item-top{display:flex;justify-content:space-between;align-items:center;gap:10px}
.trace-item-left{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.trace-tool-name{font-family:var(--mono);font-size:12px;color:var(--text);font-weight:500}
.trace-args{font-family:var(--mono);font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trace-item-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
.trace-badge{font-size:11px;padding:1px 8px;border-radius:4px;font-weight:500}
.badge-green{color:var(--green);background:rgba(34,197,94,0.1)}
.badge-red{color:var(--red);background:rgba(239,68,68,0.1)}
.badge-amber{color:var(--amber);background:rgba(245,158,11,0.1)}
.trace-duration{font-size:11.5px;color:var(--text3);font-variant-numeric:tabular-nums}
.trace-result{
  font-family:var(--mono);font-size:11px;color:var(--text3);
  background:var(--surface2);border:1px solid var(--border);border-radius:6px;
  padding:8px 10px;margin-top:7px;white-space:pre-wrap;word-break:break-all;
  max-height:120px;overflow-y:auto;line-height:1.5;
}
.trace-error{
  font-family:var(--mono);font-size:11px;color:var(--red);
  background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.15);border-radius:6px;
  padding:8px 10px;margin-top:7px;
}

/* Input */
.input-area{
  padding:14px 20px 18px;border-top:1px solid var(--border);
  background:var(--bg);flex-shrink:0;
}
.input-box{
  max-width:760px;margin:0 auto;display:flex;align-items:flex-end;gap:0;
  background:var(--surface);border:1.5px solid var(--border2);border-radius:12px;
  transition:border-color 0.2s,box-shadow 0.2s;overflow:hidden;
}
.input-box:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px rgba(124,111,253,0.12)}
.input-textarea{
  flex:1;background:transparent;border:none;outline:none;
  padding:13px 16px;color:var(--text);font-family:var(--sans);font-size:14px;
  resize:none;min-height:48px;max-height:160px;overflow-y:auto;line-height:1.55;
}
.input-textarea::placeholder{color:var(--text3)}
.input-textarea:disabled{opacity:0.5}
.input-send{
  width:40px;height:40px;margin:4px 5px 4px 0;border-radius:8px;
  border:none;background:transparent;color:var(--text3);
  display:flex;align-items:center;justify-content:center;
  cursor:pointer;transition:all 0.15s;flex-shrink:0;
}
.input-send-active{background:var(--accent);color:white}
.input-send-active:hover{background:var(--accent-h)}
.input-send:disabled{cursor:not-allowed;opacity:0.5}
.spin{animation:spinAnim 0.8s linear infinite}
@keyframes spinAnim{to{transform:rotate(360deg)}}
.input-meta{
  max-width:760px;margin:8px auto 0;
  font-size:11.5px;color:var(--text3);text-align:center;
}
`;
