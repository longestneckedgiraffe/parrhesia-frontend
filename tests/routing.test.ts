import { describe, expect, it, vi } from 'vitest'
import worker from '../worker'

function assets() {
  const content: Record<string, string> = {
    '/index.html': '<h1>Public homepage</h1>',
    '/room.html': '<meta name="robots" content="noindex"><h1>Parrhesia</h1>',
    '/terms/index.html': '<h1>Terms</h1>',
    '/404.html': '<h1>Page not found</h1>',
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/sitemap.xml': '<urlset></urlset>',
    '/assets/example.js': 'export {}'
  }
  return { ASSETS: { fetch: vi.fn(async (request: Request) => {
    const url = new URL(request.url)
    const body = content[url.pathname]
    return new Response(request.method === 'HEAD' ? null : body ?? 'Missing', {
      status: body === undefined ? 404 : 200,
      headers: { 'Cache-Control': 'public, max-age=60' }
    })
  }) } }
}

describe('edge routing', () => {
  it.each(['?room=example', '?room=', '?room', '?%72oom=example', '?utm_source=test&room=example'])('excludes invitations with %s in the initial response', async query => {
    const env = assets()
    const response = await worker.fetch(new Request(`https://parrhesia.chat/${query}`), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(await response.text()).not.toContain('example')
    expect(env.ASSETS.fetch.mock.calls[0][0].url).toBe('https://parrhesia.chat/room.html')
  })

  it('keeps homepage responses indexable before and after serving a room', async () => {
    const env = assets()
    for (const path of ['/', '/?room=example', '/']) {
      const response = await worker.fetch(new Request(`https://parrhesia.chat${path}`), env)
      expect(response.headers.get('X-Robots-Tag')).toBe(path === '/' ? null : 'noindex')
      expect(await response.text()).toContain(path === '/' ? 'Public homepage' : 'Parrhesia')
    }
  })

  it.each([
    ['/?terms', '/terms/'],
    ['/?terms=&utm_source=example', '/terms/?utm_source=example'],
    ['/?terms&room=example', '/terms/?room=example'],
    ['/index.html?room=example', '/?room=example'],
    ['/terms', '/terms/'],
    ['/terms.html', '/terms/'],
    ['/terms/index.html', '/terms/']
  ])('permanently redirects %s to %s without dropping functional parameters', async (path, target) => {
    const env = assets()
    const response = await worker.fetch(new Request(`https://parrhesia.chat${path}`), env)
    expect(response.status).toBe(308)
    expect(response.headers.get('Location')).toBe(target)
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
    if (path.includes('room=')) expect(response.headers.get('X-Robots-Tag')).toBe('noindex')
  })

  it.each(['/nonexistent', '/missing.js', '/assets/missing.css', '/nonexistent?room=example', '/404.html'])('returns a real 404 for %s', async path => {
    const response = await worker.fetch(new Request(`https://parrhesia.chat${path}`), assets())
    expect(response.status).toBe(404)
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex')
    expect(await response.text()).toContain('Page not found')
  })

  it.each(['/terms/', '/robots.txt', '/sitemap.xml', '/assets/example.js'])('serves %s without homepage fallback', async path => {
    const response = await worker.fetch(new Request(`https://parrhesia.chat${path}`), assets())
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Robots-Tag')).toBeNull()
    expect(await response.text()).not.toContain('Public homepage')
  })

  it.each(['/?room=example', '/missing'])('returns headers without a body for HEAD %s', async path => {
    const response = await worker.fetch(new Request(`https://parrhesia.chat${path}`, { method: 'HEAD' }), assets())
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex')
    expect(await response.text()).toBe('')
  })

  it('does not reuse conditional responses between private and public HTML', async () => {
    const env = assets()
    await worker.fetch(new Request('https://parrhesia.chat/?room=example', {
      headers: { 'If-None-Match': 'public-page-etag', 'If-Modified-Since': 'Wed, 16 Sep 2026 00:00:00 GMT' }
    }), env)
    const request = env.ASSETS.fetch.mock.calls[0][0]
    expect(request.headers.has('If-None-Match')).toBe(false)
    expect(request.headers.has('If-Modified-Since')).toBe(false)
  })
})
