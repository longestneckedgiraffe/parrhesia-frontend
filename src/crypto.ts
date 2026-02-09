import { MlKem768 } from 'mlkem'

export interface KeyPair {
  publicKey: CryptoKey
  privateKey: CryptoKey
}

export interface MlKemKeyPair {
  publicKey: Uint8Array   // 1184 bytes
  secretKey: Uint8Array   // 2400 bytes
}

export interface HybridKeySharePayload {
  encrypted_group_key: string
  pq_ciphertext?: string   // present only when hybrid path used
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

const HYBRID_KEM_INFO = new TextEncoder().encode('parrhesia-hybrid-kem-v1')
const HYBRID_KEM_SALT = new Uint8Array(32)

const PBKDF2_ITERATIONS = 600000
const STORAGE_KEY = 'parrhesia-keypair'
const WRAPPED_STORAGE_KEY = 'parrhesia-keypair-wrapped'
const MESSAGE_SALT_KEY = 'parrhesia-message-salt'

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

    let privateKey: CryptoKey
    try {
      privateKey = await crypto.subtle.unwrapKey(
        'jwk',
        wrappedKey,
        wrappingKey,
        { name: 'AES-GCM', iv },
        ECDH_PARAMS,
        true,
        ['deriveKey', 'deriveBits']
      )
    } catch {
      privateKey = await crypto.subtle.unwrapKey(
        'jwk',
        wrappedKey,
        wrappingKey,
        { name: 'AES-GCM', iv },
        ECDH_PARAMS,
        true,
        ['deriveKey']
      )
    }

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

export async function deriveMessageKey(password: string): Promise<CryptoKey> {
  let saltBase64 = localStorage.getItem(MESSAGE_SALT_KEY)
  let salt: Uint8Array

  if (!saltBase64) {
    salt = crypto.getRandomValues(new Uint8Array(16))
    saltBase64 = btoa(String.fromCharCode(...salt))
    localStorage.setItem(MESSAGE_SALT_KEY, saltBase64)
  } else {
    salt = Uint8Array.from(atob(saltBase64), c => c.charCodeAt(0))
  }

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password + '-messages'),
    'PBKDF2',
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export interface EncryptedData {
  encrypted: true
  iv: string
  data: string
}

export async function encryptMessages(messages: unknown[], key: CryptoKey): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(messages))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)

  return {
    encrypted: true,
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
  }
}

export async function decryptMessages(encrypted: EncryptedData, key: CryptoKey): Promise<unknown[]> {
  const iv = Uint8Array.from(atob(encrypted.iv), c => c.charCodeAt(0))
  const ciphertext = Uint8Array.from(atob(encrypted.data), c => c.charCodeAt(0))
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return JSON.parse(new TextDecoder().decode(plaintext))
}

export function isEncryptedData(data: unknown): data is EncryptedData {
  return typeof data === 'object' && data !== null && 'encrypted' in data && (data as EncryptedData).encrypted === true
}

export async function deriveColorFromPublicKey(publicKeyBase64: string): Promise<PeerColor> {
  const prefs = await deriveColorPreferences(publicKeyBase64)
  return prefs[0]
}

export async function deriveColorPreferences(publicKeyBase64: string): Promise<PeerColor[]> {
  const data = new TextEncoder().encode(publicKeyBase64)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(hashBuffer)

  const firstIndex = bytes[0] % PEER_COLORS.length
  const result: PeerColor[] = [PEER_COLORS[firstIndex]]

  const remaining = [...PEER_COLORS].filter((_, i) => i !== firstIndex)
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = bytes[i] % (i + 1)
    ;[remaining[i], remaining[j]] = [remaining[j], remaining[i]]
  }

  return [...result, ...remaining]
}

async function exportPrivateKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', key)
}

async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ECDH_PARAMS, true, ['deriveKey', 'deriveBits'])
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
  const keyPair = await crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey', 'deriveBits'])
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
    let privateKey: CryptoKey
    try {
      privateKey = await importPrivateKey(data.privateKey)
    } catch {
      privateKey = await crypto.subtle.importKey('jwk', data.privateKey, ECDH_PARAMS, true, ['deriveKey'])
    }
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

// ML-KEM helper functions

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export async function generateMlKemKeyPair(): Promise<MlKemKeyPair> {
  const kem = new MlKem768()
  const [publicKey, secretKey] = await kem.generateKeyPair()
  return { publicKey, secretKey }
}

