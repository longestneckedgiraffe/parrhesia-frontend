import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let server: ViteDevServer
let origin: string

beforeAll(async () => {
  server = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'silent'
  })
  await server.listen()
  const address = server.httpServer!.address() as AddressInfo
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await server?.close()
})

describe('development HTTP routes', () => {
  it.each([
    ['/', 'id="create-room"'],
    ['/terms/', 'Terms of Service'],
    ['/?room=synthetic', 'id="create-room"']
  ])('serves initial HTML at %s', async (path, content) => {
    const response = await fetch(origin + path)
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain(content)
    expect(html).toMatch(/<main[\s>]/)
    expect(html).not.toContain('{{PAGE_')
    expect(response.headers.get('X-Robots-Tag')).toBe(path.includes('room=') ? 'noindex' : null)
  })

  it('redirects the legacy Terms URL', async () => {
    const response = await fetch(`${origin}/?terms`, { redirect: 'manual' })
    expect(response.status).toBe(308)
    expect(response.headers.get('Location')).toBe('/terms/')
  })

  it.each(['/missing', '/missing?terms', '/assets/missing.js', '/404.html'])('serves a useful 404 at %s', async path => {
    const response = await fetch(origin + path)
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('Page not found')
  })

  it.each([
    ['/robots.txt', 'text/plain', 'User-agent: *'],
    ['/sitemap.xml', 'application/xml', '<urlset'],
    ['/src/content/terms.md?import&raw', 'javascript', 'export default']
  ])('preserves %s as its actual resource type', async (path, type, content) => {
    const response = await fetch(origin + path)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain(type)
    expect(await response.text()).toContain(content)
  })
})
