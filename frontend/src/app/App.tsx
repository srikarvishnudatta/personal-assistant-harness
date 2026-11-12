import { useEffect, useMemo, useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { createApi, type Item } from "../api/client";
import { txt } from "../lib/format";
import { session, setSession } from "../lib/session";
import { views, descriptions, type View } from "./navigation";
import { Chat } from "../features/chat/Chat";
import { Memory } from "../features/memory/Memory";
import { Goals } from "../features/goals/Goals";
import { Schedules } from "../features/schedules/Schedules";
import { Workflows } from "../features/workflows/Workflows";
import { Tasks } from "../features/tasks/Tasks";
import { Browser } from "../features/browser/Browser";
import { Approvals } from "../features/approvals/Approvals";
import { Inbox } from "../features/inbox/Inbox";
import { Files } from "../features/files/Files";
import { Connections } from "../features/connections/Connections";
import { Activity } from "../features/activity/Activity";
import { HistoryExplorer } from "../features/history/HistoryExplorer";
import { People } from "../features/people/People";
import { Repairs } from "../features/repairs/Repairs";
import { Evidence } from "../features/evidence/Evidence";

export function App() {
  const [mode, setMode] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  const [view, setView] = useState<View>("Chat");
  const [token, setToken] = useState(() => session("harness-token"));
  const [draft, setDraft] = useState("");
  const [runtime, setRuntime] = useState<Item>({});
  const api = useMemo(() => createApi(token), [token]);
  useEffect(() => {
    try {
      localStorage.setItem("harness-color-mode", mode);
    } catch {}
    document.documentElement.style.colorScheme = mode;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", mode === "dark" ? "#141814" : "#fbfcf9");
  }, [mode]);
  useEffect(() => {
    setRuntime({});
    if (!token) return;
    let active = true;
    void api("/status")
      .then((data) => {
        if (active) setRuntime(data);
      })
      .catch(() => {
        if (active) setRuntime({ unavailable: true });
      });
    return () => {
      active = false;
    };
  }, [api, token]);
  const connect = () => {
    if (draft.trim()) {
      setSession("harness-token", draft.trim());
      setToken(draft.trim());
      setDraft("");
    }
  };
  const disconnect = () => {
    setSession("harness-token", "");
    setToken("");
    setRuntime({});
  };
  return (
    <Theme theme={neutralTheme} mode={mode}>
      <div className="app-shell">
        <aside className="sidebar">
          <a
            className="brand"
            href="#"
            onClick={(event) => {
              event.preventDefault();
              setView("Chat");
            }}
          >
            <span className="brand-symbol">&#10035;</span>
            <span>
              Personal<span className="brand-sub">HARNESS</span>
            </span>
          </a>
          <div className="workspace-label">YOUR WORKSPACE</div>
          <nav aria-label="Main navigation">
            {views.map((name, index) => (
              <button
                key={name}
                className={`nav-item ${view === name ? "active" : ""}`}
                onClick={() => setView(name)}
                aria-current={view === name ? "page" : undefined}
              >
                <span className="nav-number" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                {name}
              </button>
            ))}
          </nav>
          <div className="account">
            <span className={`connection-dot ${token ? "connected" : ""}`} />
            <div>
              <strong>Personal workspace</strong>
              <small>
                {token ? "Connected this session" : "Not connected"}
              </small>
            </div>
            {token && (
              <button
                className="disconnect"
                onClick={disconnect}
                aria-label="Disconnect workspace"
              >
                &times;
              </button>
            )}
          </div>
        </aside>
        <main className="main">
          <header className="topbar">
            <span>
              Workspace <span className="slash">/</span>
              <strong>{view}</strong>
            </span>
            <span className="top-status">
              <span className="connection-dot" />
              {runtime.local ? "LOCAL RUNTIME" : "PERSONAL PREVIEW"}
            </span>
          </header>
          <div className="content">
            <div className="page-heading">
              <div>
                <div className="eyebrow">YOUR PERSONAL ASSISTANT</div>
                <h1>{view === "Chat" ? "What's on your mind?" : view}</h1>
                <p>{descriptions[view]}</p>
              </div>
              <div className="page-actions">
                <Button
                  label={mode === "dark" ? "Light mode" : "Dark mode"}
                  variant="secondary"
                  onClick={() =>
                    setMode((mode) => (mode === "dark" ? "light" : "dark"))
                  }
                />
              </div>
            </div>
            {!token ? (
              <section className="connect-panel">
                <div className="connect-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <span>&#10035;</span>
                </div>
                <div>
                  <div className="eyebrow">MAKE YOURSELF AT HOME</div>
                  <h2>One place for what's next.</h2>
                  <p>
                    Connect your local assistant to keep useful context and
                    follow work in the background.
                  </p>
                  <form
                    className="connect-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      connect();
                    }}
                  >
                    <TextInput
                      label="Workspace access token"
                      type="password"
                      value={draft}
                      onChange={setDraft}
                      placeholder="Enter your private access token"
                    />
                    <Button
                      label="Connect workspace"
                      variant="primary"
                      onClick={connect}
                    />
                  </form>
                  <small>
                    Your token stays in this tab's session. Disconnect to remove
                    it.
                  </small>
                </div>
              </section>
            ) : (
              <>
                {runtime.unavailable === true && (
                  <div className="info-banner">
                    Cannot reach your assistant. Check that the local server is
                    running and your access token is correct.
                  </div>
                )}
                {view === "Chat" && (
                  <Chat api={api} model={txt(runtime.model) || "GPT-6 Luna"} />
                )}
                {view === "Goals" && <Goals api={api} />}
                {view === "Memory" && <Memory api={api} />}
                {view === "History" && <HistoryExplorer api={api} />}
                {view === "People" && <People api={api} />}
                {view === "Repairs" && <Repairs api={api} />}
                {view === "Evidence" && <Evidence api={api} />}
                {view === "Schedules" && <Schedules api={api} />}
                {view === "Tasks" && <Tasks api={api} navigate={setView} />}
                {view === "Workflows" && <Workflows api={api} />}
                {view === "Browser" && (
                  <Browser api={api} token={token} navigate={setView} />
                )}
                {view === "Approvals" && <Approvals api={api} />}
                {view === "Inbox" && <Inbox api={api} navigate={setView} />}
                {view === "Files" && <Files api={api} />}
                {view === "Connections" && (
                  <Connections api={api} runtime={runtime} />
                )}
                {view === "Activity" && <Activity api={api} />}
              </>
            )}
            <footer className="page-footer">
              <span>Built around your context.</span>
              {token && (
                <button className="footer-disconnect" onClick={disconnect}>
                  Disconnect
                </button>
              )}
              <span>Personal Harness</span>
            </footer>
          </div>
        </main>
      </div>
    </Theme>
  );
}
