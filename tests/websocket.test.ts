import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatConnection } from '../src/network/websocket'

const keys = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue('signing-key'),
  getMessageStorageKey: vi.fn().mockResolvedValue({}),
  setCreatorStatus: vi.fn(),
  generateAndSetGroupKey: vi.fn().mockResolvedValue(undefined),
  getMlKemPublicKeyBase64: vi.fn().mockReturnValue('kem-key'),
  signMlKemPublicKey: vi.fn().mockReturnValue('signature'),
  hasChain: vi.fn().mockReturnValue(true),
  hasPeers: vi.fn().mockReturnValue(true)
}))

vi.mock('../src/crypto/crypto', () => ({
  GroupKeyManager: class { constructor() { return keys } },
  deriveColorFromPublicKey: vi.fn(),
  isValidPublicKey: vi.fn()
}))

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1
  sent: Record<string, unknown>[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  url: string

  constructor(url: string) {
    this.url = url
    Socket.instances.push(this)
  }

  send(message: string): void {
    this.sent.push(JSON.parse(message))
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  async receive(data: object): Promise<void> {
    this.onmessage?.({ data: JSON.stringify(data) })
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
}

const connections: ChatConnection[] = []

beforeEach(() => {
  vi.clearAllMocks()
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
})

afterEach(() => {
  connections.splice(0).forEach(connection => connection.disconnect())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function start(passwordRequired = true, password = 'café telescopes drift slowly') {
  const onStatus = vi.fn()
  const onMessage = vi.fn()
  const connection = new ChatConnection('room', onMessage, vi.fn(), vi.fn(), onStatus)
  connections.push(connection)
  await connection.prepare()
  let admitted = false
  const result = connection.connect(passwordRequired, password).then(() => {
    admitted = true
    return null
  }, error => error)
  return { connection, socket: Socket.instances[0], onStatus, onMessage, result, admitted: () => admitted }
}

describe('WebSocket admission', () => {
  it('waits for authentication and joined before enabling messages', async () => {
    const session = await start()
    expect(session.connection.canSend()).toBe(false)
    session.connection.sendTyping()
    expect(session.socket.sent).toEqual([])
    await session.socket.receive({ type: 'auth_required', protocol_version: 2 })
    expect(session.socket.sent).toEqual([{ type: 'authenticate', password: 'café telescopes drift slowly' }])
    expect(session.admitted()).toBe(false)
    await session.socket.receive({ type: 'welcome', protocol_version: 2, peer_id: 'me', is_creator: true })
    expect(session.socket.sent[1]).toEqual({ type: 'key_announce', public_key: 'signing-key', pq_public_key: 'kem-key', sig: 'signature' })
    expect(session.admitted()).toBe(false)
    expect(session.connection.canSend()).toBe(false)
    await session.socket.receive({ type: 'joined' })
    expect(await session.result).toBeNull()
    expect(session.connection.canSend()).toBe(true)
    session.socket.close()
    expect(session.connection.canSend()).toBe(false)
  })

  it('retains the version-1 handshake for open rooms', async () => {
    const session = await start(false, '')
    await session.socket.receive({ type: 'welcome', protocol_version: 1, peer_id: 'me' })
    await session.socket.receive({ type: 'joined' })
    expect(await session.result).toBeNull()
    expect(session.socket.sent.map(frame => frame.type)).toEqual(['key_announce'])
  })

  it.each([1, undefined])('refuses a protected welcome without authentication (version %s)', async protocol_version => {
    const session = await start()
    await session.socket.receive({ type: 'welcome', protocol_version, peer_id: 'me' })
    expect((await session.result).message).toContain('did not confirm password protection')
    expect(session.socket.sent).toEqual([])
    expect(keys.setCreatorStatus).not.toHaveBeenCalled()
  })

  it('refuses a downgrade after sending the authentication frame', async () => {
    const session = await start()
    await session.socket.receive({ type: 'auth_required', protocol_version: 2 })
    await session.socket.receive({ type: 'welcome', protocol_version: 1 })
    expect((await session.result).message).toContain('did not confirm password protection')
    expect(session.socket.sent).toHaveLength(1)
  })

  it('requests a password without sending empty credentials if metadata missed protection', async () => {
    const session = await start(false, '')
    await session.socket.receive({ type: 'auth_required', protocol_version: 2 })
    expect((await session.result).code).toBe('password_required')
    expect(session.socket.sent).toEqual([])
  })

  it.each([
    ['auth_failed', 'Password was not accepted'],
    ['auth_rate_limited', '7 seconds'],
    ['auth_unavailable', 'temporarily unavailable'],
    ['room_full', 'room is full'],
    ['room_expired', 'room has expired']
  ])('preserves %s when the socket closes', async (type, message) => {
    const session = await start()
    await session.socket.receive({ type: 'auth_required', protocol_version: 2 })
    await session.socket.receive({ type, retry_after_secs: 7 })
    session.socket.close()
    expect((await session.result).message).toContain(message)
    expect(session.onStatus).toHaveBeenCalledTimes(1)
    expect(session.onStatus.mock.calls[0][0]).toContain(message)
    expect(session.connection.isClosed()).toBe(true)
  })

  it.each(['joined', 'message', 'peer_key'])('rejects %s before admission', async type => {
    const session = await start()
    await session.socket.receive({ type, peer_id: 'other', payload: 'secret' })
    expect((await session.result).message).toContain('Invalid response')
    expect(session.onMessage).not.toHaveBeenCalled()
  })

  it('never submits the password twice on one socket', async () => {
    const session = await start()
    await session.socket.receive({ type: 'auth_required', protocol_version: 2 })
    await session.socket.receive({ type: 'auth_required', protocol_version: 2 })
    expect(await session.result).toBeInstanceOf(Error)
    expect(session.socket.sent).toHaveLength(1)
  })

  it('times out and cancels incomplete admission', async () => {
    vi.useFakeTimers()
    const session = await start()
    await vi.advanceTimersByTimeAsync(30000)
    expect((await session.result).message).toContain('timed out')
    expect(session.socket.readyState).toBe(3)
  })

  it('keeps a disconnect final while key initialization is still running', async () => {
    let finish = () => {}
    keys.generateAndSetGroupKey.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const session = await start(false, '')
    await session.socket.receive({ type: 'welcome', protocol_version: 1, peer_id: 'me', is_creator: true })
    session.socket.close()
    finish()
    expect((await session.result).message).toBe('Disconnected from room')
    await Promise.resolve()
    expect(session.onStatus).toHaveBeenCalledExactlyOnceWith('Disconnected from room')
    expect(session.socket.sent).toEqual([])
  })
})
