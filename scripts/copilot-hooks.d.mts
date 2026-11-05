export interface CopilotHookEntry { type: 'command'; exec: string; args: [string, 'activity', string]; timeoutSec: number }
export function copilotHooksFile(node: string, entry: string, options?: { tools?: boolean }): { version: 1; hooks: Record<string, CopilotHookEntry[]> }
export function isOurs(value: unknown): boolean
