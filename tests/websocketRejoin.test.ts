import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatConnection } from '../src/network/websocket'
import { resetStorage } from './helpers'

interface Frame {
  type: string
  [key: string]: unknown
}

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = Socket.OPEN
  sent: Frame[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  processed: (() => void) | null = null
  interrupted: ((error: Error) => void) | null = null

  constructor() {
    Socket.instances.push(this)
  }

  send(message: string): void {
    this.sent.push(JSON.parse(message))
  }

  close(): void {
    this.readyState = 3
    this.interrupted?.(new Error('Socket closed while processing membership'))
    this.onclose?.()
  }

  receive(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  async deliver(frame: Frame): Promise<void> {
    const processed = new Promise<void>((resolve, reject) => {
      this.processed = resolve
      this.interrupted = reject
    })
    this.receive(frame)
    this.receive({ type: 'typing', peer_id: 'processed' })
    try {
      await processed
    } finally {
      this.processed = null
      this.interrupted = null
    }
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
  let socket: Socket
  const connection = new ChatConnection('room', onMessage, vi.fn(), vi.fn(), onStatus, undefined, peerId => {
    if (peerId === 'processed') socket.processed?.()
  })
  connections.push(connection)
  await connection.prepare()
  const connected = connection.connect()
  socket = Socket.instances.at(-1)!
  socket.receive({ type: 'welcome', peer_id: id, is_creator: creator, creator_id: 'a' })
  await connected
  const announcement = socket.sent.find(frame => frame.type === 'key_announce')!
  const peerKey = { ...announcement, type: 'peer_key', peer_id: id }
  const peerJoined = { ...peerKey, type: 'peer_joined' }
  return { connection, socket, onMessage, onStatus, peerKey, peerJoined }
}

describe('WebSocket room rejoin', () => {
  it('keeps both remaining clients connected and exchanging messages after overlapping sockets leave', async () => {
    const a = await start('a', true)
    await resetStorage()
    const b = await start('b', false)
    await b.socket.deliver(a.peerKey)
    await a.socket.deliver(b.peerJoined)
    await b.socket.deliver(a.socket.sent.find(frame => frame.type === 'tree_welcome')!)
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

    await a.socket.deliver({ type: 'peer_left', peer_id: 'b' })
    await c.socket.deliver({ type: 'peer_left', peer_id: 'b' })
    await c.socket.deliver({ ...a.socket.sent.filter(frame => frame.type === 'tree_commit').at(-1)!, peer_id: 'a' })
    expect(a.connection.isClosed()).toBe(false)
    expect(c.connection.isClosed()).toBe(false)
    expect(a.connection.canSend()).toBe(true)
    expect(c.connection.canSend()).toBe(true)

    await a.connection.sendMessage('after rejoin from a')
    await c.socket.deliver({ ...a.socket.sent.at(-1)!, peer_id: 'a' })
    expect(c.onMessage).toHaveBeenCalledWith('a', a.connection.getMyColor(), 'after rejoin from a')
    await c.connection.sendMessage('after rejoin from c')
    await a.socket.deliver({ ...c.socket.sent.at(-1)!, peer_id: 'c' })
    expect(a.onMessage).toHaveBeenCalledWith('c', c.connection.getMyColor(), 'after rejoin from c')

    const frameCount = a.socket.sent.length
    await a.socket.deliver(c.peerJoined)
    expect(a.socket.sent).toHaveLength(frameCount)
    await c.connection.sendMessage('after duplicate announcement')
    await a.socket.deliver({ ...c.socket.sent.at(-1)!, peer_id: 'c' })
    expect(a.onMessage).toHaveBeenLastCalledWith('c', c.connection.getMyColor(), 'after duplicate announcement')
  })
})
