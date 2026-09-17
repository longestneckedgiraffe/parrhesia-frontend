import { readFileSync } from 'node:fs'
import { pageMetadata, siteUrl } from '../src/content/metadata'
import { renderLandingPage, renderTermsPage } from '../src/publicPages'

export const publicPaths = ['/', '/terms/']

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function renderPage(template: string, path: string): string {
  const terms = path === '/terms/index.html' || path === '/terms/'
  const room = path === '/room.html'
  const notFound = path === '/404.html'
  const metadata = terms ? pageMetadata.terms : room || notFound
    ? { title: 'parrhesia', description: 'end-to-end encrypted chat' }
    : pageMetadata.home
  const canonical = `${siteUrl}${terms ? '/terms/' : '/'}`
  const content = notFound
    ? '<main class="terms"><h1>Page not found</h1><a href="/" class="back-link">back to Parrhesia</a></main>'
    : terms
      ? renderTermsPage(readFileSync(new URL('../src/content/terms.md', import.meta.url), 'utf8'))
      : renderLandingPage(readFileSync(new URL('../src/content/home.md', import.meta.url), 'utf8'), { disabled: true })
  const head = `
    <title>${escapeHtml(metadata.title)}</title>
    <meta name="description" content="${escapeHtml(metadata.description)}" />
    ${room || notFound ? '<meta name="robots" content="noindex" />' : `<link rel="canonical" href="${canonical}" />`}
    <meta property="og:title" content="${escapeHtml(metadata.title)}" />
    <meta property="og:description" content="${escapeHtml(metadata.description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Parrhesia" />
    ${room || notFound ? '' : `<meta property="og:url" content="${canonical}" />`}
    <meta property="og:image" content="${siteUrl}/favicon/web-app-manifest-512x512.png" />
    <meta property="og:image:alt" content="Parrhesia logo" />
    <meta property="og:image:width" content="512" />
    <meta property="og:image:height" content="512" />
    ${!terms && !room && !notFound ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Parrhesia', url: canonical })}</script>` : ''}
  `
  return template
    .replace('{{PAGE_HEAD}}', head)
    .replace('{{PAGE_BODY}}', content)
    .replace('{{BODY_CLASS}}', terms || notFound ? 'terms-page' : 'landing-page')
}

export function renderSitemap(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${publicPaths.map(path => `  <url><loc>${siteUrl}${path}</loc></url>`).join('\n')}
</urlset>
`
}
