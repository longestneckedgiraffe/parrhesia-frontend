export interface KeyPair {
  publicKey: CryptoKey
  privateKey: CryptoKey
}

export const PEER_COLORS = [
  'black', 'gray', 'silver', 'maroon', 'red', 'olive',
  'green', 'lime', 'navy', 'blue', 'teal', 'cyan',
  'purple', 'magenta', 'orange', 'gold'
] as const
export type PeerColor = typeof PEER_COLORS[number]

const ECDH_PARAMS: EcKeyGenParams = {
  name: 'ECDH',
  namedCurve: 'P-256'
}

const AES_PARAMS = {
  name: 'AES-GCM',
  length: 256
}

const PBKDF2_ITERATIONS = 600000
const STORAGE_KEY = 'parrhesia-keypair'
const WRAPPED_STORAGE_KEY = 'parrhesia-keypair-wrapped'

interface WrappedKeyData {
  wrappedKey: string
  salt: string
  iv: string
  publicKey: string
}

async function deriveWrappingKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  )
}

export async function saveKeyPairWithPassword(keyPair: KeyPair, publicKeyBase64: string, password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrappingKey = await deriveWrappingKey(password, salt)

  const wrappedKey = await crypto.subtle.wrapKey('jwk', keyPair.privateKey, wrappingKey, { name: 'AES-GCM', iv })

  const data: WrappedKeyData = {
    wrappedKey: btoa(String.fromCharCode(...new Uint8Array(wrappedKey))),
    salt: btoa(String.fromCharCode(...salt)),
    iv: btoa(String.fromCharCode(...iv)),
    publicKey: publicKeyBase64
  }

  localStorage.removeItem(STORAGE_KEY)
  localStorage.setItem(WRAPPED_STORAGE_KEY, JSON.stringify(data))
}

export async function loadKeyPairWithPassword(password: string): Promise<{ keyPair: KeyPair; publicKey: string } | null> {
  const stored = localStorage.getItem(WRAPPED_STORAGE_KEY)
  if (!stored) return null

  try {
    const data: WrappedKeyData = JSON.parse(stored)

    const wrappedKey = Uint8Array.from(atob(data.wrappedKey), c => c.charCodeAt(0))
    const salt = Uint8Array.from(atob(data.salt), c => c.charCodeAt(0))
    const iv = Uint8Array.from(atob(data.iv), c => c.charCodeAt(0))

    const wrappingKey = await deriveWrappingKey(password, salt)

    const privateKey = await crypto.subtle.unwrapKey(
      'jwk',
      wrappedKey,
      wrappingKey,
      { name: 'AES-GCM', iv },
      ECDH_PARAMS,
      true,
      ['deriveKey']
    )

    const publicKey = await importPublicKey(data.publicKey)

    return {
      keyPair: { publicKey, privateKey },
      publicKey: data.publicKey
    }
  } catch {
    return null
  }
}

export function isKeyPasswordProtected(): boolean {
  return localStorage.getItem(WRAPPED_STORAGE_KEY) !== null
}

export function hasStoredKeys(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null || localStorage.getItem(WRAPPED_STORAGE_KEY) !== null
}

export async function deriveColorFromPublicKey(publicKeyBase64: string): Promise<PeerColor> {
  const data = new TextEncoder().encode(publicKeyBase64)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(hashBuffer)
  const index = bytes[0] % PEER_COLORS.length
  return PEER_COLORS[index]
}

async function exportPrivateKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', key)
}

async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ECDH_PARAMS, true, ['deriveKey'])
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('raw', key)
  return btoa(String.fromCharCode(...new Uint8Array(exported)))
}

export function isValidPublicKey(base64Key: string): boolean {
  try {
    const binaryString = atob(base64Key)
    if (binaryString.length !== 65) return false
    if (binaryString.charCodeAt(0) !== 0x04) return false
    return true
  } catch {
    return false
  }
}

export async function importPublicKey(base64Key: string): Promise<CryptoKey> {
  if (!isValidPublicKey(base64Key)) {
    throw new Error('Invalid public key format')
  }
  const binaryString = atob(base64Key)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return crypto.subtle.importKey('raw', bytes, ECDH_PARAMS, true, [])
}

async function generateKeyPair(): Promise<KeyPair> {
  const keyPair = await crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey'])
  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey
  }
}

async function saveKeyPairToStorage(keyPair: KeyPair, publicKeyBase64: string): Promise<void> {
  const privateJwk = await exportPrivateKey(keyPair.privateKey)
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    privateKey: privateJwk,
    publicKey: publicKeyBase64
  }))
}

async function loadKeyPairFromStorage(): Promise<{ keyPair: KeyPair; publicKey: string } | null> {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return null

  try {
    const data = JSON.parse(stored)
    const privateKey = await importPrivateKey(data.privateKey)
    const publicKey = await importPublicKey(data.publicKey)
    return {
      keyPair: { publicKey, privateKey },
      publicKey: data.publicKey
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

export async function getOrCreateKeyPair(password?: string): Promise<{ keyPair: KeyPair; publicKey: string }> {
  if (isKeyPasswordProtected()) {
    if (!password) throw new Error('Password required')
    const stored = await loadKeyPairWithPassword(password)
    if (!stored) throw new Error('Invalid password')
    return stored
  }

  const stored = await loadKeyPairFromStorage()
  if (stored) return stored

  const keyPair = await generateKeyPair()
  const publicKey = await exportPublicKey(keyPair.publicKey)

  if (password) {
    await saveKeyPairWithPassword(keyPair, publicKey, password)
  } else {
    await saveKeyPairToStorage(keyPair, publicKey)
  }

  return { keyPair, publicKey }
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
  private myPublicKey: string = ''
  private myColor: PeerColor = 'blue'
  private peerSharedKeys: Map<string, CryptoKey> = new Map()
  private peerPublicKeys: Map<string, string> = new Map()
  private peerColors: Map<string, PeerColor> = new Map()
  private groupKey: CryptoKey | null = null
  private isCreator: boolean = false
  private creatorId: string = ''

  async initialize(password?: string): Promise<string> {
    const { keyPair, publicKey } = await getOrCreateKeyPair(password)
    this.keyPair = keyPair
    this.myPublicKey = publicKey
    this.myColor = await deriveColorFromPublicKey(publicKey)
    return publicKey
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

  async addPeer(peerId: string, publicKeyBase64: string): Promise<void> {
    if (!this.keyPair) throw new Error('Key pair not initialized')
    const peerPublicKey = await importPublicKey(publicKeyBase64)
    const sharedKey = await deriveSharedKey(this.keyPair.privateKey, peerPublicKey)
    this.peerSharedKeys.set(peerId, sharedKey)
    this.peerPublicKeys.set(peerId, publicKeyBase64)
    this.peerColors.set(peerId, await deriveColorFromPublicKey(publicKeyBase64))
  }

  removePeer(peerId: string): void {
    this.peerSharedKeys.delete(peerId)
    this.peerPublicKeys.delete(peerId)
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

  getMyPublicKey(): string {
    return this.myPublicKey
  }

  getPeerPublicKey(peerId: string): string | undefined {
    return this.peerPublicKeys.get(peerId)
  }
}
