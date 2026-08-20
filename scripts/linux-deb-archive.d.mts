export class LinuxDebArchiveError extends Error {}
export interface ArMember {
  name: string
  timestamp: number
  uid: number
  gid: number
  mode: number
  size: number
  dataOffset: number
  sha256: string
}
export interface TarEntry {
  path: string
  type: '0' | '2' | '5'
  mode: number
  uid: number
  gid: number
  size: number
  mtime: number
  uname: string
  gname: string
  link: string
  sha256?: string
  content?: Buffer
}
export function parseArArchive(path: string): ArMember[]
export function readArMember(path: string, member: ArMember): Buffer
export function sha256LargeFile(path: string): string
export function parseTarArchive(path: string, options?: {
  capturePaths?: string[]
}): {
  entries: TarEntry[]
  headers: Array<Omit<TarEntry, 'link' | 'sha256' | 'content'> & { type: string }>
}
export function withDebTarFile<T>(
  options: { deb: string; dpkgDeb?: string; member: 'control' | 'data' },
  callback: (tar: string) => T,
): T
