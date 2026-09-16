import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface TestConnection {
  connect: ReturnType<typeof vi.fn>
  admit: () => void
  reject: (error: Error) => void
}

const mocks = vi.hoisted(() => ({
  sessions: [] as TestConnection[],
  onRoomJoined: vi.fn(),
  onRoomLeft: vi.fn(),
  isRoomOccupied: vi.fn().mockReturnValue(false),
  fetch: vi.fn()
}))

vi.mock('../src/network/websocket', () => ({
  ChatConnection: class {
    closed = false
    connect = vi.fn(() => new Promise<void>((resolve, reject) => {
      this.admit = resolve
      this.reject = reject
    }))
    admit: () => void = () => {}
    reject: (error: Error) => void = () => {}
    prepare = vi.fn().mockResolvedValue({})
    getPeerIds = () => []
    getPeerCount = () => 0
    getPeerId = () => 'me'
    getMyColor = () => 'blue'
    getMyPublicKey = () => 'signing-key'
    canSend = () => false
    isClosed = () => this.closed
    disconnect = () => { this.closed = true }
    constructor() { mocks.sessions.push(this) }
  }
}))

vi.mock('../src/utils/tabSync', () => ({
  initTabSync: vi.fn(),
  isRoomOccupied: mocks.isRoomOccupied,
  onRoomJoined: mocks.onRoomJoined,
  onRoomLeft: mocks.onRoomLeft
}))

vi.mock('../src/crypto/crypto', () => ({
  clearLegacyStorage: vi.fn(),
  encryptMessages: vi.fn(),
  decryptMessages: vi.fn(),
  isEncryptedData: vi.fn().mockReturnValue(false)
}))

const password = 'café telescopes drift slowly '
let dom: JSDOM

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.sessions = []
  mocks.isRoomOccupied.mockReturnValue(false)
  mocks.fetch.mockImplementation(async (_url: string, options?: RequestInit) => Response.json(
    options?.method === 'POST'
      ? { room_id: 'created-room', password_required: Boolean(options.body) }
      : { exists: true, password_required: true }
  ))
  vi.stubGlobal('fetch', mocks.fetch)
})

afterEach(() => {
  dom?.window.close()
  vi.unstubAllGlobals()
})

async function loadPage(path = '/', agreed = true): Promise<void> {
  dom = new JSDOM('<div id="app"></div>', { url: `https://frontend.test${path}` })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('localStorage', dom.window.localStorage)
  if (agreed) localStorage.setItem('parrhesia-terms-agreement', JSON.stringify({ version: '2026-07-17' }))
  await import('../src/main')
}

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement
}

function click(id: string): void {
  (document.getElementById(id) as HTMLElement).click()
}

async function session(index = 0): Promise<TestConnection> {
  await vi.waitFor(() => expect(mocks.sessions[index]?.connect).toHaveBeenCalled())
  return mocks.sessions[index]
}

function submitPassword(value: string): void {
  input('join-password').value = value
  click('submit-password')
}

