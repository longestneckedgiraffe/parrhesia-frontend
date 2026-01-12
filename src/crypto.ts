export interface KeyPair {
  publicKey: CryptoKey
  privateKey: CryptoKey
}

export const PEER_COLORS = ['red', 'orange', 'green', 'blue', 'purple', 'pink'] as const
export type PeerColor = typeof PEER_COLORS[number]

export function getOrAssignMyColor(): PeerColor {
  const stored = localStorage.getItem('parrhesia-color')
  if (stored && PEER_COLORS.includes(stored as PeerColor)) {
    return stored as PeerColor
  }
  const color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)]
  localStorage.setItem('parrhesia-color', color)
  return color
}

export function encodeKeyWithColor(publicKey: string, color: PeerColor): string {
  return `${color}:${publicKey}`
}

export function decodeKeyWithColor(encoded: string): { color: PeerColor; publicKey: string } {
  const colonIndex = encoded.indexOf(':')
  if (colonIndex === -1) {
    return { color: 'blue', publicKey: encoded }
  }
  const color = encoded.slice(0, colonIndex) as PeerColor
  const publicKey = encoded.slice(colonIndex + 1)
  if (!PEER_COLORS.includes(color)) {
    return { color: 'blue', publicKey: encoded }
  }
  return { color, publicKey }
}

const ECDH_PARAMS: EcKeyGenParams = {
  name: 'ECDH',
  namedCurve: 'P-256'
}

const AES_PARAMS = {
  name: 'AES-GCM',
  length: 256
}

export async function generateKeyPair(): Promise<KeyPair> {
  const keyPair = await crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey'])
  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey
  }
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('raw', key)
  return btoa(String.fromCharCode(...new Uint8Array(exported)))
}

export async function importPublicKey(base64Key: string): Promise<CryptoKey> {
  const binaryString = atob(base64Key)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return crypto.subtle.importKey('raw', bytes, ECDH_PARAMS, true, [])
}

export async function generateGroupKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(AES_PARAMS, true, ['encrypt', 'decrypt'])
}

export async function exportGroupKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('raw', key)
  return btoa(String.fromCharCode(...new Uint8Array(exported)))
}

export async function importGroupKey(base64Key: string): Promise<CryptoKey> {
  const binaryString = atob(base64Key)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return crypto.subtle.importKey('raw', bytes, AES_PARAMS, true, ['encrypt', 'decrypt'])
}

export async function deriveSharedKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    AES_PARAMS,
    false,
    ['encrypt', 'decrypt']
  )
}

export async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  )
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

export async function decrypt(key: CryptoKey, encryptedBase64: string): Promise<string> {
  const binaryString = atob(encryptedBase64)
  const combined = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    combined[i] = binaryString.charCodeAt(i)
  }
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  )
  return new TextDecoder().decode(decrypted)
}

export class GroupKeyManager {
  private keyPair: KeyPair | null = null
  private peerSharedKeys: Map<string, CryptoKey> = new Map()
  private peerColors: Map<string, PeerColor> = new Map()
  private groupKey: CryptoKey | null = null
  private isCreator: boolean = false
  private creatorId: string = ''
  private myColor: PeerColor

  constructor() {
    this.myColor = getOrAssignMyColor()
  }

  async initialize(): Promise<string> {
    this.keyPair = await generateKeyPair()
    const publicKey = await exportPublicKey(this.keyPair.publicKey)
    return encodeKeyWithColor(publicKey, this.myColor)
  }

  getMyColor(): PeerColor {
    return this.myColor
  }

  setCreatorStatus(isCreator: boolean, creatorId: string): void {
    this.isCreator = isCreator
    this.creatorId = creatorId
  }

  async generateAndSetGroupKey(): Promise<void> {
    this.groupKey = await generateGroupKey()
  }

  async addPeer(peerId: string, encodedPublicKey: string): Promise<void> {
    if (!this.keyPair) throw new Error('Key pair not initialized')
    const { color, publicKey } = decodeKeyWithColor(encodedPublicKey)
    const peerPublicKey = await importPublicKey(publicKey)
    const sharedKey = await deriveSharedKey(this.keyPair.privateKey, peerPublicKey)
    this.peerSharedKeys.set(peerId, sharedKey)
    this.peerColors.set(peerId, color)
  }

  removePeer(peerId: string): void {
    this.peerSharedKeys.delete(peerId)
    this.peerColors.delete(peerId)
  }

  getPeerColor(peerId: string): PeerColor {
    return this.peerColors.get(peerId) || 'blue'
  }

  async encryptGroupKeyForPeer(peerId: string): Promise<string> {
    if (!this.groupKey) throw new Error('Group key not set')
    const sharedKey = this.peerSharedKeys.get(peerId)
    if (!sharedKey) throw new Error(`No shared key for peer ${peerId}`)
    const exportedGroupKey = await exportGroupKey(this.groupKey)
    return encrypt(sharedKey, exportedGroupKey)
  }

  async receiveGroupKey(fromPeerId: string, encryptedGroupKey: string): Promise<void> {
    const sharedKey = this.peerSharedKeys.get(fromPeerId)
    if (!sharedKey) throw new Error(`No shared key for peer ${fromPeerId}`)
    const groupKeyBase64 = await decrypt(sharedKey, encryptedGroupKey)
    this.groupKey = await importGroupKey(groupKeyBase64)
  }

  async encryptMessage(message: string): Promise<string> {
    if (!this.groupKey) throw new Error('Group key not set')
    return encrypt(this.groupKey, message)
  }

  async decryptMessage(encryptedMessage: string): Promise<string> {
    if (!this.groupKey) throw new Error('Group key not set')
    return decrypt(this.groupKey, encryptedMessage)
  }

  hasGroupKey(): boolean {
    return this.groupKey !== null
  }

  getIsCreator(): boolean {
    return this.isCreator
  }

  getCreatorId(): string {
    return this.creatorId
  }

  getPeerIds(): string[] {
    return Array.from(this.peerSharedKeys.keys())
  }

  hasPeers(): boolean {
    return this.peerSharedKeys.size > 0
  }
}
