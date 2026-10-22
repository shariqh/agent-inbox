// Types for public/link-settings.js (issue #300 part 2).
export interface LinkSettingsBridge {
  get(): Promise<unknown>
  setHandler(ruleId: string, handler: string): Promise<unknown>
  chooseApp(ruleId: string): Promise<unknown>
  addType(extension: string): Promise<unknown>
  removeType(ruleId: string): Promise<unknown>
}

export function renderLinkSettings(
  host: Element,
  opts?: { bridge?: () => LinkSettingsBridge | null | undefined; documentRef?: Document },
): HTMLElement
