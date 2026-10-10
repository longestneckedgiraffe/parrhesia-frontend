import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeerColor } from '../src/crypto/crypto'
import type { MessageHandler, PeerHandler, StatusHandler, TypingHandler } from '../src/network/websocket'
import { markAsVerified, storePeerKey } from '../src/crypto/tofu'
import { fingerprintKey } from '../src/utils/qr'

interface TestConnection {
  connect: ReturnType<typeof vi.fn>
  admit: () => void
  closed: boolean
  peers: Map<string, string>
  colors: Map<string, PeerColor>
  onMessage: MessageHandler
  onPeerJoined: PeerHandler
  onPeerLeft: PeerHandler
  onStatus: StatusHandler
  onTyping: TypingHandler
  onPeersChanged: () => Promise<void>
}

const mocks = vi.hoisted(() => ({ sessions: [] as TestConnection[] }))

vi.mock('../src/network/websocket', () => ({
  ChatConnection: class {
    closed = false
    peers = new Map<string, string>()
    colors = new Map<string, PeerColor>()
    admit: () => void = () => {}
    connect = vi.fn(() => new Promise<void>(resolve => { this.admit = resolve }))
    prepare = vi.fn().mockResolvedValue({})
    getPeerIds = () => this.closed ? [] : [...this.peers.keys()]
    getPeerCount = () => this.getPeerIds().length
    getPeerId = () => 'me'
    getMyColor = () => 'blue'
    getMyPublicKey = () => 'my-key'
    getPeerPublicKey = (id: string) => this.peers.get(id)
    getPeerColor = (id: string) => this.colors.get(this.peers.get(id)!)
    getIdentityColor = (key: string) => this.colors.get(key)
    canSend = () => !this.closed && this.getPeerCount() > 0
    isClosed = () => this.closed
    disconnect = () => { this.closed = true }
    constructor(
      _roomId: string,
      public onMessage: MessageHandler,
      public onPeerJoined: PeerHandler,
      public onPeerLeft: PeerHandler,
      public onStatus: StatusHandler,
      _onKeyChange: unknown,
      public onTyping: TypingHandler,
      public onPeersChanged: () => Promise<void>
    ) {
      mocks.sessions.push(this)
    }
  }
}))

vi.mock('../src/utils/tabSync', () => ({
  initTabSync: vi.fn(),
  isRoomOccupied: vi.fn().mockReturnValue(false),
  onRoomJoined: vi.fn(),
  onRoomLeft: vi.fn()
}))

vi.mock('../src/crypto/crypto', () => ({
  clearLegacyStorage: vi.fn(),
  encryptMessages: vi.fn(async messages => JSON.parse(JSON.stringify(messages))),
  isEncryptedData: vi.fn().mockReturnValue(false)
}))

let dom: JSDOM

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.sessions = []
  dom = new JSDOM('<div id="app"></div>', { url: 'https://frontend.test/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('localStorage', dom.window.localStorage)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ room_id: 'room', password_required: false })))
  localStorage.setItem('parrhesia-terms-agreement', JSON.stringify({ version: '2026-09-16' }))
})

afterEach(() => {
  const session = mocks.sessions[0]
  if (session && !session.closed) {
    session.closed = true
    session.onStatus('Disconnected from room')
  }
  dom.window.close()
  vi.unstubAllGlobals()
})

async function enterRoom(): Promise<TestConnection> {
  await import('../src/main')
  document.getElementById('create-room')!.click()
  await vi.waitFor(() => expect(mocks.sessions[0]?.connect).toHaveBeenCalled())
  const session = mocks.sessions[0]
  session.admit()
  await vi.waitFor(() => expect(document.querySelector('.chat')).not.toBeNull())
  return session
}

function messagePeers(): string[] {
  return [...document.querySelectorAll('.messages .peer')].map(peer => peer.textContent!)
}

describe('room presence display', () => {
  it('keeps notifications and message history attached to an identity across color changes and rejoins', async () => {
    const session = await enterRoom()
    const publicKey = 'returning-identity'
    storePeerKey('room', 'first', publicKey)
    markAsVerified('room', 'first', publicKey)
    session.peers.set('first', publicKey)
    session.colors.set(publicKey, 'lime')
    await session.onPeersChanged()
    await session.onPeerJoined('first', 'lime', publicKey)
    await session.onMessage('first', 'lime', 'before rejoin')
    expect(messagePeers()).toEqual(['lime', 'lime'])

    session.colors.set(publicKey, 'black')
    await session.onPeersChanged()
    expect(messagePeers()).toEqual(['black', 'black'])
    session.peers.delete('first')
    await session.onPeersChanged()
    await session.onPeerLeft('first', 'black', publicKey)
    session.peers.set('returning', publicKey)
    await session.onPeersChanged()
    await session.onPeerJoined('returning', 'black', publicKey)
    await session.onMessage('returning', 'black', 'after rejoin')

    expect(messagePeers()).toEqual(['black', 'black', 'black', 'black', 'black'])
    expect([...document.querySelectorAll('.notification .text')].map(text => text.textContent))
      .toEqual(['has joined', 'has left', 'has joined'])
    const stored = JSON.parse(localStorage.getItem('parrhesia-messages-room')!)
    expect(stored.map((message: { identityId: string }) => message.identityId)).toEqual(Array(5).fill(await fingerprintKey(publicKey)))
    expect(stored.every((message: Record<string, unknown>) => !('publicKey' in message))).toBe(true)
    expect(stored.map((message: { color: string }) => message.color)).toEqual(Array(5).fill('black'))
  })

  it('keeps a different identity unverified when it receives a previously verified color', async () => {
    const session = await enterRoom()
    storePeerKey('room', 'departed', 'verified-identity')
    markAsVerified('room', 'departed', 'verified-identity')
    const publicKey = 'different-identity'
    storePeerKey('room', 'different', publicKey)
    session.peers.set('different', publicKey)
    session.colors.set(publicKey, 'black')
    await session.onPeersChanged()
    await session.onPeerJoined('different', 'black', publicKey)
    await session.onMessage('different', 'black', 'new identity')
    expect(messagePeers()).toEqual(['unverified', 'unverified'])
    expect(document.querySelector('.peer-item')?.textContent).toBe('unverified')
  })

  it('clears typing and verification state when a connection departs or the room disconnects', async () => {
    const session = await enterRoom()
    session.peers.set('peer', 'peer-key')
    session.colors.set('peer-key', 'black')
    await session.onPeersChanged()
    session.onTyping('peer', 'black')
    document.querySelector<HTMLElement>('.peer-item')!.click()
    await vi.waitFor(() => expect(document.querySelector('.verification-panel')).not.toBeNull())
    expect(document.querySelector('.typing-indicator')).not.toBeNull()
    session.peers.delete('peer')
    await session.onPeersChanged()
    expect(document.querySelector('.typing-indicator')).toBeNull()
    expect(document.querySelector('.verification-panel')).toBeNull()

    session.peers.set('returning', 'peer-key')
    await session.onPeersChanged()
    session.onTyping('returning', 'black')
    session.closed = true
    session.onStatus('Disconnected from room')
    expect(document.querySelector('.typing-indicator')).toBeNull()
    expect(document.querySelector('.peer-item')).toBeNull()
    expect((document.getElementById('message-input') as HTMLInputElement).disabled).toBe(true)
  })
})
