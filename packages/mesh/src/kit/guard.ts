// The sanitising logger (web search design §3.2, §7.1 Logs): once an agent starts, every console
// call and every process-level error or warning writes one fixed line — never an argument, a
// message or a stack — so no request text, SDK error message or caller data reaches stderr or a
// log. The SDK's own console calls name a fixed event; anything else is the method's name alone.
const BUILTIN = [TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError, AggregateError, Error]
const WARNINGS = ['Warning', 'DeprecationWarning', 'ExperimentalWarning', 'MaxListenersExceededWarning', 'TimeoutOverflowWarning', 'UnsupportedWarning']
const SDK_EVENTS = ['Agent execution failed', 'Event processing loop failed', 'Error sending push notification', 'Failed to load full task', 'ResultManager', 'Reference task']
const CONSOLE = ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir', 'dirxml', 'table', 'assert', 'count', 'group', 'groupCollapsed', 'timeLog', 'timeEnd'] as const

/** Replaces every console method and the process's error and warning handlers; `fatal` runs after an uncaught error's line. */
export function guardOutput(write: (line: string) => void, fatal: () => void): void {
  for (const name of CONSOLE) {
    console[name] = (...args: unknown[]): void => {
      const event = typeof args[0] === 'string' ? SDK_EVENTS.find((e) => (args[0] as string).startsWith(e)) : undefined
      write(`sdk: ${name}${event ? ` ${event}` : ''}`)
    }
  }
  const die = (error: unknown): void => {
    write(`agent: uncaught ${BUILTIN.find((c) => error instanceof c)?.name ?? 'value'}`)
    fatal()
  }
  process.on('uncaughtException', die)
  process.on('unhandledRejection', die)
  process.removeAllListeners('warning')
  process.on('warning', (w) => write(`agent: warning ${WARNINGS.includes(w.name) ? w.name : 'other'}`))
}
