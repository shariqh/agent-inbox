// The one line the Setup panel shows about WHICH BUILD IS RUNNING (issue #40).
//
// Pure: takes the stamp /api/setup returns (src/stamp.ts computed it) and returns
// the sentence, or null when there is nothing honest to say. The viewer renders it
// as text — no DOM here, so every branch of the wording is unit-testable.
//
// It is a quiet line in a panel behind the gear, and that is the whole point:
// a stale build is NOT the human being blocked, so it never touches the attention
// set, the tab count or the dock badge (tenets 1 and 2).

const REBUILD = 'npm run package:app'

/** The 7 characters a human actually compares. */
function short(sha) {
  return typeof sha === 'string' && sha ? sha.slice(0, 7) : ''
}

// A fixed UTC rendering, never toLocaleString(): the Electron app and a browser
// tab on the same machine must not disagree about when this was built.
function when(iso) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return ''
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** "packaged from a1b2c3d on 2026-07-25 12:34 UTC" — degrading as fields go missing. */
function packagedFrom(build) {
  const at = when(build.builtAt)
  return `packaged from ${short(build.commit)}${at ? ` on ${at}` : ''}`
}

function at(build) {
  return build.repoRoot ? ` at ${build.repoRoot}` : ''
}

function inRoot(build) {
  return build.repoRoot ? ` ${build.repoRoot}` : ' the checkout'
}

/**
 * @returns {{text: string, command: string|null, tone: 'info'|'warn'}|null}
 *
 * null means render nothing at all — the pre-#40 Setup panel, exactly. That is
 * the fail-open path for a bundle with no baked commit, a checkout with no git,
 * and any drift value this build of the frontend does not recognise.
 */
export function buildSummary(build) {
  if (!build || typeof build !== 'object') return null
  switch (build.drift) {
    // A checkout cannot be stale against itself — say what it is running, stop.
    case 'dev':
      return build.head
        ? { text: `Running from the checkout${at(build)} · HEAD ${short(build.head)}.`, command: null, tone: 'info' }
        : null

    case 'current':
      return { text: `This app is the current build — ${packagedFrom(build)}, and${inRoot(build)} is still on that commit.`, command: null, tone: 'info' }

    // The one case that costs the human real time: they are testing a bundle
    // that is missing everything merged since. Name both commits so the claim
    // is checkable, and give the exact command.
    case 'stale':
      return {
        text: `⚠ This app is behind its source — ${packagedFrom(build)}, while${inRoot(build)} has since moved on to ${short(build.head)}. Rebuild it with:`,
        command: REBUILD,
        tone: 'warn',
      }

    // The checkout was moved BACK (an older branch, a bisect). The app is ahead
    // of the source, so repackaging would DOWNGRADE it. Not a warning, and
    // deliberately not the same sentence as `stale`.
    case 'behind':
      return {
        text: `This app is newer than the checkout — ${packagedFrom(build)}, while${inRoot(build)} is on the earlier commit ${short(build.head)}. Nothing to rebuild.`,
        command: null,
        tone: 'info',
      }

    case 'diverged':
      return {
        text: `${packagedFrom(build)[0].toUpperCase()}${packagedFrom(build).slice(1)};${inRoot(build)} is now on ${short(build.head)}, which is neither ahead of nor behind it. Repackage to match:`,
        command: REBUILD,
        tone: 'info',
      }

    // Packaged, and something could not be read — no commit baked in, or the
    // checkout has moved/vanished. Answer "which build is this" anyway; that
    // alone is more than existed before #40.
    case 'unknown': {
      if (!build.commit) return null
      const p = packagedFrom(build)
      return {
        text: `${p[0].toUpperCase()}${p.slice(1)}. Could not read${inRoot(build)} to check whether it has moved on.`,
        command: null,
        tone: 'info',
      }
    }

    default:
      return null
  }
}
