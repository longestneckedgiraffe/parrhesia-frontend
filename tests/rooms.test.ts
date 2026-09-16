import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkRoom, createRoom } from '../src/network/rooms'
import { config } from '../src/network/config'

const password = 'cafe\u0301 telescopes drift slowly '
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('room admission API', () => {
  it('creates open rooms with the legacy empty request', async () => {
    fetchMock.mockResolvedValue(Response.json({ room_id: 'open' }))
    await expect(createRoom()).resolves.toEqual({ roomId: 'open', passwordRequired: false })
    expect(fetchMock).toHaveBeenCalledWith(config.endpoints.createRoom, { method: 'POST', cache: 'no-store' })
  })

  it('sends protected creation in the body without trimming the password', async () => {
    fetchMock.mockResolvedValue(Response.json({ room_id: 'protected', password_required: true }))
    await expect(createRoom(password)).resolves.toEqual({ roomId: 'protected', passwordRequired: true })
    expect(fetchMock).toHaveBeenCalledWith(config.endpoints.createRoom, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    })
  })

  it.each([undefined, false, 'true'])('refuses unconfirmed protection (%s)', async (password_required) => {
    fetchMock.mockResolvedValue(Response.json({ room_id: 'unsafe', password_required }))
    await expect(createRoom(password)).rejects.toThrow('did not confirm password protection')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['short', '🦒'.repeat(257), 'e\u0301'.repeat(256) + '\u0301'.repeat(129)])('rejects invalid creation passwords before a request', async (value) => {
    await expect(createRoom(value)).rejects.toThrow('15–256 characters')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('counts normalized Unicode code points rather than UTF-16 units', async () => {
    fetchMock.mockResolvedValue(Response.json({ room_id: 'unicode', password_required: true }))
    await expect(createRoom('🦒'.repeat(256))).resolves.toHaveProperty('passwordRequired', true)
  })

  it('surfaces common-password rejection without retrying an open creation', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'This password is commonly used; choose a different passphrase' }, { status: 400 }))
    await expect(createRoom(password)).rejects.toThrow('commonly used')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('preserves rate-limit delays and handles non-JSON server failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '12' } }))
    await expect(createRoom()).rejects.toThrow('12 seconds')
    fetchMock.mockResolvedValueOnce(new Response('upstream failure', { status: 502 }))
    await expect(createRoom()).rejects.toThrow('Unable to create room')
  })

  it('checks protection without caching and escapes room IDs in request paths', async () => {
    fetchMock.mockResolvedValue(Response.json({ exists: true, password_required: true }))
    await expect(checkRoom('room?password=secret')).resolves.toEqual({ exists: true, passwordRequired: true })
    expect(fetchMock).toHaveBeenCalledWith(`${config.apiBase}/api/rooms/room%3Fpassword%3Dsecret`, { cache: 'no-store' })
  })

  it('distinguishes missing rooms from unavailable servers', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
    await expect(checkRoom('missing')).resolves.toEqual({ exists: false, passwordRequired: false })
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(checkRoom('unavailable')).rejects.toThrow('temporarily unavailable')
  })
})
