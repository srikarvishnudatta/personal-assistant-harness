import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { type Api, type Item } from "../../api/client";
import { Refresh } from "../../components/ui";
import { text, rows, pretty } from "../../lib/knowledge";
import { useData } from "../../hooks/useData";
import { ErrorNotice } from "../../components/ErrorNotice";

export function ProviderConnections({ api }: { api: Api }) {
  const state = useData(api, "/connections");
  return (
    <>
      <ErrorNotice value={state.error} />
      {rows(state.data.providers).map((p) => (
        <ProviderCard
          key={text(p.provider)}
          provider={p}
          api={api}
          reload={state.reload}
        />
      ))}
    </>
  );
}

function ProviderCard({
  provider: p,
  api,
  reload,
}: {
  provider: Item;
  api: Api;
  reload: () => Promise<void>;
}) {
  const id = text(p.provider);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState("");
  const [action, setAction] = useState(text((p.reads as string[])[0]));
  const [argument, setArgument] = useState("");
  const [result, setResult] = useState<Item | null>(null);
  const [message, setMessage] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [notice, setNotice] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="section-card knowledge-card">
      <h2>
        {text(p.label)} · {p.connected ? "authorized" : "not connected"}
      </h2>
      <p>{text(p.setup)}</p>
      <p className="section-description">
        {text(p.category)} · {text(p.auth)}. Stored authorization is not a live
        permission check. Disconnect removes local credentials; revoke the grant
        separately at the provider if needed.
      </p>
      {Boolean(p.identity) && <pre>{pretty(p.identity)}</pre>}
      <ErrorNotice value={error} />
      {notice && <p role="status">{notice}</p>}
      <div className="stack-form">
        {id === "spotify" ? (
          <>
            <Button
              label="Authorize Spotify"
              variant="primary"
              isDisabled={busy || !p.configured}
              onClick={() =>
                void run(async () =>
                  setAuth(
                    text((await api("/connections/spotify/start", {})).url),
                  ),
                )
              }
            />
            {auth && (
              <a href={auth} target="_blank" rel="noopener noreferrer">
                Continue to Spotify consent, then return and refresh
              </a>
            )}
          </>
        ) : (
          <>
            <label className="native-field">
              Authorized provider token (never paste into chat)
              <input
                type="password"
                autoComplete="off"
                value={secret}
                maxLength={4096}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            <Button
              label="Verify account and save encrypted token"
              variant="primary"
              isDisabled={busy || !p.configured || !secret.trim()}
              onClick={() =>
                void run(async () => {
                  await api(`/connections/${id}/authorize`, {
                    token: secret.trim(),
                  });
                  setSecret("");
                  setNotice(
                    "Authorization verified and saved. Tokens are not returned to the model.",
                  );
                })
              }
            />
          </>
        )}
        <div className="button-row">
          <Button
            label="Refresh connection"
            variant="secondary"
            isDisabled={busy}
            onClick={() => void run(reload)}
          />
          <Button
            label="Disconnect locally"
            variant="ghost"
            isDisabled={busy || !p.connected}
            onClick={() =>
              void run(async () => {
                await api(`/connections/${id}`, undefined, "DELETE");
                setAuth("");
                setResult(null);
              })
            }
          />
        </div>
        {Boolean(p.connected) && (
          <>
            <label className="native-field">
              Bounded read
              <select
                value={action}
                onChange={(e) => setAction(e.target.value)}
              >
                {(p.reads as string[]).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            {(id === "homeassistant" ||
              id === "shopify" ||
              (id === "slack" && action === "history")) && (
              <label className="native-field">
                {id === "homeassistant"
                  ? "Exact entity ID"
                  : id === "shopify"
                    ? "Product query"
                    : "Exact conversation ID"}
                <input
                  value={argument}
                  maxLength={500}
                  onChange={(e) => setArgument(e.target.value)}
                />
              </label>
            )}
            <Button
              label="Test bounded read"
              variant="secondary"
              isDisabled={busy}
              onClick={() =>
                void run(async () =>
                  setResult(
                    await api(`/connections/${id}/read`, {
                      action,
                      ...(id === "homeassistant"
                        ? { entityId: argument }
                        : id === "shopify"
                          ? { query: argument }
                          : { channel: argument }),
                    }),
                  ),
                )
              }
            />
            {(p.writes as string[]).length > 0 && (
              <>
                <h3>Prepare an exact action for review</h3>
                {id === "slack" && (
                  <label className="native-field">
                    Exact destination conversation ID
                    <input
                      value={argument}
                      onChange={(e) => setArgument(e.target.value)}
                    />
                  </label>
                )}
                <label className="native-field">
                  Message / post
                  <textarea
                    value={message}
                    maxLength={4000}
                    rows={3}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                </label>
                {id === "mastodon" && (
                  <label className="native-field">
                    Visibility
                    <select
                      value={visibility}
                      onChange={(e) => setVisibility(e.target.value)}
                    >
                      <option value="private">Followers only</option>
                      <option value="unlisted">Unlisted</option>
                      <option value="public">Public</option>
                      <option value="direct">Mentioned accounts only</option>
                    </select>
                  </label>
                )}
                <Button
                  label="Create approval card"
                  variant="secondary"
                  isDisabled={busy || !message.trim()}
                  onClick={() =>
                    void run(async () => {
                      await api("/actions", {
                        kind:
                          id === "slack" ? "slack.send" : "mastodon.publish",
                        payload:
                          id === "slack"
                            ? { channel: argument, text: message }
                            : { text: message, visibility },
                        summary:
                          id === "slack"
                            ? `Send Slack message to ${argument}`
                            : `Publish Mastodon post (${visibility})`,
                      });
                      setNotice(
                        "Proposal created. Open Approvals to review the exact destination, account and payload. Nothing was sent.",
                      );
                    })
                  }
                />
              </>
            )}
          </>
        )}
        {result && (
          <details open>
            <summary>Provider result (untrusted reference data)</summary>
            <pre>{pretty(result)}</pre>
          </details>
        )}
      </div>
    </section>
  );
}
