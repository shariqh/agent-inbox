// Types for public/links.js (issue #300).
export type LinkKind = 'web' | 'pr' | 'issue' | 'file'

export interface FoundRef {
  kind: 'pr' | 'issue'
  start: number
  end: number
  /** the text the anchor covers: "#287" or "owner/name#12" */
  text: string
  /** the repository as written */
  repo: string
  number: number
  /** owner/name#number, the repository lowercased */
  key: string
  url: string
}

export interface FoundFile {
  kind: 'file'
  start: number
  end: number
  /** the path as written, with its :line suffix */
  text: string
  /** absolute or ~/, without the :line suffix */
  path: string
  line: number | null
}

export interface FoundWeb {
  kind: 'web'
  url: string
}

export type FoundLink = FoundRef | FoundFile | FoundWeb

export interface LinkContext {
  /** owner/name a bare #N resolves against */
  repo?: string | null
  /** receives every link rendered, in order */
  found?: FoundLink[]
}

export interface GithubRef {
  kind: 'pr' | 'issue'
  repo: string
  number: number
  key: string
}

export function findPlainLinks(value: string, from?: number, to?: number, ctx?: LinkContext | null): Array<FoundRef | FoundFile>
export function linkedHtml(value: string, from: number, to: number, ctx?: LinkContext | null): string
export function webLinkHtml(url: string, ctx?: LinkContext | null): string
export function githubRef(url: string): GithubRef | null
export function webLabel(url: string): string
export function fileLabel(path: string, line?: number | null): string
