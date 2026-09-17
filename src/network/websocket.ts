import { config } from './config'
import { RoomAccessError, retryMessage } from './rooms'
import { GroupKeyManager, deriveColorFromPublicKey, isValidPublicKey } from '../crypto/crypto'
import type { PeerColor, TreeKemCommit, TreeKemWelcome } from '../crypto/crypto'
import { checkPeerKey, storePeerKey } from '../crypto/tofu'

export type MessageHandler = (peerId: string, color: PeerColor, message: string) => void
export type PeerHandler = (peerId: string, color: PeerColor, publicKey?: string) => void
export type StatusHandler = (status: string) => void
export type KeyChangeHandler = (peerId: string, color: PeerColor) => void
export type TypingHandler = (peerId: string, color: PeerColor) => void

interface WsMessage {
  type: string
  protocol_version?: number
  retry_after_secs?: number
  peer_id?: string
  public_key?: string
  pq_public_key?: string
  payload?: string
  pq_ciphertext?: string
  is_creator?: boolean
  creator_id?: string
  message_id?: string
  message_ids?: string[]
  sig?: string
  epoch?: number
  counter?: number
  tree_commit?: string
  tree_welcome?: string
}

export class ChatConnection {
  private ws: WebSocket | null = null
  private keyManager: GroupKeyManager
  private roomId: string
  private peerId: string = ''
  private onMessage: MessageHandler
  private onPeerJoined: PeerHandler
  private onPeerLeft: PeerHandler
  private onStatus: StatusHandler
  private onKeyChange?: KeyChangeHandler
  private onTyping?: TypingHandler
  private messagesSinceRekey: number = 0
  private rekeyInterval: number = 50
  private state: 'idle' | 'connecting' | 'authenticating' | 'joining' | 'joined' | 'closed' = 'idle'
  private password = ''
  private passwordRequired = false
  private publicKey = ''
  private joinResolver: (() => void) | null = null
  private joinRejecter: ((error: RoomAccessError) => void) | null = null
  private handshakeTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(
    roomId: string,
    onMessage: MessageHandler,
    onPeerJoined: PeerHandler,
    onPeerLeft: PeerHandler,
    onStatus: StatusHandler,
    onKeyChange?: KeyChangeHandler,
    onTyping?: TypingHandler
  ) {
    this.roomId = roomId
    this.keyManager = new GroupKeyManager()
    this.onMessage = onMessage
    this.onPeerJoined = onPeerJoined
    this.onPeerLeft = onPeerLeft
    this.onStatus = onStatus
    this.onKeyChange = onKeyChange
    this.onTyping = onTyping
  }

  async prepare(): Promise<CryptoKey> {
    this.publicKey = await this.keyManager.initialize()
    return this.keyManager.getMessageStorageKey()
  }

  async connect(passwordRequired = false, password = ''): Promise<void> {
    if (this.state !== 'idle') throw new RoomAccessError('Connection already started')
    this.state = 'connecting'
    this.passwordRequired = passwordRequired || password.length > 0
    this.password = password
    password = ''
    try {
      if (!this.publicKey) await this.prepare()
      if (this.isClosed()) throw new RoomAccessError('Connection cancelled')
      this.ws = new WebSocket(config.endpoints.websocket(this.roomId))
    } catch {
      this.password = ''
      this.state = 'closed'
      throw new RoomAccessError('Unable to connect to room')
    }

    const joined = new Promise<void>((resolve, reject) => {
      this.joinResolver = resolve
      this.joinRejecter = reject
    })
    this.handshakeTimeout = setTimeout(() => {
      this.fail(new RoomAccessError('Connection timed out. Please try again.'))
    }, 30000)

    let messageQueue = Promise.resolve()
    this.ws.onmessage = (event) => {
      messageQueue = messageQueue.then(async () => {
        if (this.isClosed()) return
        const data: WsMessage = JSON.parse(event.data)
        await this.handleMessage(data, this.publicKey)
      }).catch(() => {
        this.fail(new RoomAccessError('Invalid response from room server'))
      })
    }
    this.ws.onclose = () => {
      this.fail(new RoomAccessError('Disconnected from room'))
    }
    this.ws.onerror = () => {
      this.fail(new RoomAccessError('Connection failed. Please try again later.'))
    }
    return joined
  }

  private clearHandshake(): void {
    this.password = ''
    if (this.handshakeTimeout) clearTimeout(this.handshakeTimeout)
    this.handshakeTimeout = null
    this.joinResolver = null
    this.joinRejecter = null
  }

  private completeAdmission(): void {
    this.state = 'joined'
    const resolve = this.joinResolver
    this.clearHandshake()
    resolve?.()
  }

  private fail(error: RoomAccessError, reportStatus = true): void {
    if (this.isClosed()) return
    this.state = 'closed'
    const reject = this.joinRejecter
    this.clearHandshake()
    this.ws?.close()
    reject?.(error)
    if (reportStatus) this.onStatus(error.message)
  }

