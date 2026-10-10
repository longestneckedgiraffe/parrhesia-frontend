import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatConnection } from '../src/network/websocket'
import { GroupKeyManager } from '../src/crypto/crypto'
import { resetStorage } from './helpers'
import { getStoredPeerKey, markAsVerified } from '../src/crypto/tofu'

interface Frame {
  type: string
  [key: string]: unknown
}

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = Socket.OPEN
  sent: Frame[] = []
  onmessage: ((event: { data: string }) => void | Promise<void>) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    Socket.instances.push(this)
  }

  send(message: string): void {
    this.sent.push(JSON.parse(message))
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  receive(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  async deliver(frame: Frame): Promise<void> {
    await this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const connections: ChatConnection[] = []

beforeEach(async () => {
  await resetStorage()
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
})

afterEach(() => {
  connections.splice(0).forEach(connection => connection.disconnect())
  vi.unstubAllGlobals()
})

async function start(id: string, creator: boolean) {
  const onMessage = vi.fn()
  const onStatus = vi.fn()
  const onPeerJoined = vi.fn()
  const onPeerLeft = vi.fn()
  const onTyping = vi.fn()
  const onPeersChanged = vi.fn()
  const connection = new ChatConnection('room', onMessage, onPeerJoined, onPeerLeft, onStatus, undefined, onTyping, onPeersChanged)
  connections.push(connection)
  await connection.prepare()
  const connected = connection.connect()
  const socket = Socket.instances.at(-1)!
  socket.receive({ type: 'welcome', peer_id: id, is_creator: creator, creator_id: 'a' })
  await connected
  const announcement = socket.sent.find(frame => frame.type === 'key_announce')!
  const peerKey = { ...announcement, type: 'peer_key', peer_id: id }
  const peerJoined = { ...peerKey, type: 'peer_joined' }
  return { connection, socket, onMessage, onStatus, onPeerJoined, onPeerLeft, onTyping, onPeersChanged, peerKey, peerJoined }
}

describe('WebSocket room rejoin', () => {
  it('keeps both remaining clients connected and exchanging messages after overlapping sockets leave', async () => {
    const a = await start('a', true)
    await resetStorage()
    const b = await start('b', false)
    await b.socket.deliver(a.peerKey)
    await a.socket.deliver(b.peerJoined)
    await b.socket.deliver(a.socket.sent.find(frame => frame.type === 'tree_welcome')!)
    const originalColor = a.connection.getPeerColor('b')
    expect(a.onPeerJoined).toHaveBeenCalledExactlyOnceWith('b', originalColor, b.connection.getMyPublicKey())
    expect(a.connection.canSend()).toBe(true)
    expect(b.connection.canSend()).toBe(true)

    b.connection.disconnect()
    const c = await start('c', false)
    expect(c.connection.getMyPublicKey()).toBe(b.connection.getMyPublicKey())
    await c.socket.deliver(a.peerKey)
    await c.socket.deliver(b.peerKey)
    await a.socket.deliver(c.peerJoined)
    await c.socket.deliver(a.socket.sent.find(frame => frame.type === 'tree_welcome' && frame.target_peer_id === 'c')!)
    expect(a.connection.getPeerColor('c')).toBe(c.connection.getMyColor())
    expect(a.connection.getPeerColor('c')).toBe(originalColor)
    expect(a.connection.getPeerColor('b')).toBe(originalColor)
    expect(a.connection.getPeerCount()).toBe(1)
    expect(c.connection.getPeerIds()).toEqual(['a'])
    expect(a.onPeerJoined).toHaveBeenCalledTimes(1)
    expect(c.onPeerJoined).not.toHaveBeenCalled()

    await a.socket.deliver({ type: 'peer_left', peer_id: 'b' })
    await c.socket.deliver({ type: 'peer_left', peer_id: 'b' })
    await c.socket.deliver({ ...a.socket.sent.filter(frame => frame.type === 'tree_commit').at(-1)!, peer_id: 'a' })
    expect(a.connection.isClosed()).toBe(false)
    expect(c.connection.isClosed()).toBe(false)
    expect(a.connection.canSend()).toBe(true)
    expect(c.connection.canSend()).toBe(true)
    expect(a.onPeerLeft).not.toHaveBeenCalled()
    expect(c.onPeerLeft).not.toHaveBeenCalled()
    expect(a.connection.getPeerColor('c')).toBe(originalColor)

    await a.connection.sendMessage('after rejoin from a')
    await c.socket.deliver({ ...a.socket.sent.at(-1)!, peer_id: 'a' })
    expect(c.onMessage).toHaveBeenCalledWith('a', a.connection.getMyColor(), 'after rejoin from a')
    await c.connection.sendMessage('after rejoin from c')
    await a.socket.deliver({ ...c.socket.sent.at(-1)!, peer_id: 'c' })
    expect(a.onMessage).toHaveBeenCalledWith('c', c.connection.getMyColor(), 'after rejoin from c')

    const frameCount = a.socket.sent.length
    await a.socket.deliver(c.peerJoined)
    expect(a.socket.sent).toHaveLength(frameCount)
    expect(a.onPeerJoined).toHaveBeenCalledTimes(1)
    await c.connection.sendMessage('after duplicate announcement')
    await a.socket.deliver({ ...c.socket.sent.at(-1)!, peer_id: 'c' })
    expect(a.onMessage).toHaveBeenLastCalledWith('c', c.connection.getMyColor(), 'after duplicate announcement')

    await a.socket.deliver({ type: 'peer_left', peer_id: 'c' })
    expect(a.onPeerLeft).toHaveBeenCalledExactlyOnceWith('c', originalColor, c.connection.getMyPublicKey())
    expect(a.connection.getPeerCount()).toBe(0)
    expect(a.connection.canSend()).toBe(false)
    const finalFrameCount = a.socket.sent.length
    await a.socket.deliver({ type: 'peer_left', peer_id: 'c' })
    await a.socket.deliver({ type: 'peer_left', peer_id: 'unknown' })
    await a.socket.deliver({ type: 'typing', peer_id: 'c' })
    expect(a.onPeerLeft).toHaveBeenCalledTimes(1)
    expect(a.onTyping).not.toHaveBeenCalled()
    expect(a.socket.sent).toHaveLength(finalFrameCount)
  })

  it('preserves the identity color across a complete departure and a new snapshot', async () => {
    const a = await start('a', true)
    await resetStorage()
    const b = await start('b', false)
    await b.socket.deliver({ type: 'peer_snapshot', peers: [a.peerKey] })
    await a.socket.deliver(b.peerJoined)
    await b.socket.deliver(a.socket.sent.find(frame => frame.type === 'tree_welcome')!)
    const color = a.connection.getPeerColor('b')
    markAsVerified('room', 'b', b.connection.getMyPublicKey())
    b.connection.disconnect()
    await a.socket.deliver({ type: 'peer_left', peer_id: 'b' })
    expect(a.onPeerLeft).toHaveBeenCalledExactlyOnceWith('b', color, b.connection.getMyPublicKey())

    const c = await start('c', false)
    await c.socket.deliver({ type: 'peer_snapshot', peers: [a.peerKey] })
    await a.socket.deliver(c.peerJoined)
    await c.socket.deliver(a.socket.sent.find(frame => frame.type === 'tree_welcome' && frame.target_peer_id === 'c')!)
    expect(a.onPeerJoined).toHaveBeenLastCalledWith('c', color, b.connection.getMyPublicKey())
    expect(a.onPeerJoined).toHaveBeenCalledTimes(2)
    expect(c.onPeerJoined).not.toHaveBeenCalled()
    expect(a.connection.getPeerColor('c')).toBe(c.connection.getMyColor())
    expect(getStoredPeerKey('room', 'c', c.connection.getMyPublicKey())?.status).toBe('verified')
    await c.connection.sendMessage('same identity after leaving')
    await a.socket.deliver({ ...c.socket.sent.at(-1)!, peer_id: 'c' })
    expect(a.onMessage).toHaveBeenLastCalledWith('c', color, 'same identity after leaving')
  })

  it('publishes one settled peer list for a snapshot containing overlapping identities', async () => {
    const a = await start('a', true)
    await resetStorage()
    const b = await start('b', false)
    const c = await start('c', false)
    await resetStorage()
    const d = await start('d', false)
    await d.socket.deliver({ type: 'peer_snapshot', peers: [c.peerKey, a.peerKey, b.peerKey] })
    expect(d.connection.getPeerIds()).toEqual(['a', 'b'])
    expect(d.connection.getPeerColor('b')).toBe(d.connection.getPeerColor('c'))
    expect(d.onPeerJoined).not.toHaveBeenCalled()
    expect(d.onPeersChanged).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, 'invalid-signature'])('rejects an unsigned or forged identity without storing it (%s)', async sig => {
    const a = await start('a', true)
    await resetStorage()
    const b = await start('b', false)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await a.socket.deliver({ ...b.peerJoined, sig })
      expect(a.connection.getPeerCount()).toBe(0)
      expect(a.onPeerJoined).not.toHaveBeenCalled()
      expect(a.onPeersChanged).not.toHaveBeenCalled()
      expect(getStoredPeerKey('room', 'b', b.connection.getMyPublicKey())).toBeNull()
      await a.socket.deliver({ type: 'peer_left', peer_id: 'b' })
      expect(a.onPeerLeft).not.toHaveBeenCalled()
      await a.socket.deliver(b.peerJoined)
      expect(a.connection.getPeerCount()).toBe(1)
      expect(a.onPeerJoined).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
  })

  it('keeps a forged reconnect from changing a verified identity record', async () => {
    const a = await start('a', true)
    await resetStorage()
    const b = await start('b', false)
    await a.socket.deliver(b.peerJoined)
    const publicKey = b.connection.getMyPublicKey()
    markAsVerified('room', 'b', publicKey)
    const stored = getStoredPeerKey('room', 'b', publicKey)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await a.socket.deliver({ ...b.peerJoined, peer_id: 'forged', pq_public_key: a.peerKey.pq_public_key })
      expect(getStoredPeerKey('room', 'b', publicKey)).toEqual(stored)
      expect(a.connection.getPeerCount()).toBe(1)
      expect(a.onPeerJoined).toHaveBeenCalledTimes(1)
      await a.socket.deliver({ type: 'peer_left', peer_id: 'forged' })
      expect(a.onPeerLeft).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('rejects duplicate connection IDs in a snapshot before admitting any peers', async () => {
    const a = await start('a', true)
    await resetStorage()
    const b = await start('b', false)
    await a.socket.deliver({ type: 'peer_snapshot', peers: [b.peerKey, b.peerKey] })
    expect(a.connection.isClosed()).toBe(true)
    expect(a.connection.getPeerCount()).toBe(0)
    expect(a.onPeerJoined).not.toHaveBeenCalled()
    expect(getStoredPeerKey('room', 'b', b.connection.getMyPublicKey())).toBeNull()
  })

  it('keeps disconnection final when a tree welcome is still being processed', async () => {
    const a = await start('a', true)
    await resetStorage()
    const b = await start('b', false)
    await b.socket.deliver({ type: 'peer_snapshot', peers: [a.peerKey] })
    await a.socket.deliver(b.peerJoined)
    let finish = () => {}
    const welcome = vi.spyOn(GroupKeyManager.prototype, 'receiveWelcome')
      .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    try {
      const delivering = b.socket.deliver(a.socket.sent.find(frame => frame.type === 'tree_welcome')!)
      await vi.waitFor(() => expect(welcome).toHaveBeenCalledTimes(1))
      b.socket.close()
      finish()
      await delivering
      expect(b.onStatus).toHaveBeenLastCalledWith('Disconnected from room')
      expect(b.onStatus).not.toHaveBeenCalledWith('Ready to chat')
      expect(b.connection.getPeerIds()).toEqual([])
      expect(b.connection.getPeerCount()).toBe(0)
      expect(b.connection.canSend()).toBe(false)
    } finally {
      welcome.mockRestore()
    }
  })
})
