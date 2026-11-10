import { handleRequest } from './gateway.ts';
import type { Env } from './env.js';
export { Assistant } from './assistant.js';
export { AssistantWorkflow } from './workflow.js';
export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
