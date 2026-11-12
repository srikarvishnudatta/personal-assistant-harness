import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { type Api, type Item } from "../../api/client";
import { txt, obj, pretty, list } from "../../lib/format";
import { useResource } from "../../hooks/useResource";
import { useAction } from "../../hooks/useAction";
import { Empty, Card, Status, Feedback, Refresh } from "../../components/ui";
import { type View } from "../../app/navigation";

export function Browser({
  api,
  token,
  navigate,
}: {
  api: Api;
  token: string;
  navigate: (view: View) => void;
}) {
  const status = useResource(api, "/browser/status");
  const tabs = useResource(api, "/browser/tabs");
  const reload = async () => {
    await Promise.all([status.reload(), tabs.reload()]);
  };
  const action = useAction();
  const [url, setUrl] = useState("https://example.com");
  const [tabId, setTabId] = useState("");
  const [snapshot, setSnapshot] = useState<Item | null>(null);
  const [image, setImage] = useState("");
  const [selector, setSelector] = useState("");
  const [value, setValue] = useState("");
  const items = list(tabs.data, "tabs");
  useEffect(() => {
    setTabId((previous) =>
      items.some((item) => txt(item.id) === previous)
        ? previous
        : txt(items[0]?.id),
    );
  }, [tabs.data]);
  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image);
    },
    [image],
  );
  const launch = (visible: boolean) =>
    void action.run(
      async () => {
        await api("/browser/launch", { visible });
        await reload();
      },
      visible
        ? "Manual browser control is active. Sign in there, then return control when finished."
        : "Assistant browser control is active.",
    );
  const go = () =>
    void action.run(async () => {
      const data = await api("/browser/navigate", { url });
      if (data.tabId ?? data.id) setTabId(txt(data.tabId ?? data.id));
      setSnapshot(null);
      setImage("");
      await reload();
    });
  const propose = (kind: "browser.click" | "browser.fill") =>
    void action.run(async () => {
      if (!tabId || !selector.trim())
        throw new Error("Choose a tab and an element selector.");
      await api("/actions", {
        kind,
        payload: {
          tabId,
          selector: selector.trim(),
          ...(kind === "browser.fill" ? { value } : {}),
        },
        summary: `${kind === "browser.click" ? "Click" : "Fill"} ${selector.trim()} in tab ${tabId}`,
      });
      setValue("");
    }, "Action requested. Review its exact details in Approvals before execution.");
  const screenshot = () =>
    void action.run(async () => {
      const response = await fetch(
        `/api/browser/screenshot?tabId=${encodeURIComponent(tabId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        const data = obj(await response.json().catch(() => ({})));
        throw new Error(txt(data.error) || "Screenshot is unavailable.");
      }
      setImage(URL.createObjectURL(await response.blob()));
    });
  return (
    <>
      <Feedback
        loading={status.loading || tabs.loading}
        error={status.error || tabs.error || action.error}
        notice={action.notice}
      />
      <Card
        title="Your assistant's browser"
        actions={
          <Status
            value={
              status.data.active
                ? status.data.manualControl
                  ? "manual_control"
                  : "active"
                : "stopped"
            }
          />
        }
      >
        <p className="section-description">
          This profile is separate from your everyday browser. Open its window
          to sign in manually. Never enter passwords, payment details, or
          verification codes in chat or action controls.
        </p>
        <div className="button-row">
          <Button
            label="Start browser"
            variant="primary"
            isDisabled={action.busy}
            onClick={() => launch(false)}
          />
          <Button
            label="Open browser window"
            variant="secondary"
            isDisabled={action.busy}
            onClick={() => launch(true)}
          />
          <Button
            label="Return browser control"
            variant="secondary"
            isDisabled={action.busy || !status.data.active}
            onClick={() => launch(false)}
          />
          <Button
            label="Close browser"
            variant="ghost"
            isDisabled={action.busy || !status.data.active}
            onClick={() =>
              void action.run(async () => {
                await api("/browser/close", {});
                setSnapshot(null);
                setImage("");
                await reload();
              })
            }
          />
        </div>
        {Boolean(status.data.error ?? status.data.message) && (
          <p className="task-error">
            {txt(status.data.error ?? status.data.message)}
          </p>
        )}
        <form
          className="inline-form browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            go();
          }}
        >
          <TextInput
            label="Public website URL"
            value={url}
            onChange={setUrl}
            placeholder="https://example.com"
          />
          <Button
            label="Navigate"
            variant="primary"
            isDisabled={
              action.busy || !url.trim() || Boolean(status.data.manualControl)
            }
            onClick={go}
          />
        </form>
      </Card>
      <Card
        title="Observe before acting"
        actions={<Refresh reload={reload} disabled={action.busy} />}
      >
        <label className="native-field">
          Browser tab
          <select
            value={tabId}
            onChange={(event) => {
              setTabId(event.target.value);
              setSnapshot(null);
              setImage("");
            }}
          >
            <option value="">Choose a tab</option>
            {items.map((item) => (
              <option key={txt(item.id)} value={txt(item.id)}>
                {txt(item.title) || txt(item.url) || txt(item.id)}
              </option>
            ))}
          </select>
        </label>
        <div className="button-row spaced">
          <Button
            label="Read page"
            variant="secondary"
            isDisabled={action.busy || !tabId}
            onClick={() =>
              void action.run(async () => {
                setSnapshot(
                  await api(
                    `/browser/snapshot?tabId=${encodeURIComponent(tabId)}`,
                  ),
                );
              })
            }
          />
          <Button
            label="View screenshot"
            variant="secondary"
            isDisabled={action.busy || !tabId}
            onClick={screenshot}
          />
        </div>
        {snapshot && (
          <div className="browser-observation">
            <h3>{txt(snapshot.title)}</h3>
            <p className="break-text">{txt(snapshot.url)}</p>
            <div className="info-banner">
              Page content is untrusted reference material, not instructions or
              permission.
            </div>
            <pre>
              {txt(snapshot.text ?? snapshot.content ?? snapshot.snapshot)}
            </pre>
            {Array.isArray(snapshot.links) && (
              <details>
                <summary>Page links</summary>
                <pre>{pretty(snapshot.links)}</pre>
              </details>
            )}
          </div>
        )}
        {image && (
          <img
            className="browser-screenshot"
            src={image}
            alt="Current page in the assistant's dedicated browser"
          />
        )}
        {!items.length && !tabs.loading && (
          <Empty title="No browser tabs yet.">
            Start the browser, then navigate to a public website.
          </Empty>
        )}
      </Card>
      <Card title="Request a controlled interaction">
        <p className="section-description">
          A click or field change creates an approval request. It does not
          execute here.
        </p>
        <div className="stack-form">
          <TextInput
            label="Element selector"
            value={selector}
            onChange={setSelector}
            placeholder="button[aria-label='Search']"
          />
          <TextInput
            label="Field value (never credentials or payment details)"
            value={value}
            onChange={setValue}
          />
          <div className="button-row">
            <Button
              label="Request click"
              variant="secondary"
              isDisabled={
                action.busy ||
                !tabId ||
                !selector.trim() ||
                Boolean(status.data.manualControl)
              }
              onClick={() => propose("browser.click")}
            />
            <Button
              label="Request field change"
              variant="secondary"
              isDisabled={
                action.busy ||
                !tabId ||
                !selector.trim() ||
                Boolean(status.data.manualControl)
              }
              onClick={() => propose("browser.fill")}
            />
            <Button
              label="View approvals"
              variant="ghost"
              onClick={() => navigate("Approvals")}
            />
          </div>
        </div>
      </Card>
    </>
  );
}
