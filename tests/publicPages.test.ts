import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { renderPage, renderSitemap } from '../build/publicPages'
import { pageMetadata } from '../src/content/metadata'

const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

describe('public HTML without JavaScript', () => {
  it('contains readable Markdown, semantic landmarks, and crawlable navigation', () => {
    const dom = new JSDOM(renderPage(template, '/'))
    const document = dom.window.document
    expect(document.querySelectorAll('main')).toHaveLength(1)
    expect(document.querySelectorAll('h1')).toHaveLength(1)
    expect(document.querySelector('h1')?.textContent?.trim()).toBeTruthy()
    expect(document.querySelector('.home-content p')?.textContent?.trim()).toBeTruthy()
    expect(document.querySelector('nav a[href="/terms/"]')).not.toBeNull()
    expect(document.querySelector('footer a[href^="https://github.com/"]')).not.toBeNull()
    expect(document.querySelector('meta[name="robots"]')).toBeNull()
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://parrhesia.chat/')
    expect(JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!)).toMatchObject({
      '@type': 'WebSite', name: 'Parrhesia', url: 'https://parrhesia.chat/'
    })
    expect(document.querySelector('button#create-room')?.hasAttribute('disabled')).toBe(true)
    dom.window.close()
  })

  it('renders the existing Terms and their own metadata in the initial response', () => {
    const dom = new JSDOM(renderPage(template, '/terms/index.html'))
    const document = dom.window.document
    expect(document.querySelector('main h1')?.textContent).toBe('Terms of Service')
    expect(document.querySelectorAll('main h2').length).toBeGreaterThan(1)
    expect(document.title).toBe(pageMetadata.terms.title)
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(pageMetadata.terms.description)
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://parrhesia.chat/terms/')
    expect(document.querySelector('#create-room')).toBeNull()
    dom.window.close()
  })

  it.each(['/room.html', '/404.html'])('excludes %s without public canonical or site markup', path => {
    const dom = new JSDOM(renderPage(template, path))
    const document = dom.window.document
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex')
    expect(document.querySelector('link[rel="canonical"]')).toBeNull()
    expect(document.querySelector('meta[property="og:url"]')).toBeNull()
    expect(document.querySelector('script[type="application/ld+json"]')).toBeNull()
    dom.window.close()
  })

  it('escapes author-supplied titles and descriptions in HTML attributes and text', () => {
    const original = { ...pageMetadata.home }
    try {
      pageMetadata.home.title = '<script>alert("title")</script> & Parrhesia'
      pageMetadata.home.description = '" /><script>alert("description")</script>'
      const dom = new JSDOM(renderPage(template, '/'))
      expect(dom.window.document.title).toBe(pageMetadata.home.title)
      expect(dom.window.document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(pageMetadata.home.description)
      expect(dom.window.document.querySelectorAll('script')).toHaveLength(2)
      dom.window.close()
    } finally {
      Object.assign(pageMetadata.home, original)
    }
  })

  it('lists only canonical public pages in valid XML', () => {
    const dom = new JSDOM(renderSitemap(), { contentType: 'application/xml' })
    const locations = Array.from(dom.window.document.querySelectorAll('loc'), element => element.textContent)
    expect(locations).toEqual(['https://parrhesia.chat/', 'https://parrhesia.chat/terms/'])
    dom.window.close()
  })
})
