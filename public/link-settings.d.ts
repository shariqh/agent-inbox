// Types for public/link-settings.js (issue #300 part 2).
export interface LinkSettingsBridge {
  get(): Promise<unknown>
  setHandler(ruleId: string, handler: string): Promise<unknown>
  chooseApp(ruleId: string): Promise<unknown>
  addType(extension: string): Promise<unknown>
  removeType(ruleId: string): Promise<unknown>
  /** #586 */
  getTerminal(): Promise<unknown>
  setTerminal(terminal: string): Promise<unknown>
}

export function renderLinkSettings(
  host: Element,
  opts?: { bridge?: () => LinkSettingsBridge | null | undefined; documentRef?: Document },
): HTMLElement

/** Asks main for the section again (Settings opening); null when nothing is shown. */
export function refreshLinkSettings(): Promise<unknown>

/**
 * #586: Settings → Terminal. Null, with nothing drawn, without the desktop bridge;
 * hidden until main says the choice is available. `onChange` runs after a saved choice.
 */
export function renderTerminalSettings(
  host: Element,
  opts?: { bridge?: () => LinkSettingsBridge | null | undefined; documentRef?: Document; onChange?: () => void },
): HTMLElement | null
