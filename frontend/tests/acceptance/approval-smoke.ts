import assert from "node:assert/strict";
import { loadLocalConfig } from "./local-config.ts";

type Data = Record<string, any>;
const config = loadLocalConfig();
const origin = `http://127.0.0.1:${config.port}`;
const pending = new Map<string, string>();

async function api(
  path: string,
  body?: unknown,
  expectedStatus?: number,
): Promise<Data> {
  let response: Response;
  try {
    response = await fetch(`${origin}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw new Error(
      `Local API request failed or timed out for ${path}. Keep uv run --directory backend harness-server running. Check Approvals and Activity before retrying an interrupted action.`,
    );
  }
  const data = (await response.json()) as Data;
  if (expectedStatus !== undefined)
    assert.equal(
      response.status,
      expectedStatus,
      `${path}: unexpected HTTP status`,
    );
  else if (!response.ok)
    throw new Error(`${path}: ${String(data.error ?? response.status)}`);
  return data;
}
async function tabUrl(id: string): Promise<string> {
  const tab = ((await api("/browser/tabs")).tabs as Data[]).find(
    (tab) => tab.id === id,
  );
  assert.ok(tab, "The smoke-test tab was closed during testing");
  return tab.url;
}
async function propose(tabId: string, selector: string): Promise<Data> {
  const approval = await api("/actions", {
    kind: "browser.click",
    payload: { tabId, selector },
    summary:
      "Synthetic approval smoke test: open public Playwright installation documentation.",
  });
  assert.equal(approval.status, "pending");
  pending.set(approval.id, approval.digest);
  return approval;
}
async function decide(
  approval: Data,
  decision: string,
  expectedStatus?: number,
): Promise<Data> {
  const result = await api(
    `/approvals/${encodeURIComponent(approval.id)}/decision`,
    {
      decision,
      expectedDigest: approval.digest,
    },
    expectedStatus,
  );
  if (result.status && result.status !== "pending") pending.delete(approval.id);
  return result;
}

try {
  console.log(
    "Testing browser approvals through the local API. Public documentation navigation only; no model calls.",
  );
  const status = await api("/status");
  assert.equal(status.local, true, "Use the local Python server");
  assert.equal(
    status.backend,
    "python",
    "Stop the old server and restart uv run --directory backend harness-server to use the Python backend",
  );
  assert.ok(
    status.activity,
    "Restart uv run --directory backend harness-server to load the current runtime",
  );
  assert.equal(
    status.activity.activeTasks,
    0,
    "Wait for background tasks to finish",
  );
  assert.equal(
    status.activity.queuedTasks,
    0,
    "Wait for the task queue to drain",
  );
  assert.equal(status.activity.chatBusy, false, "Wait for chat to finish");
  assert.equal(
    (await api("/browser/status")).manualControl,
    false,
    "Return browser control to the assistant before testing",
  );

  const page = await api("/browser/navigate", {
    url: "https://playwright.dev",
  });
  assert.ok(
    page.status >= 200 && page.status < 400,
    "Public test page did not load successfully",
  );
  const snapshot = await api(
    `/browser/snapshot?tabId=${encodeURIComponent(page.id)}`,
  );
  const link = (snapshot.elements as Data[]).find((element) => {
    if (element.tag !== "a" || typeof element.href !== "string") return false;
    const target = new URL(element.href, snapshot.url);
    return (
      target.origin === "https://playwright.dev" &&
      target.pathname === "/docs/intro" &&
      !target.search &&
      !target.hash
    );
  });
  assert.ok(
    link,
    "No installation-documentation link was observed. Inspect the public page before updating the test.",
  );
  const targetUrl = new URL(link.href, snapshot.url).href;
  const rejected = await propose(page.id, link.selector);
  assert.equal(
    await tabUrl(page.id),
    snapshot.url,
    "A pending proposal unexpectedly navigated",
  );
  assert.equal((await decide(rejected, "rejected")).status, "rejected");
  assert.equal(
    await tabUrl(page.id),
    snapshot.url,
    "A rejected proposal unexpectedly navigated",
  );
  console.log("Pending and rejected actions left the page unchanged.");

  const approved = await propose(page.id, link.selector);
  await decide({ ...approved, digest: "0".repeat(64) }, "approved", 409);
  assert.equal(
    await tabUrl(page.id),
    snapshot.url,
    "A mismatched approval unexpectedly navigated",
  );
  assert.equal(
    (await decide(approved, "approved")).status,
    "completed",
    "Action outcome needs review in Approvals",
  );
  const deadline = Date.now() + 15000;
  while ((await tabUrl(page.id)) !== targetUrl && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    await tabUrl(page.id),
    targetUrl,
    "Approved click did not reach the observed documentation URL",
  );
  const destination = await api(
    `/browser/snapshot?tabId=${encodeURIComponent(page.id)}`,
  );
  assert.ok(
    destination.text.trim().length > 100,
    "Documentation page has no readable content",
  );
  await decide(approved, "approved", 409);
  const events = (await api("/events")).events as Data[];
  assert.equal(
    events.filter(
      (event) =>
        event.type === "action.started" &&
        event.detail?.approvalId === approved.id,
    ).length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "action.completed" &&
        event.detail?.approvalId === approved.id,
    ).length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "action.started" &&
        event.detail?.approvalId === rejected.id,
    ).length,
    0,
  );
  console.log(
    "Digest mismatch rejected; approved click completed once; replay blocked.",
  );
  console.log(
    "Browser approval smoke test passed. Public test tab and synthetic approval/audit records are retained.",
  );
} catch (error) {
  let message = error instanceof Error ? error.message : "Unknown failure";
  for (const secret of [config.apiKey, config.token, config.encryptionSecret])
    if (secret) message = message.replaceAll(secret, "[redacted]");
  console.error("Browser approval smoke test failed:", message.slice(0, 800));
  process.exitCode = 1;
} finally {
  // Reject only this invocation's still-pending proposals; never retry an action.
  for (const [id, digest] of pending) {
    try {
      const approval = ((await api("/approvals")).approvals as Data[]).find(
        (item) => item.id === id,
      );
      if (approval?.status === "pending")
        await decide({ id, digest }, "rejected");
    } catch {
      console.warn(
        "Could not clean up a test proposal. Review Approvals before retrying.",
      );
    }
  }
}
