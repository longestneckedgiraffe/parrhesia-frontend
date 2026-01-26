import { config } from './config'
import { GroupKeyManager, deriveColorFromPublicKey, isValidPublicKey } from './crypto'
import type { PeerColor } from './crypto'
import { checkPeerKey, storePeerKey } from './tofu'

export type MessageHandler = (peerId: string, color: PeerColor, message: string) => void
export type PeerHandler = (peerId: string, color: PeerColor, publicKey?: string) => void
export type StatusHandler = (status: string) => void
export type KeyChangeHandler = (peerId: string, color: PeerColor) => void

interface WsMessage {
  type: string
  peer_id?: string
  public_key?: string
  payload?: string
  is_creator?: boolean
  creator_id?: string
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

  constructor(
    roomId: string,
    onMessage: MessageHandler,
    onPeerJoined: PeerHandler,
    onPeerLeft: PeerHandler,
    onStatus: StatusHandler,
    onKeyChange?: KeyChangeHandler
  ) {
    this.roomId = roomId
    this.keyManager = new GroupKeyManager()
    this.onMessage = onMessage
    this.onPeerJoined = onPeerJoined
    this.onPeerLeft = onPeerLeft
    this.onStatus = onStatus
    this.onKeyChange = onKeyChange
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
        this.keyManager.setCreatorStatus(isCreator, creatorId)

        if (isCreator) {
          await this.keyManager.generateAndSetGroupKey()
          this.onStatus('Waiting for others to join')
        } else {
          this.onStatus('Waiting for encryption key')
        }

        this.send({ type: 'key_announce', public_key: publicKey })
        break

      case 'peer_key':
        if (data.peer_id && data.public_key) {
          if (!isValidPublicKey(data.public_key)) {
            console.error('Received invalid public key from peer', data.peer_id)
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

          await this.keyManager.addPeer(data.peer_id, data.public_key)
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

          await this.keyManager.addPeer(data.peer_id, data.public_key)
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
        }
        break

      case 'key_share':
        if (data.peer_id && data.payload) {
          try {
            await this.keyManager.receiveGroupKey(data.peer_id, data.payload)
            this.onStatus('Ready to chat')
          } catch (e) {
            console.error('Failed to receive group key:', e)
          }
        }
        break

      case 'message':
        if (data.peer_id && data.payload) {
          try {
            const decrypted = await this.keyManager.decryptMessage(data.payload)
            const color = this.keyManager.getPeerColor(data.peer_id)
            this.onMessage(data.peer_id, color, decrypted)
          } catch {
            console.error('Failed to decrypt message from', data.peer_id)
          }
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
      const encryptedGroupKey = await this.keyManager.encryptGroupKeyForPeer(peerId)
      this.send({ type: 'key_share', target_peer_id: peerId, payload: encryptedGroupKey })
    } catch (e) {
      console.error('Failed to send group key to peer:', e)
    }
  }

  private send(data: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.keyManager.hasGroupKey()) return
    const payload = await this.keyManager.encryptMessage(text)
    this.send({ type: 'message', payload })
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
    return this.keyManager.hasGroupKey() && this.keyManager.hasPeers()
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
