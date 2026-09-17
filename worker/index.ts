interface Environment {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

export function resolvePageRequest(url: URL): { assetPath: string, redirect?: string } {
  if ((url.pathname === '/' || url.pathname === '/index.html') && url.searchParams.has('terms')) {
    const target = new URL(url)
    target.pathname = '/terms/'
    target.searchParams.delete('terms')
    return { assetPath: '/terms/index.html', redirect: target.pathname + target.search }
  }

  const aliases: Record<string, string> = {
    '/index.html': '/',
    '/terms': '/terms/',
    '/terms.html': '/terms/',
    '/terms/index.html': '/terms/'
  }
  const redirect = aliases[url.pathname]
  if (redirect) return { assetPath: '', redirect: redirect + url.search }
  if (url.pathname === '/') {
    return { assetPath: url.searchParams.has('room') ? '/room.html' : '/index.html' }
  }
  if (url.pathname === '/terms/') return { assetPath: '/terms/index.html' }
  return { assetPath: url.pathname }
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url)
    const privatePage = url.searchParams.has('room') || url.pathname === '/room.html'
    const route = resolvePageRequest(url)
    let response: Response

    if (route.redirect) {
      response = new Response(null, { status: 308, headers: { Location: route.redirect } })
    } else {
      const assetUrl = new URL(route.assetPath, url.origin)
      const assetRequest = new Request(assetUrl, request)
      if (privatePage) {
        assetRequest.headers.delete('If-None-Match')
        assetRequest.headers.delete('If-Modified-Since')
      }
      response = await env.ASSETS.fetch(assetRequest)
      if (response.status === 404 || url.pathname === '/404.html') {
        const fallback = await env.ASSETS.fetch(new Request(new URL('/404.html', url.origin), { method: 'GET' }))
        response = new Response(request.method === 'HEAD' ? null : fallback.body, {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        })
      }
    }

    const headers = new Headers(response.headers)
    if (privatePage || response.status === 404) headers.set('X-Robots-Tag', 'noindex')
    if (privatePage) {
      headers.set('Cache-Control', 'private, no-store')
      headers.set('Referrer-Policy', 'no-referrer')
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
