import { config } from './config'
import { GroupKeyManager, deriveColorFromPublicKey, isValidPublicKey } from './crypto'
import type { PeerColor } from './crypto'
import { checkPeerKey, storePeerKey } from './tofu'

export type MessageHandler = (peerId: string, color: PeerColor, message: string, messageId?: string) => void
export type PeerHandler = (peerId: string, color: PeerColor, publicKey?: string) => void
export type StatusHandler = (status: string) => void
export type KeyChangeHandler = (peerId: string, color: PeerColor) => void
export type TypingHandler = (peerId: string, color: PeerColor) => void
export type ReadHandler = (messageIds: string[], peerId: string) => void

interface WsMessage {
  type: string
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
  private onRead?: ReadHandler
  private messagesSinceRekey: number = 0
  private rekeyInterval: number = 50

  constructor(
    roomId: string,
    onMessage: MessageHandler,
    onPeerJoined: PeerHandler,
    onPeerLeft: PeerHandler,
    onStatus: StatusHandler,
    onKeyChange?: KeyChangeHandler,
    onTyping?: TypingHandler,
    onRead?: ReadHandler
  ) {
    this.roomId = roomId
    this.keyManager = new GroupKeyManager()
    this.onMessage = onMessage
    this.onPeerJoined = onPeerJoined
    this.onPeerLeft = onPeerLeft
    this.onStatus = onStatus
    this.onKeyChange = onKeyChange
    this.onTyping = onTyping
    this.onRead = onRead
  }

  async connect(password?: string): Promise<void> {
    const publicKey = await this.keyManager.initialize(password)
    const wsUrl = config.endpoints.websocket(this.roomId)
    this.ws = new WebSocket(wsUrl)

    this.ws.onmessage = async (event) => {
      const data: WsMessage = JSON.parse(event.data)
      await this.handleMessage(data, publicKey)
    }

    this.ws.onclose = () => {
      this.onStatus('Disconnected from room')
    }

    this.ws.onerror = () => {
      this.onStatus('Connection failed')
    }
  }

  private async handleMessage(data: WsMessage, publicKey: string): Promise<void> {
    switch (data.type) {
      case 'welcome':
        this.peerId = data.peer_id || ''
        const isCreator = data.is_creator || false
        const creatorId = data.creator_id || ''
        this.keyManager.setCreatorStatus(isCreator, creatorId, this.peerId)

        if (isCreator) {
          await this.keyManager.generateAndSetGroupKey()
          this.onStatus('Waiting for others to join')
        } else {
          this.onStatus('Waiting for encryption key')
        }

        const pqPublicKey = this.keyManager.getMlKemPublicKeyBase64()
        if (!pqPublicKey) throw new Error('ML-KEM key pair not initialized')
        const sig = this.keyManager.signMlKemPublicKey()
        this.send({
          type: 'key_announce',
          public_key: publicKey,
          pq_public_key: pqPublicKey,
          sig: sig || undefined
        })
        break

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

          if (this.keyManager.hasGroupKey()) {
            await this.sendGroupKeyToPeer(data.peer_id)
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

          if (this.keyManager.hasGroupKey()) {
            await this.sendGroupKeyToPeer(data.peer_id)
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
            await this.sendRekey()
          }
        }
        break

      case 'key_share':
        if (data.peer_id && data.payload && data.pq_ciphertext) {
          try {
            await this.keyManager.receiveGroupKey(data.peer_id, data.payload, data.pq_ciphertext, data.sig, data.epoch)
            this.onStatus('Ready to chat')
          } catch (e) {
            console.error('Failed to receive group key:', e)
            this.onStatus('Failed to receive encryption key')
          }
        } else if (data.peer_id && data.payload && !data.pq_ciphertext) {
          this.onStatus('Rejected key share: no post-quantum ciphertext')
        }
        break

      case 'rekey':
        if (data.peer_id && data.payload && data.pq_ciphertext) {
          try {
            this.keyManager.savePreviousEpochChains()
            await this.keyManager.receiveGroupKey(data.peer_id, data.payload, data.pq_ciphertext, data.sig, data.epoch)
            this.messagesSinceRekey = 0
            this.onStatus('Encryption key rotated')
          } catch (e) {
            console.error('Failed to process rekey:', e)
          }
        }
        break

      case 'message':
        if (data.peer_id && data.payload) {
          try {
            const decrypted = await this.keyManager.decryptMessage(data.peer_id, data.payload, data.epoch ?? 0, data.counter ?? 0)
            const color = this.keyManager.getPeerColor(data.peer_id)
            this.onMessage(data.peer_id, color, decrypted, data.message_id)
          } catch {
            console.error('Failed to decrypt message from', data.peer_id)
          }
        }
        break

      case 'read':
        if (data.peer_id && data.message_ids && this.onRead) {
          this.onRead(data.message_ids, data.peer_id)
        }
        break

      case 'typing':
        if (data.peer_id && this.onTyping) {
          const color = this.keyManager.getPeerColor(data.peer_id)
          this.onTyping(data.peer_id, color)
        }
        break

      case 'room_expired':
        this.onStatus('This room has expired')
        break

      case 'room_full':
        this.onStatus('This room is full')
        break
    }
  }