  private async handleMessage(data: WsMessage, publicKey: string): Promise<void> {
    if (!['auth_required', 'auth_failed', 'auth_rate_limited', 'auth_unavailable', 'welcome', 'joined', 'room_full', 'room_expired'].includes(data.type) && this.state !== 'joined') {
      throw new Error('Unexpected room message before admission')
    }
    switch (data.type) {
      case 'auth_required':
        if (this.state !== 'connecting' || data.protocol_version !== 2) {
          this.fail(new RoomAccessError('The server did not confirm password protection. Room was not joined.'))
          return
        }
        this.passwordRequired = true
        if (!this.password) {
          this.fail(new RoomAccessError('Please enter this room\'s password', 'password_required'))
          return
        }
        this.state = 'authenticating'
        this.send({ type: 'authenticate', password: this.password })
        this.password = ''
        break

      case 'auth_failed':
        this.fail(new RoomAccessError('Password was not accepted. Please try again.', 'auth_failed'))
        break

      case 'auth_rate_limited':
        this.fail(new RoomAccessError(retryMessage(data.retry_after_secs), 'auth_rate_limited'))
        break

      case 'auth_unavailable':
        this.fail(new RoomAccessError('Room access is temporarily unavailable. Please try again later.', 'auth_unavailable'))
        break

      case 'welcome':
        if (this.passwordRequired && (this.state !== 'authenticating' || data.protocol_version !== 2)) {
          this.fail(new RoomAccessError('The server did not confirm password protection. Room was not joined.'))
          return
        }
        if (!this.passwordRequired && (this.state !== 'connecting' || (data.protocol_version !== undefined && data.protocol_version !== 1))) {
          throw new Error('Unexpected welcome')
        }
        this.password = ''
        this.state = 'joining'
        this.peerId = data.peer_id || ''
        const isCreator = data.is_creator || false
        const creatorId = data.creator_id || ''
        this.keyManager.setCreatorStatus(isCreator, creatorId, this.peerId)

        if (isCreator) {
          await this.keyManager.generateAndSetGroupKey()
        }
        if (this.isClosed()) return
        this.onStatus(isCreator ? 'Waiting for others to join' : 'Waiting for encryption key')

        const pqPublicKey = this.keyManager.getMlKemPublicKeyBase64()
        if (!pqPublicKey) throw new Error('ML-KEM key pair not initialized')
        const sig = this.keyManager.signMlKemPublicKey()
        this.send({
          type: 'key_announce',
          public_key: publicKey,
          pq_public_key: pqPublicKey,
          sig: sig || undefined
        })
        // Protocol 1 has no admission acknowledgement after key announcement.
        if (!this.passwordRequired) this.completeAdmission()
        break

      case 'joined': {
        if (!this.passwordRequired || this.state !== 'joining') throw new Error('Unexpected admission')
        this.completeAdmission()
        break
      }

      case 'peer_key':
        if (data.peer_id && data.public_key) {
          if (!isValidPublicKey(data.public_key)) {
            console.error('Received invalid public key from peer', data.peer_id)
            return
          }
          if (!data.pq_public_key) {
            this.onStatus('A peer was rejected: no post-quantum key support')
            return
          }
          const keyCheck = checkPeerKey(this.roomId, data.peer_id, data.public_key)

          if (keyCheck.status === 'key_changed') {
            if (this.onKeyChange) {
              const color = await deriveColorFromPublicKey(data.public_key)
              this.onKeyChange(data.peer_id, color)
            }
            return
          }

          if (keyCheck.isNewKey) {
            storePeerKey(this.roomId, data.peer_id, data.public_key)
          }

          try {
            await this.keyManager.addPeer(data.peer_id, data.public_key, data.pq_public_key, data.sig)
          } catch (e) {
            console.error('Peer rejected:', e)
            this.onStatus('A peer was rejected: invalid signature')
            return
          }
          const color = this.keyManager.getPeerColor(data.peer_id)
          this.onPeerJoined(data.peer_id, color, data.public_key)

          if (this.keyManager.hasTreeState() && this.keyManager.shouldInitiateRekey(data.peer_id)) {
            await this.sendTreeCommit()
            await this.sendTreeWelcome(data.peer_id)
          }
        }
        break

      case 'peer_joined':
        if (data.peer_id && data.public_key) {
          if (!isValidPublicKey(data.public_key)) {
            console.error('Received invalid public key from peer', data.peer_id)
            return
          }
          if (!data.pq_public_key) {
            this.onStatus('A peer was rejected: no post-quantum key support')
            return
          }
          const keyCheck2 = checkPeerKey(this.roomId, data.peer_id, data.public_key)

          if (keyCheck2.status === 'key_changed') {
            if (this.onKeyChange) {
              const color = await deriveColorFromPublicKey(data.public_key)
              this.onKeyChange(data.peer_id, color)
            }
            return
          }

          if (keyCheck2.isNewKey) {
            storePeerKey(this.roomId, data.peer_id, data.public_key)
          }

          try {
            await this.keyManager.addPeer(data.peer_id, data.public_key, data.pq_public_key, data.sig)
          } catch (e) {
            console.error('Peer rejected:', e)
            this.onStatus('A peer was rejected: invalid signature')
            return
          }
          const color = this.keyManager.getPeerColor(data.peer_id)
          this.onPeerJoined(data.peer_id, color, data.public_key)

          if (this.keyManager.hasTreeState() && this.keyManager.shouldInitiateRekey(data.peer_id)) {
            await this.sendTreeCommit()
            await this.sendTreeWelcome(data.peer_id)
          }
        }
        break

      case 'peer_left':
        if (data.peer_id) {
          const color = this.keyManager.getPeerColor(data.peer_id)
          const publicKey = this.keyManager.getPeerPublicKey(data.peer_id)
          this.keyManager.removePeer(data.peer_id)
          this.onPeerLeft(data.peer_id, color, publicKey)
          if (this.keyManager.shouldInitiateRekey() && this.keyManager.hasPeers()) {
            await this.sendTreeCommit()
          }
        }
        break

      case 'tree_welcome':
        if (data.tree_welcome) {
          try {
            const welcome: TreeKemWelcome = JSON.parse(data.tree_welcome)
            await this.keyManager.receiveWelcome(welcome)
            this.onStatus('Ready to chat')
          } catch (e) {
            console.error('Failed to receive tree welcome:', e)
            this.onStatus('Failed to receive encryption key')
          }
        }
        break

      case 'tree_commit':
        if (data.tree_commit) {
          try {
            const commit: TreeKemCommit = JSON.parse(data.tree_commit)
            await this.keyManager.receiveCommit(commit)
            this.messagesSinceRekey = 0
            this.onStatus('Encryption key rotated')
          } catch (e) {
            console.error('Failed to process tree commit:', e)
          }
        }
        break

      case 'message':
        if (data.peer_id && data.payload) {
          try {
            const decrypted = await this.keyManager.decryptMessage(data.peer_id, data.payload, data.epoch ?? 0, data.counter ?? 0)
            const color = this.keyManager.getPeerColor(data.peer_id)
            this.onMessage(data.peer_id, color, decrypted)
          } catch {
            console.error('Failed to decrypt message from', data.peer_id)
          }
        }
        break

      case 'typing':
        if (data.peer_id && this.onTyping) {
          const color = this.keyManager.getPeerColor(data.peer_id)
          this.onTyping(data.peer_id, color)
        }
        break

      case 'room_expired':
        this.fail(new RoomAccessError('This room has expired'))
        break

      case 'room_full':
        this.fail(new RoomAccessError('This room is full'))
        break
    }
  }

