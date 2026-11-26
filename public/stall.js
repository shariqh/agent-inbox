// A poll read that stops arriving ends (slow links, step 1). On a link that drops for a while a
// read can wait forever, and the round with it. stallLimited aborts the read when its headers have
// not arrived within STALL_MS, or when, while its body is being read, no bytes arrive for STALL_MS.
// A slow body that keeps arriving is never cut, and the time before the caller starts reading the
// body does not count. The aborted read rejects, as a network error does.

export const STALL_MS = 30_000

// statuses whose answer never has a body; a stand-in may still carry one, so these pass through as they are
const NO_BODY = new Set([101, 103, 204, 205, 304])

function stallError() {
  return new DOMException(`No bytes for ${STALL_MS / 1000} s`, 'TimeoutError')
}

// The same answer, its body read through a guard: each read the caller asks for must bring bytes
// (or the end) within STALL_MS. Nothing is read before the caller asks.
function guardBody(response, stall) {
  const body = response.body
  if (NO_BODY.has(response.status) || !body || typeof body.getReader !== 'function') return response
  const reader = body.getReader()
  let ended = false
  const guarded = new ReadableStream({
    pull: (out) => new Promise((pulled) => {
      const timer = setTimeout(() => {
        ended = true
        const error = stall()
        out.error(error)
        reader.cancel(error).catch(() => {})
        pulled()
      }, STALL_MS)
      reader.read().then(({ done, value }) => {
        clearTimeout(timer)
        if (!ended && done) {
          ended = true
          out.close()
        } else if (!ended) out.enqueue(value)
        pulled()
      }, (error) => {
        clearTimeout(timer)
        if (!ended) {
          ended = true
          out.error(error)
        }
        pulled()
      })
    }),
    cancel: (reason) => {
      ended = true
      return reader.cancel(reason)
    },
  }, { highWaterMark: 0 })
  return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/** `start(signal)` makes the fetch; its answer, ended by a stall as described above. */
export function stallLimited(start) {
  const controller = new AbortController()
  const stall = () => {
    const error = stallError()
    controller.abort(error)
    return error
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(stall()), STALL_MS)
    start(controller.signal).then((response) => {
      clearTimeout(timer)
      // headers that came after the read was given up: let the connection go
      if (controller.signal.aborted) {
        Promise.resolve(response.body?.cancel?.()).catch(() => {})
        return
      }
      try {
        resolve(guardBody(response, stall))
      } catch (error) {
        // an answer the guard cannot wrap must end this read, or the round waits on it forever
        controller.abort(error)
        reject(error)
      }
    }, (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