describe('room entry', () => {
  it('adds one optional home password field and keeps it through theme changes', async () => {
    await loadPage()
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1)
    expect(input('room-password').required).toBe(false)
    expect(input('room-password').parentElement).toBe(input('room-input').parentElement)
    input('room-password').value = password
    click('theme-toggle')
    expect(input('room-password').value).toBe(password)
    expect(localStorage.getItem('parrhesia-theme')).toBe('dark')
    expect(JSON.stringify(localStorage)).not.toContain(password)
  })

  it('retains a creation password through terms acceptance and waits for admission', async () => {
    await loadPage('/', false)
    input('room-password').value = password
    click('create-room')
    expect(document.getElementById('terms-agreement-panel')).not.toBeNull()
    expect(input('room-password').value).toBe('')
    expect(mocks.fetch).not.toHaveBeenCalled()
    click('accept-terms')
    const connection = await session()
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ password })
    expect(connection.connect).toHaveBeenCalledWith(true, password)
    expect(document.querySelector('.chat')).toBeNull()
    expect(mocks.onRoomJoined).not.toHaveBeenCalled()
    expect(window.location.search).toBe('')
    connection.admit()
    await vi.waitFor(() => expect(document.querySelector('.chat')).not.toBeNull())
    expect(mocks.onRoomJoined).toHaveBeenCalledWith('created-room')
    expect(window.location.search).toBe('?room=created-room')
    expect(JSON.stringify(localStorage)).not.toContain(password)
    expect(document.body.innerHTML).not.toContain(password)
    expect(input('message-input').disabled).toBe(true)
  })

  it('clears a cancelled creation attempt and does not create a room', async () => {
    await loadPage('/', false)
    input('room-password').value = password
    click('create-room')
    click('decline-terms')
    await vi.waitFor(() => expect(input('create-room').disabled).toBe(false))
    expect(input('room-password').value).toBe('')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('uses the home field for protected joins and preserves failure messages', async () => {
    await loadPage()
    input('room-input').value = 'protected-room'
    click('join-room')
    await vi.waitFor(() => expect(document.body.textContent).toContain('Please enter this room\'s password'))
    expect(mocks.sessions).toHaveLength(0)
    input('room-password').value = 'wrong password'
    input('room-password').dispatchEvent(new dom.window.KeyboardEvent('keypress', { key: 'Enter' }))
    const connection = await session()
    const { RoomAccessError } = await import('../src/network/rooms')
    connection.reject(new RoomAccessError('Password was not accepted. Please try again.', 'auth_failed'))
    await vi.waitFor(() => expect(document.body.textContent).toContain('Password was not accepted'))
    expect(document.getElementById('password-panel')).toBeNull()
    expect(input('room-password').value).toBe('')
    expect(input('room-input').value).toBe('protected-room')
    expect(mocks.onRoomJoined).not.toHaveBeenCalled()
    input('room-password').value = password
    click('join-room')
    const retry = await session(1)
    expect(retry.connect).toHaveBeenCalledWith(true, password)
    retry.admit()
    await vi.waitFor(() => expect(document.querySelector('.chat')).not.toBeNull())
  })

  it('prompts for protected links after terms and retries in the existing modal style', async () => {
    await loadPage('/?room=protected-room', false)
    await vi.waitFor(() => expect(document.getElementById('terms-agreement-panel')).not.toBeNull())
    expect(mocks.sessions).toHaveLength(0)
    click('accept-terms')
    await vi.waitFor(() => expect(document.getElementById('password-panel')).not.toBeNull())
    expect(document.getElementById('password-panel')?.className).toBe('modal-panel verification-panel')
    expect(input('join-password').className).toBe('password-input')
    expect(document.activeElement).toBe(input('join-password'))
    submitPassword('wrong password')
    const connection = await session()
    expect(document.querySelector('.chat')).toBeNull()
    const { RoomAccessError } = await import('../src/network/rooms')
    connection.reject(new RoomAccessError('Password was not accepted. Please try again.', 'auth_failed'))
    await vi.waitFor(() => expect(document.getElementById('password-error')?.textContent).toContain('Password was not accepted'))
    expect(input('join-password').value).toBe('')
    expect(mocks.onRoomJoined).not.toHaveBeenCalled()
    submitPassword(password)
    const retry = await session(1)
    expect(retry.connect).toHaveBeenCalledWith(true, password)
    retry.admit()
    await vi.waitFor(() => expect(document.querySelector('.chat')).not.toBeNull())
    expect(window.location.search).toBe('?room=protected-room')
    expect(JSON.stringify(localStorage)).not.toContain(password)
  })

  it.each(['button', 'escape', 'overlay'])('cancels the direct-link prompt via %s without opening a socket', async method => {
    await loadPage('/?room=protected-room')
    await vi.waitFor(() => expect(document.getElementById('password-panel')).not.toBeNull())
    input('join-password').value = password
    if (method === 'button') click('cancel-password')
    if (method === 'overlay') click('password-overlay')
    if (method === 'escape') input('join-password').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(input('join-room').disabled).toBe(false))
    expect(document.getElementById('password-panel')).toBeNull()
    expect(mocks.sessions).toHaveLength(0)
    expect(input('room-password').value).toBe('')
    expect(document.activeElement).toBe(input('room-password'))
  })

  it('joins open links without a password prompt', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ exists: true, password_required: false }))
    await loadPage('/?room=open-room')
    const connection = await session()
    expect(connection.connect).toHaveBeenCalledWith(false, '')
    expect(document.getElementById('password-panel')).toBeNull()
    connection.admit()
    await vi.waitFor(() => expect(document.querySelector('.chat')).not.toBeNull())
  })

  it('does not join when protected creation is not confirmed', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ room_id: 'unsafe', password_required: false }))
    await loadPage()
    input('room-password').value = password
    click('create-room')
    await vi.waitFor(() => expect(document.body.textContent).toContain('did not confirm password protection'))
    expect(mocks.sessions).toHaveLength(0)
    expect(mocks.onRoomJoined).not.toHaveBeenCalled()
    expect(window.location.search).toBe('')
  })
})