  private async sendGroupKeyToPeer(peerId: string): Promise<void> {
    try {
      const { encrypted_group_key, pq_ciphertext, sig } = await this.keyManager.encryptGroupKeyForPeer(peerId)
      this.send({
        type: 'key_share',
        target_peer_id: peerId,
        payload: encrypted_group_key,
        pq_ciphertext,
        sig,
        epoch: this.keyManager.getEpoch()
      })
    } catch (e) {
      console.error('Failed to send group key to peer:', e)
    }
  }

  private async sendRekey(): Promise<void> {
    try {
      await this.keyManager.initiateRekey()
      for (const peerId of this.keyManager.getPeerIds()) {
        const { encrypted_group_key, pq_ciphertext, sig } = await this.keyManager.encryptGroupKeyForPeer(peerId)
        this.send({
          type: 'rekey',
          target_peer_id: peerId,
          payload: encrypted_group_key,
          pq_ciphertext,
          sig,
          epoch: this.keyManager.getEpoch()
        })
      }
      this.messagesSinceRekey = 0
    } catch (e) {
      console.error('Failed to send rekey:', e)
    }
  }

  private send(data: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  async sendMessage(text: string, messageId?: string): Promise<void> {
    if (!this.keyManager.hasChain()) return
    const { payload, epoch, counter } = await this.keyManager.encryptMessage(text)
    this.send({ type: 'message', payload, message_id: messageId, epoch, counter })
    this.messagesSinceRekey++
    if (this.messagesSinceRekey >= this.rekeyInterval && this.keyManager.shouldInitiateRekey() && this.keyManager.hasPeers()) {
      await this.sendRekey()
    }
  }

  sendTyping(): void {
    this.send({ type: 'typing' })
  }

  sendRead(messageIds: string[]): void {
    if (messageIds.length > 0) {
      this.send({ type: 'read', message_ids: messageIds })
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  getPeerId(): string {
    return this.peerId
  }

  getPeerCount(): number {
    return this.keyManager.getPeerIds().length
  }

  canSend(): boolean {
    return this.keyManager.hasChain() && this.keyManager.hasPeers()
  }

  getMyColor(): PeerColor {
    return this.keyManager.getMyColor()
  }


  getMyPublicKey(): string {
    return this.keyManager.getMyPublicKey()
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

export async function createRoom(): Promise<string> {
  const response = await fetch(config.endpoints.createRoom, { method: 'POST' })
  const data = await response.json()
  return data.room_id
}

export async function checkRoom(roomId: string): Promise<boolean> {
  try {
    const response = await fetch(config.endpoints.checkRoom(roomId))
    if (!response.ok) return false
    const data = await response.json()
    return data.exists === true
  } catch {
    return false
  }
}
