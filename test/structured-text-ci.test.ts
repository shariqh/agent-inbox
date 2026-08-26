import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd())
const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const structuredTextTest = readFileSync(join(root, 'test', 'structured-text.test.ts'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

function jobSource(name: string): string {
  const marker = `  ${name}:\n`
  const start = workflow.indexOf(marker)
  if (start < 0) return ''
  const afterMarker = workflow.slice(start + marker.length)
  const nextJob = afterMarker.search(/^  [\w-]+:\n/m)
  return nextJob < 0
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + nextJob)
}

function hostileTestBody(): ts.Block {
  const source = ts.createSourceFile(
    'structured-text.test.ts',
    structuredTextTest,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  let body: ts.Block | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'it' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text ===
        'keeps hostile 50k-candidate input linear and isolated between renders'
    ) {
      const callback = node.arguments[1]
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        ts.isBlock(callback.body)
      ) {
        body = callback.body
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!body) throw new Error('hostile-input test body not found')
  return body
}

function expectCalls(body: ts.Block): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'expect'
    ) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return calls
}

function enclosingCondition(node: ts.Node, body: ts.Block): ts.IfStatement | undefined {
  for (let parent = node.parent; parent && parent !== body; parent = parent.parent) {
    if (ts.isIfStatement(parent)) return parent
  }
  return undefined
}

describe('structured-text performance CI gate', () => {
  it('runs the exact hostile-input test in an isolated opt-in command', () => {
    const command = pkg.scripts['test:structured-text:perf']
    expect(command).toBe(
      'AGENT_INBOX_STRUCTURED_TEXT_PERF_GATE=1 ' +
      'vitest run test/structured-text.test.ts ' +
      '-t "keeps hostile 50k-candidate input linear and isolated between renders"',
    )
  })

  it('runs the isolated gate on both required Node 24 CI platforms', () => {
    const testJob = jobSource('test')
    expect(testJob).toContain('node-version: 24')
    expect(testJob).toContain('os: [ubuntu-latest, macos-14]')
    const stepMarker = '- name: Verify structured-text hostile-input performance\n'
    const stepStart = testJob.indexOf(stepMarker)
    const afterStep = testJob.slice(stepStart + stepMarker.length)
    const nextStep = afterStep.search(/^\s{6}- /m)
    const performanceStep = nextStep < 0 ? afterStep : afterStep.slice(0, nextStep)
    expect(stepStart).toBeGreaterThanOrEqual(0)
    expect(performanceStep).toContain('run: npm run test:structured-text:perf')
    expect(performanceStep).not.toMatch(/^\s+if:/m)
    expect(testJob.match(/npm run test:structured-text:perf/g)).toHaveLength(1)
  })

  it('keeps correctness in the normal suite and gates only the wall-clock expectation', () => {
    expect(pkg.scripts.test).toBe('vitest run')
    expect(structuredTextTest).toMatch(
      /const STRUCTURED_TEXT_PERF_GATE\s*=\s*process\.env\.AGENT_INBOX_STRUCTURED_TEXT_PERF_GATE === '1'/,
    )

    const body = hostileTestBody()
    const assertions = expectCalls(body)
    expect(assertions).toHaveLength(4)

    const timingAssertion = assertions.find((assertion) =>
      assertion.getText().includes('expect(elapsed)'),
    )
    if (!timingAssertion) throw new Error('timing assertion not found')
    expect(enclosingCondition(timingAssertion, body)?.expression.getText())
      .toBe('STRUCTURED_TEXT_PERF_GATE')

    const correctnessAssertions = assertions.filter((assertion) => assertion !== timingAssertion)
    expect(correctnessAssertions).toHaveLength(3)
    expect(
      correctnessAssertions.every((assertion) => !enclosingCondition(assertion, body)),
    ).toBe(true)
    expect(body.getText()).toContain('href="https://prose.example/x"')
    expect(body.getText()).toContain('https://attribute.example/x')
    expect(body.getText()).toContain('https://fresh.example/x')
    expect(body.getText()).toMatch(
      /if \(STRUCTURED_TEXT_PERF_GATE\) \{\s*expect\(elapsed\)\.toBeLessThan\(100\)\s*\}/,
    )
  })
})
