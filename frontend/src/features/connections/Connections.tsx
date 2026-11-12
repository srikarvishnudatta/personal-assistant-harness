import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { type Api, type Item } from "../../api/client";
import { txt, obj, pretty } from "../../lib/format";
import { useResource } from "../../hooks/useResource";
import { useAction } from "../../hooks/useAction";
import { Card, Status, Feedback, Refresh } from "../../components/ui";
import { ProviderConnections } from "../connections/ProviderConnections";

export function Connections({ api, runtime }: { api: Api; runtime: Item }) {
  const resource = useResource(api, "/connections");
  const action = useAction(resource.reload);
  const [authUrl, setAuthUrl] = useState("");
  const google = obj(resource.data.google);
  return (
    <>
      <Feedback
        loading={resource.loading}
        error={resource.error || action.error}
      />
      <Card
        title="Google Workspace"
        actions={
          <Status
            value={
              google.connected
                ? "connected"
                : google.configured
                  ? "not_connected"
                  : "not_configured"
            }
          />
        }
      >
        <p className="section-description">
          Gmail and Calendar use Google's authorization flow. Tokens stay on the
          server, outside model context. Sending mail and creating calendar
          events require exact action approval.
        </p>
        {!google.configured && (
          <div className="info-banner">
            Configure your Google OAuth client in the local environment before
            connecting. The harness access token does not connect a Google
            account.
          </div>
        )}
        {Array.isArray(google.scopes) && (
          <details>
            <summary>Granted access</summary>
            <pre>{google.scopes.map(txt).join("\n")}</pre>
          </details>
        )}
        <div className="button-row">
          <Button
            label="Connect Google"
            variant="primary"
            isDisabled={action.busy || !google.configured}
            onClick={() =>
              void action.run(async () => {
                const data = await api("/connections/google/start", {});
                setAuthUrl(txt(data.url));
              })
            }
          />
          <Button
            label="Disconnect Google"
            variant="secondary"
            isDisabled={action.busy || !google.connected}
            onClick={() =>
              void action.run(async () => {
                await api("/connections/google", undefined, "DELETE");
                setAuthUrl("");
              })
            }
          />
          <Refresh reload={resource.reload} />
        </div>
        {authUrl && (
          <div className="info-banner">
            <a href={authUrl} target="_blank" rel="noopener noreferrer">
              Continue to Google authorization
            </a>
            <p>Return here and refresh after finishing the flow.</p>
          </div>
        )}
      </Card>
      <ProviderConnections api={api} />
      <Card title="Runtime capabilities">
        <p className="section-description">
          Only capabilities reported by this runtime are listed. Additional
          services need their own supported connectors and account
          authorization.
        </p>
        <pre>
          {runtime.capabilities
            ? pretty(runtime.capabilities)
            : "Capability information is unavailable."}
        </pre>
        {Boolean(runtime.budget) && (
          <>
            <h3>Run budget</h3>
            <pre>{pretty(runtime.budget)}</pre>
          </>
        )}
      </Card>
    </>
  );
}