export async function mlKemEncapsulate(peerPub: Uint8Array): Promise<{ ciphertext: Uint8Array; sharedSecret: Uint8Array }> {
  const kem = new MlKem768()
  const [ciphertext, sharedSecret] = await kem.encap(peerPub)
  return { ciphertext, sharedSecret }
}

export async function mlKemDecapsulate(ct: Uint8Array, sk: Uint8Array): Promise<Uint8Array> {
  const kem = new MlKem768()
  return kem.decap(ct, sk)
}

export async function deriveEcdhBits(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  )
  return new Uint8Array(bits)
}

export async function deriveHybridKey(ecdhBits: Uint8Array, mlkemSS: Uint8Array): Promise<CryptoKey> {
  const combined = new Uint8Array(ecdhBits.length + mlkemSS.length)
  combined.set(ecdhBits)
  combined.set(mlkemSS, ecdhBits.length)

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    combined,
    'HKDF',
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    { name: 'HKDF', salt: HYBRID_KEM_SALT as BufferSource, info: HYBRID_KEM_INFO as BufferSource, hash: 'SHA-256' },
    keyMaterial,
    AES_PARAMS,
    false,
    ['encrypt', 'decrypt']
  )
}

export function isValidMlKemPublicKey(b64: string): boolean {
  try {
    const decoded = base64ToUint8Array(b64)
    return decoded.length === 1184
  } catch {
    return false
  }
}

export class GroupKeyManager {
  private keyPair: KeyPair | null = null
  private myPublicKey: string = ''
  private myColor: PeerColor = 'blue'
  private peerSharedKeys: Map<string, CryptoKey> = new Map()
  private peerPublicKeys: Map<string, string> = new Map()
  private peerColors: Map<string, PeerColor> = new Map()
  private colorPreferences: Map<string, PeerColor[]> = new Map()
  private groupKey: CryptoKey | null = null
  private isCreator: boolean = false
  private creatorId: string = ''
  private mlKemKeyPair: MlKemKeyPair | null = null
  private peerMlKemPublicKeys: Map<string, Uint8Array> = new Map()
  private canDeriveBits: boolean = false

