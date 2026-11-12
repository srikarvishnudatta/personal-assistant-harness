import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { type Api } from "../../api/client";
import { txt, list } from "../../lib/format";
import { useResource } from "../../hooks/useResource";
import { useAction } from "../../hooks/useAction";
import { Card, Feedback, Area } from "../../components/ui";

export function Files({ api }: { api: Api }) {
  const [directory, setDirectory] = useState("");
  const [folderDraft, setFolderDraft] = useState("");
  const resource = useResource(
    api,
    `/files?path=${encodeURIComponent(directory)}`,
  );
  const action = useAction();
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const items = list(resource.data, "files");
  const read = (filePath = path) =>
    void action.run(async () => {
      const data = await api(
        `/files/read?path=${encodeURIComponent(filePath)}`,
      );
      setPath(filePath);
      setContent(txt(data.content));
    });
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = path.split(/[\\/]/).pop() || "artifact.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <Feedback
        loading={resource.loading}
        error={resource.error || action.error}
        notice={action.notice}
      />
      <Card title="Workspace files">
        <p className="section-description">
          Paths stay inside the assistant workspace. Artifacts display as text;
          HTML is never executed in this app.
        </p>
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            setDirectory(folderDraft);
            void resource.reload();
          }}
        >
          <TextInput
            label="Folder"
            value={folderDraft}
            onChange={setFolderDraft}
            placeholder="Leave blank for workspace root"
          />
          <Button
            label="List files"
            variant="secondary"
            onClick={() => {
              if (directory === folderDraft) void resource.reload();
              else setDirectory(folderDraft);
            }}
          />
        </form>
        <div className="file-list">
          {items.map((item) => (
            <button
              key={txt(item.path ?? item.name)}
              className="file-entry"
              onClick={() => {
                const path = txt(item.path ?? item.name);
                if (item.type === "directory" || item.isDirectory) {
                  setDirectory(path);
                  setFolderDraft(path);
                } else read(path);
              }}
            >
              <span>
                {item.type === "directory" || item.isDirectory
                  ? "Folder"
                  : "File"}
              </span>
              <strong>{txt(item.path ?? item.name)}</strong>
              {Boolean(item.size) && <small>{txt(item.size)} bytes</small>}
            </button>
          ))}
          {!items.length && !resource.loading && (
            <p className="section-description">No files in this folder yet.</p>
          )}
        </div>
      </Card>
      <Card title="Read or write an artifact">
        <div className="stack-form">
          <TextInput
            label="Workspace-relative file path"
            value={path}
            onChange={setPath}
            placeholder="reports/weekly-plan.md"
          />
          <Area
            label="File contents"
            value={content}
            onChange={setContent}
            rows={14}
            maxLength={60000}
          />
          <div className="button-row">
            <Button
              label="Read file"
              variant="secondary"
              isDisabled={action.busy || !path.trim()}
              onClick={() => read()}
            />
            <Button
              label="Save file"
              variant="primary"
              isDisabled={action.busy || !path.trim()}
              onClick={() =>
                void action.run(async () => {
                  await api("/files", { path: path.trim(), content });
                  await resource.reload();
                }, "File saved in the assistant workspace.")
              }
            />
            <Button
              label="Download text"
              variant="secondary"
              isDisabled={!path.trim()}
              onClick={download}
            />
          </div>
        </div>
      </Card>
    </>
  );
}
