// A fake made-agent runner for the root tests (agents a chat makes, step 1): the root suite has no
// packages/mesh build or dependencies, so `meshctl new --checkout <scratch>` finds this file copied
// to <scratch>/packages/mesh/dist/made-agent.js. It speaks the real runner's three modes with Node
// core only: --card prints a card of the same shape, --try prints a fixed answer, and --id serves
// the card with the identity proof and answers SendMessage, reading the same files the real one
// reads. FAKE_RUNNER (in the environment it inherits) bends it: `card-fail`, `try-fail`,
// `no-listen`, `other-card`. It records its pid under <mesh dir>/fake-pids/ so a test can stop it,
// and it stops once its mesh.json entry, seen once, is gone or names another port.
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const args = process.argv.slice(2)
const mode = process.env.FAKE_RUNNER ?? ''
const dir = process.env.AGENT_INBOX_MESH_DIR
const flag = (name) => args[args.indexOf(name) + 1]
const card = (id, description, port) => ({
  name: id, description, version: '1.0.0',
  provider: { organization: 'made on this Mac', url: 'https://agent-inbox.invalid/' },
  supportedInterfaces: [{ url: `http://127.0.0.1:${port}/`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: {
    streaming: false, pushNotifications: false,
    extensions: [{ uri: 'https://shariqh.github.io/agent-inbox/ext/profile/v1', description: 'Stable id, signing keys, and per-skill egress and residency', params: { id: `agent-inbox.invalid/made/${id}`, skills: { run: { egress: [{ purpose: 'model', hosts: 'operator', sends: 'input' }], residency: 'caller-host' } } } }],
  },
  securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
  securityRequirements: [{ schemes: { bearer: { list: ['call'] } } }],
  defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
  skills: [{ id: 'run', name: id, description, tags: ['made'] }],
})

if (args[0] === '--card') {
  if (mode === 'card-fail') {
    process.stderr.write('made-agent: the card file cannot be read: it must be a regular file\n')
    process.exit(1)
  }
  const c = JSON.parse(readFileSync(flag('--from'), 'utf8'))
  process.stdout.write(`${JSON.stringify(card(c.name, c.description.trim(), Number(flag('--port'))))}\n`)
} else if (args[0] === '--try') {
  if (mode === 'try-fail') {
    process.stderr.write('made-agent: the try failed: the server box is busy (backend-5xx): try again later\n')
    process.exit(1)
  }
  const c = JSON.parse(readFileSync(flag('--from'), 'utf8'))
  const sample = readFileSync(flag('--input'), 'utf8')
  process.stdout.write(`- ${c.name} read ${sample.length} characters [fake]`)
} else if (args[0] === '--id') {
  const id = flag('--id')
  mkdirSync(join(dir, 'fake-pids'), { recursive: true })
  writeFileSync(join(dir, 'fake-pids', `${id}-${process.pid}`), String(process.pid))
  if (mode === 'no-listen') {
    process.stderr.write('made-agent: the server box is not in mesh/servers.json, or it cannot be read: meshctl server list\n')
    process.exit(1)
  }
  const description = JSON.parse(readFileSync(join(dir, 'mesh', 'agents', `${id}.json`), 'utf8'))
  const token = readFileSync(join(dir, 'mesh', 'tokens', id), 'utf8').trim()
  const port = JSON.parse(readFileSync(join(dir, 'mesh', 'wrappers', `${id}.json`), 'utf8')).port
  const served = JSON.stringify(card(id, mode === 'other-card' ? 'Another description.' : description.description, port))
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'GET') {
        const nonce = req.headers['a2a-mesh-challenge']
        const proof = typeof nonce === 'string' ? { 'a2a-mesh-proof': createHmac('sha256', token).update(`a2a-mesh/v1\n${nonce}`).digest('base64url') } : {}
        return void res.writeHead(200, { 'content-type': 'application/json', ...proof }).end(served)
      }
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end()
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const input = body.params.message.parts[0].text
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { message: { messageId: 'm1', role: 'ROLE_AGENT', parts: [{ text: `made answer from ${id}: ${input.length} characters` }] } } }))
    })
  })
  server.listen(port, '127.0.0.1', () => process.stderr.write(`made-agent: ${id} listening on http://127.0.0.1:${port}/\n`))
  server.on('error', () => process.exit(1))
  // the real runner's gate, faster: once the entry has been seen, its going (or naming another port) stops it
  let seen = false
  setInterval(() => {
    let entry
    try { entry = JSON.parse(readFileSync(join(dir, 'mesh.json'), 'utf8')).agents?.[id] } catch { /* none */ }
    const on = entry !== undefined && entry.endpoint === `http://127.0.0.1:${port}/`
    if (on) seen = true
    else if (seen) {
      process.stderr.write('made-agent: stopped (mesh.json)\n')
      process.exit(0)
    }
  }, 100)
  setTimeout(() => process.exit(0), 60_000)
}
