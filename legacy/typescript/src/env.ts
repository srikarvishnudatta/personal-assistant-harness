import type { Assistant } from "./assistant.js";
export interface WorkflowParams {
  userId: string;
  taskId: string;
  kind: "task" | "dream";
  prompt: string;
}
export interface Env {
  OPENAI_API_KEY: string;
  HARNESS_TOKEN: string;
  OPENAI_MODEL?: string;
  ASSISTANTS: DurableObjectNamespace<Assistant>;
  ASSISTANT_WORKFLOW: Workflow<WorkflowParams>;
  ASSETS: Fetcher;
}
