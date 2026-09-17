import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { renderPage, renderSitemap } from './build/publicPages'
import { resolvePageRequest } from './worker'

export default defineConfig({
  appType: 'mpa',
  plugins: [{
    name: 'public-pages',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        return renderPage(html, context.path)
      }
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: renderSitemap() })
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const route = resolvePageRequest(url)
        if (url.searchParams.has('room') || url.pathname === '/room.html') {
          response.setHeader('X-Robots-Tag', 'noindex')
          response.setHeader('Cache-Control', 'private, no-store')
        }
        if (route.redirect) {
          response.writeHead(308, { Location: route.redirect }).end()
          return
        }
        if (url.pathname === '/sitemap.xml') {
          response.writeHead(200, { 'Content-Type': 'application/xml' }).end(renderSitemap())
          return
        }
        request.url = route.assetPath + url.search
        next()
      })
      return () => {
        server.middlewares.use(async (request, response, next) => {
          const path = new URL(request.url ?? '/', 'http://localhost').pathname
          if (['/index.html', '/terms/index.html', '/room.html'].includes(path)) {
            next()
            return
          }
          try {
            const template = readFileSync(new URL('./404.html', import.meta.url), 'utf8')
            const html = await server.transformIndexHtml('/404.html', template)
            response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' })
            response.end(request.method === 'HEAD' ? undefined : html)
          } catch (error) {
            next(error)
          }
        })
      }
    }
  }],
  build: {
    rollupOptions: {
      input: Object.fromEntries(['index.html', 'terms/index.html', 'room.html', '404.html'].map(path => [
        path,
        fileURLToPath(new URL(path, import.meta.url))
      ]))
    }
  }
})
