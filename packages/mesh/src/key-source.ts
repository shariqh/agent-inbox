// An API key named by a profile as `{ env }`, `{ file }` or `{ command }` (#483, unslop
// design §4.2; web search design §5.3): unslop's backend key and web search's Ollama key.
// Errors are fixed words: never the key, the file's content or the command's output.
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { checkApiKey } from './backend.js'
import { ConfigError, readPrivate } from './files.js'

export type KeySource = { env: string } | { file: string } | { command: string[] }

export const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')
export const home = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
/** Our own checks throw fixed messages; re-raise them as printable. */
export const fixed = <T>(fn: () => T): T => {
  try {
    return fn()
  } catch (error) {
    throw error instanceof ConfigError ? error : new ConfigError((error as Error).message)
  }
}
const KEY_SHAPE = 'apiKey must be { env }, { file: absolute path } or { command: [absolute path, ...args] }'

export function readApiKey(source: KeySource | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (source === undefined) return undefined
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new ConfigError(KEY_SHAPE)
  let raw: string | undefined
  if ('env' in source && typeof source.env === 'string') raw = env[source.env]
  else if ('file' in source && typeof source.file === 'string' && isAbsolute(home(source.file))) raw = readPrivate(home(source.file))
  else if ('command' in source && strings(source.command) && source.command[0] && isAbsolute(source.command[0])) {
    try {
      // a fixed argv, no shell; stdout is the key and is never logged
      raw = execFileSync(source.command[0], source.command.slice(1), { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      throw new ConfigError('the API key command failed')
    }
  } else throw new ConfigError(KEY_SHAPE)
  if (!raw?.trim()) throw new ConfigError('the API key source is empty')
  return fixed(() => checkApiKey(raw))
}