  private async sendTreeWelcome(peerId: string): Promise<void> {
    try {
      const welcome = await this.keyManager.generateWelcomeForPeer(peerId)
      this.send({
        type: 'tree_welcome',
        target_peer_id: peerId,
        tree_welcome: JSON.stringify(welcome)
      })
    } catch (e) {
      console.error('Failed to send tree welcome:', e)
    }
  }

  private async sendTreeCommit(): Promise<void> {
    try {
      const commit = await this.keyManager.initiateRekey()
      this.send({
        type: 'tree_commit',
        tree_commit: JSON.stringify(commit)
      })
      this.messagesSinceRekey = 0
    } catch (e) {
      console.error('Failed to send tree commit:', e)
    }
  }

  private send(data: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.canSend()) return
    const { payload, epoch, counter } = await this.keyManager.encryptMessage(text)
    this.send({ type: 'message', payload, epoch, counter })
    this.messagesSinceRekey++
    if (this.messagesSinceRekey >= this.rekeyInterval && this.keyManager.shouldInitiateRekey() && this.keyManager.hasPeers()) {
      await this.sendTreeCommit()
    }
  }

  sendTyping(): void {
    if (!this.canSend()) return
    this.send({ type: 'typing' })
  }

  disconnect(): void {
    this.fail(new RoomAccessError('Connection cancelled'), false)
    this.ws = null
  }

  isClosed(): boolean {
    return this.state === 'closed'
  }

  getPeerId(): string {
    return this.peerId
  }

  getPeerCount(): number {
    return this.keyManager.getPeerIds().length
  }

  canSend(): boolean {
    return this.state === 'joined' && this.ws?.readyState === WebSocket.OPEN && this.keyManager.hasChain() && this.keyManager.hasPeers()
  }

  getMyColor(): PeerColor {
    return this.keyManager.getMyColor()
  }


  getMyPublicKey(): string {
    return this.keyManager.getMyPublicKey()
  }

  async getMessageStorageKey(): Promise<CryptoKey> {
    return this.keyManager.getMessageStorageKey()
  }

  getPeerPublicKey(peerId: string): string | undefined {
    return this.keyManager.getPeerPublicKey(peerId)
  }

  getPeerColor(peerId: string): PeerColor {
    return this.keyManager.getPeerColor(peerId)
  }

  getPeerIds(): string[] {
    return this.keyManager.getPeerIds()
  }

  getRoomId(): string {
    return this.roomId
  }

}
