// Issue #412 (driven sessions §4.2, mesh §10.3): the projects no agent, hook or
// session reads. A driver files its approval alerts in `@sessions`, and the mesh
// will file its asks in `@mesh`. Exactly these two names: a folder with no remote
// can legitimately be named with a leading `@`.
//
// The one list, shared by the store (src/store.ts, so every hub process) and the
// page (no Archive control for a reserved project). Pure: no imports, no I/O.
const RESERVED_PROJECTS = ['@sessions', '@mesh']

/** @param {string} project */
export function isReservedProject(project) {
  return RESERVED_PROJECTS.includes(project)
}