  async initialize(password?: string): Promise<string> {
    const { keyPair, publicKey } = await getOrCreateKeyPair(password)
    this.keyPair = keyPair
    this.myPublicKey = publicKey
    const prefs = await deriveColorPreferences(publicKey)
    this.colorPreferences.set(publicKey, prefs)
    this.myColor = prefs[0]

    // test if deriveBits is available on this key
    try {
      const testPub = await crypto.subtle.importKey('raw',
        await crypto.subtle.exportKey('raw', keyPair.publicKey),
        ECDH_PARAMS, true, [])
      await crypto.subtle.deriveBits({ name: 'ECDH', public: testPub }, keyPair.privateKey, 256)
      this.canDeriveBits = true
    } catch {
      this.canDeriveBits = false
    }

    // generate ephemeral ML-KEM keypair
    if (this.canDeriveBits) {
      this.mlKemKeyPair = await generateMlKemKeyPair()
    }

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

  async addPeer(peerId: string, publicKeyBase64: string, pqPublicKeyBase64?: string): Promise<void> {
    if (!this.keyPair) throw new Error('Key pair not initialized')
    const peerPublicKey = await importPublicKey(publicKeyBase64)
    const sharedKey = await deriveSharedKey(this.keyPair.privateKey, peerPublicKey)
    this.peerSharedKeys.set(peerId, sharedKey)
    this.peerPublicKeys.set(peerId, publicKeyBase64)
    if (pqPublicKeyBase64 && isValidMlKemPublicKey(pqPublicKeyBase64)) {
      this.peerMlKemPublicKeys.set(peerId, base64ToUint8Array(pqPublicKeyBase64))
    }
    if (!this.colorPreferences.has(publicKeyBase64)) {
      this.colorPreferences.set(publicKeyBase64, await deriveColorPreferences(publicKeyBase64))
    }
    this.recomputeColors()
  }

  removePeer(peerId: string): void {
    const pubKey = this.peerPublicKeys.get(peerId)
    this.peerSharedKeys.delete(peerId)
    this.peerPublicKeys.delete(peerId)
    this.peerColors.delete(peerId)
    this.peerMlKemPublicKeys.delete(peerId)
    if (pubKey) this.colorPreferences.delete(pubKey)
    this.recomputeColors()
  }

  private recomputeColors(): void {
    const allEntries: { id: string; publicKey: string }[] = [
      { id: '__self__', publicKey: this.myPublicKey }
    ]
    for (const [peerId, pubKey] of this.peerPublicKeys) {
      allEntries.push({ id: peerId, publicKey: pubKey })
    }

    allEntries.sort((a, b) => a.publicKey.localeCompare(b.publicKey))

    const taken = new Set<PeerColor>()
    for (const entry of allEntries) {
      const prefs = this.colorPreferences.get(entry.publicKey)!
      const color = prefs.find(c => !taken.has(c)) || prefs[0]
      taken.add(color)
      if (entry.id === '__self__') {
        this.myColor = color
      } else {
        this.peerColors.set(entry.id, color)
      }
    }
  }

  getPeerColor(peerId: string): PeerColor {
    return this.peerColors.get(peerId) || 'blue'
  }

  async encryptGroupKeyForPeer(peerId: string): Promise<HybridKeySharePayload> {
    if (!this.groupKey) throw new Error('Group key not set')
    if (!this.keyPair) throw new Error('Key pair not initialized')
    const exportedGroupKey = await exportGroupKey(this.groupKey)

    const peerMlKemPub = this.peerMlKemPublicKeys.get(peerId)
    if (peerMlKemPub && this.canDeriveBits) {
      const peerEcdhPub = await importPublicKey(this.peerPublicKeys.get(peerId)!)
      const ecdhBits = await deriveEcdhBits(this.keyPair.privateKey, peerEcdhPub)
      const { ciphertext, sharedSecret } = await mlKemEncapsulate(peerMlKemPub)
      const hybridKey = await deriveHybridKey(ecdhBits, sharedSecret)
      const encryptedGroupKey = await encrypt(hybridKey, exportedGroupKey)
      console.log(`[PQ] Hybrid key exchange with peer ${peerId}`)
      return {
        encrypted_group_key: encryptedGroupKey,
        pq_ciphertext: uint8ArrayToBase64(ciphertext)
      }
    }

    // fallback
    const sharedKey = this.peerSharedKeys.get(peerId)
    if (!sharedKey) throw new Error(`No shared key for peer ${peerId}`)
    const encryptedGroupKey = await encrypt(sharedKey, exportedGroupKey)
    console.log(`[PQ] ECDH-only key exchange with peer ${peerId}`)
    return { encrypted_group_key: encryptedGroupKey }
  }

  async receiveGroupKey(fromPeerId: string, encryptedGroupKey: string, pqCiphertext?: string): Promise<void> {
    if (!this.keyPair) throw new Error('Key pair not initialized')

    if (pqCiphertext && this.mlKemKeyPair && this.canDeriveBits) {
      const peerEcdhPub = await importPublicKey(this.peerPublicKeys.get(fromPeerId)!)
      const ecdhBits = await deriveEcdhBits(this.keyPair.privateKey, peerEcdhPub)
      const ct = base64ToUint8Array(pqCiphertext)
      const mlkemSS = await mlKemDecapsulate(ct, this.mlKemKeyPair.secretKey)
      const hybridKey = await deriveHybridKey(ecdhBits, mlkemSS)
      const groupKeyBase64 = await decrypt(hybridKey, encryptedGroupKey)
      this.groupKey = await importGroupKey(groupKeyBase64)
      console.log(`[PQ] Hybrid key received from peer ${fromPeerId}`)
      return
    }

    const sharedKey = this.peerSharedKeys.get(fromPeerId)
    if (!sharedKey) throw new Error(`No shared key for peer ${fromPeerId}`)
    const groupKeyBase64 = await decrypt(sharedKey, encryptedGroupKey)
    this.groupKey = await importGroupKey(groupKeyBase64)
    console.log(`[PQ] ECDH-only key received from peer ${fromPeerId}`)
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

  getMlKemPublicKeyBase64(): string | null {
    if (!this.mlKemKeyPair) return null
    return uint8ArrayToBase64(this.mlKemKeyPair.publicKey)
  }

  hasPqSupport(peerId: string): boolean {
    return this.peerMlKemPublicKeys.has(peerId) && this.canDeriveBits
  }
}
