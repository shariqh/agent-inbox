import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd())
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8')
const css = readFileSync(join(root, 'public', 'style.css'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
}

describe('the Agent Inbox identity assets', () => {
  it('wires generated browser icons and the same full-color in-product mark', () => {
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
    expect(html).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />')
    expect(html).toContain('<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />')
    expect(html).toContain('<img class="brand-mark" src="/favicon-32.png" alt="" aria-hidden="true"')
    expect(html).not.toContain('class="brand-dot"')
    expect(css).toMatch(/\.brand-mark\s*\{[^}]*width:\s*22px[^}]*height:\s*22px/s)
    expect(css).not.toMatch(/\.brand-mark\s*\{[^}]*(?:mask|background):/s)
  })

  it('keeps the icon generator and package consumer explicit', () => {
    expect(pkg.scripts?.['generate:icons']).toBe('bash scripts/generate-icons.sh')
    const packageScript = readFileSync(join(root, 'scripts', 'package-app.sh'), 'utf8')
    expect(packageScript).toContain('npm run generate:icons -- --check')
    expect(packageScript).toContain('--icon="$ROOT/electron/icon.icns"')
    expect(packageScript.indexOf('generate:icons -- --check')).toBeLessThan(packageScript.indexOf('@electron/packager'))
    expect(() => readFileSync(join(root, 'scripts', 'render-icon.cjs'), 'utf8')).toThrow()
    const manifest = JSON.parse(readFileSync(join(root, 'assets', 'icon-manifest.json'), 'utf8')) as {
      sources?: unknown
      outputs?: unknown
    }
    expect(manifest.sources).toBeTruthy()
    expect(manifest.outputs).toBeTruthy()
  })

  it.runIf(process.platform === 'darwin')('has fresh deterministic generated outputs with standard ICNS representations', () => {
    execFileSync('bash', [join(root, 'scripts', 'generate-icons.sh'), '--check'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const dimensions = (file: string): string => execFileSync(
      'sips',
      ['-g', 'pixelWidth', '-g', 'pixelHeight', file],
      { encoding: 'utf8' },
    ).match(/pixelWidth:\s*(\d+)[\s\S]*pixelHeight:\s*(\d+)/)?.slice(1).join('x') ?? ''

    expect(dimensions(join(root, 'assets', 'icon-1024.png'))).toBe('1024x1024')
    expect(dimensions(join(root, 'public', 'favicon-32.png'))).toBe('32x32')
    expect(dimensions(join(root, 'public', 'favicon-16.png'))).toBe('16x16')

    const iconset = join(mkdtempSync(join(tmpdir(), 'agent-inbox-icon-')), 'AgentInbox.iconset')
    execFileSync('iconutil', ['--convert', 'iconset', '--output', iconset, join(root, 'electron', 'icon.icns')])
    for (const name of [
      'icon_16x16.png',
      'icon_16x16@2x.png',
      'icon_32x32.png',
      'icon_32x32@2x.png',
      'icon_128x128.png',
      'icon_128x128@2x.png',
      'icon_256x256.png',
      'icon_256x256@2x.png',
      'icon_512x512.png',
      'icon_512x512@2x.png',
    ]) {
      expect(() => readFileSync(join(iconset, name))).not.toThrow()
    }
  })
})
