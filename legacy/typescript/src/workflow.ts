import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env, WorkflowParams } from './env';
import { dream, runAssistant } from './agent';

export class AssistantWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { userId, taskId, kind, prompt } = event.payload;
    const stub = this.env.ASSISTANTS.get(this.env.ASSISTANTS.idFromName(userId));
    const call = async (path: string, data?: unknown) => {
      const response = await stub.fetch(`https://assistant${path}`, {
        method: data ? 'POST' : 'GET', headers: { 'X-User-Id': userId, 'Content-Type': 'application/json' },
        body: data ? JSON.stringify(data) : undefined,
      });
      if (!response.ok) throw new Error(`Assistant callback failed: ${response.status}`);
      return response;
    };
    try {
      await step.do('mark-running', () => call('/internal/task-result', { taskId, status: 'running' }).then(() => true));
      const snapshot = await step.do('load-context', async () => (await call(`/internal/context?taskId=${encodeURIComponent(taskId)}`)).json<{ context: string; revision: number }>());
      // Bounded, read-only agent stage. Retrying may incur another model charge but cannot repeat external writes.
      const result = await step.do('run-agent', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
        () => kind === 'dream' ? dream(this.env, snapshot.context) : runAssistant(this.env, prompt, snapshot.context));
      await step.do('save-result', () => call('/internal/task-result', { taskId, status: 'completed', result }).then(() => true));
      return { taskId, result };
    } catch (error) {
      await step.do('save-failure', () => call('/internal/task-result', { taskId, status: 'failed', error: 'Task execution failed; inspect workflow logs' }).then(() => true));
      throw error;
    }
  }
}
