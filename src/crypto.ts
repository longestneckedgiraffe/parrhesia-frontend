import { MlKem768 } from 'mlkem'
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'

export interface SigningKeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export interface MlKemKeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export interface KeySharePayload {
  encrypted_group_key: string
  pq_ciphertext: string
  sig: string
}

export const PEER_COLORS = [
  'black', 'gray', 'silver', 'maroon', 'red', 'olive',
  'green', 'lime', 'navy', 'blue', 'teal', 'cyan',
  'purple', 'magenta', 'orange', 'gold'
] as const
export type PeerColor = typeof PEER_COLORS[number]

const AES_PARAMS = {
  name: 'AES-GCM',
  length: 256
}

const KEM_INFO = new TextEncoder().encode('parrhesia-kem-v2')
const KEM_SALT = new Uint8Array(32)

const PBKDF2_ITERATIONS = 600000
const STORAGE_KEY = 'parrhesia-keypair'
const WRAPPED_STORAGE_KEY = 'parrhesia-keypair-wrapped'
const MESSAGE_SALT_KEY = 'parrhesia-message-salt'

interface WrappedKeyData {
  encryptedKey: string
  salt: string
  iv: string
  publicKey: string
}

export function isValidPublicKey(base64Key: string): boolean {
  try {
    const binaryString = atob(base64Key)
    return binaryString.length === 1952
  } catch {
    return false
  }
}

export function sign(secretKey: Uint8Array, data: Uint8Array): Uint8Array {
  return ml_dsa65.sign(data, secretKey)
}

export function verify(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
  return ml_dsa65.verify(signature, data, publicKey)
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, secretKey } = ml_dsa65.keygen()
  return { publicKey, secretKey }
}

export async function deriveKemKey(mlkemSS: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    mlkemSS as BufferSource,
    'HKDF',
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    { name: 'HKDF', salt: KEM_SALT as BufferSource, info: KEM_INFO as BufferSource, hash: 'SHA-256' },
    keyMaterial,
    AES_PARAMS,
    false,
    ['encrypt', 'decrypt']
  )
}

function isLegacyStoredFormat(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  return typeof obj.privateKey === 'object' && obj.privateKey !== null && 'kty' in (obj.privateKey as Record<string, unknown>)
}

function isLegacyWrappedFormat(data: WrappedKeyData): boolean {
  try {
    const decoded = atob(data.publicKey)
    return decoded.length === 65
  } catch {
    return true
  }
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
    ['encrypt', 'decrypt']
  )
}

export async function saveKeyPairWithPassword(signingKeyPair: SigningKeyPair, publicKeyBase64: string, password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrappingKey = await deriveWrappingKey(password, salt)

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    signingKeyPair.secretKey as BufferSource
  )

  const data: WrappedKeyData = {
    encryptedKey: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    salt: btoa(String.fromCharCode(...salt)),
    iv: btoa(String.fromCharCode(...iv)),
    publicKey: publicKeyBase64
  }

  localStorage.removeItem(STORAGE_KEY)
  localStorage.setItem(WRAPPED_STORAGE_KEY, JSON.stringify(data))
}

export async function loadKeyPairWithPassword(password: string): Promise<{ keyPair: SigningKeyPair; publicKey: string } | null> {
  const stored = localStorage.getItem(WRAPPED_STORAGE_KEY)
  if (!stored) return null

  try {
    const data: WrappedKeyData = JSON.parse(stored)

    if (isLegacyWrappedFormat(data)) {
      localStorage.removeItem(WRAPPED_STORAGE_KEY)
      return null
    }

    const encryptedBytes = Uint8Array.from(atob(data.encryptedKey), c => c.charCodeAt(0))
    const salt = Uint8Array.from(atob(data.salt), c => c.charCodeAt(0))
    const iv = Uint8Array.from(atob(data.iv), c => c.charCodeAt(0))

    const wrappingKey = await deriveWrappingKey(password, salt)

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      encryptedBytes
    )

    const secretKey = new Uint8Array(decrypted)
    if (secretKey.length !== 4032) {
      localStorage.removeItem(WRAPPED_STORAGE_KEY)
      return null
    }

    const publicKey = base64ToUint8Array(data.publicKey)
    if (publicKey.length !== 1952) {
      localStorage.removeItem(WRAPPED_STORAGE_KEY)
      return null
    }

    return {
      keyPair: { publicKey, secretKey },
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

export function isValidMlKemPublicKey(b64: string): boolean {
  try {
    const decoded = base64ToUint8Array(b64)
    return decoded.length === 1184
  } catch {
    return false
  }
}

function saveKeyPairToStorage(signingKeyPair: SigningKeyPair, publicKeyBase64: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    secretKey: uint8ArrayToBase64(signingKeyPair.secretKey),
    publicKey: publicKeyBase64
  }))
}

function loadKeyPairFromStorage(): { keyPair: SigningKeyPair; publicKey: string } | null {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return null

  try {
    const data = JSON.parse(stored)

    if (isLegacyStoredFormat(data)) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }

    const secretKey = base64ToUint8Array(data.secretKey)
    const publicKey = base64ToUint8Array(data.publicKey)

    if (secretKey.length !== 4032 || publicKey.length !== 1952) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }

    return {
      keyPair: { publicKey, secretKey },
      publicKey: data.publicKey
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

export async function getOrCreateKeyPair(password?: string): Promise<{ keyPair: SigningKeyPair; publicKey: string }> {
  if (isKeyPasswordProtected()) {
    if (!password) throw new Error('Password required')
    const stored = await loadKeyPairWithPassword(password)
    if (!stored) throw new Error('Invalid password')
    return stored
  }

  const stored = loadKeyPairFromStorage()
  if (stored) return stored

  const keyPair = generateSigningKeyPair()
  const publicKey = uint8ArrayToBase64(keyPair.publicKey)

  if (password) {
    await saveKeyPairWithPassword(keyPair, publicKey, password)
  } else {
    saveKeyPairToStorage(keyPair, publicKey)
  }

  return { keyPair, publicKey }
}

export class GroupKeyManager {
  private signingKeyPair: SigningKeyPair | null = null
  private myPublicKey: string = ''
  private myColor: PeerColor = 'blue'
  private peerPublicKeys: Map<string, string> = new Map()
  private peerSigningKeys: Map<string, Uint8Array> = new Map()
  private peerColors: Map<string, PeerColor> = new Map()
  private colorPreferences: Map<string, PeerColor[]> = new Map()
  private groupKey: CryptoKey | null = null
  private isCreator: boolean = false
  private creatorId: string = ''
  private mlKemKeyPair: MlKemKeyPair | null = null
  private peerMlKemPublicKeys: Map<string, Uint8Array> = new Map()

  async initialize(password?: string): Promise<string> {
    const { keyPair, publicKey } = await getOrCreateKeyPair(password)
    this.signingKeyPair = keyPair
    this.myPublicKey = publicKey
    const prefs = await deriveColorPreferences(publicKey)
    this.colorPreferences.set(publicKey, prefs)
    this.myColor = prefs[0]

    this.mlKemKeyPair = await generateMlKemKeyPair()

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

  async addPeer(peerId: string, publicKeyBase64: string, pqPublicKeyBase64: string, sigBase64?: string): Promise<void> {
    if (!this.signingKeyPair) throw new Error('Signing key pair not initialized')
    if (!isValidMlKemPublicKey(pqPublicKeyBase64)) throw new Error('Invalid ML-KEM public key')

    if (sigBase64) {
      const signingPub = base64ToUint8Array(publicKeyBase64)
      const sigBytes = base64ToUint8Array(sigBase64)
      const pqPubBytes = base64ToUint8Array(pqPublicKeyBase64)
      if (!verify(signingPub, pqPubBytes, sigBytes)) {
        throw new Error('Invalid ML-DSA signature on ML-KEM public key')
      }
    }

    this.peerPublicKeys.set(peerId, publicKeyBase64)
    this.peerSigningKeys.set(peerId, base64ToUint8Array(publicKeyBase64))
    this.peerMlKemPublicKeys.set(peerId, base64ToUint8Array(pqPublicKeyBase64))
    if (!this.colorPreferences.has(publicKeyBase64)) {
      this.colorPreferences.set(publicKeyBase64, await deriveColorPreferences(publicKeyBase64))
    }
    this.recomputeColors()
  }

  removePeer(peerId: string): void {
    const pubKey = this.peerPublicKeys.get(peerId)
    this.peerPublicKeys.delete(peerId)
    this.peerColors.delete(peerId)
    this.peerMlKemPublicKeys.delete(peerId)
    this.peerSigningKeys.delete(peerId)
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

  async encryptGroupKeyForPeer(peerId: string): Promise<KeySharePayload> {
    if (!this.groupKey) throw new Error('Group key not set')
    if (!this.signingKeyPair) throw new Error('Signing key pair not initialized')
    const peerMlKemPub = this.peerMlKemPublicKeys.get(peerId)
    if (!peerMlKemPub) throw new Error(`No ML-KEM public key for peer ${peerId}`)
    const exportedGroupKey = await exportGroupKey(this.groupKey)
    const { ciphertext, sharedSecret } = await mlKemEncapsulate(peerMlKemPub)
    const kemKey = await deriveKemKey(sharedSecret)
    const encryptedGroupKey = await encrypt(kemKey, exportedGroupKey)
    const pqCiphertext = uint8ArrayToBase64(ciphertext)

    const dataToSign = new TextEncoder().encode(encryptedGroupKey + pqCiphertext)
    const sig = sign(this.signingKeyPair.secretKey, dataToSign)

    return {
      encrypted_group_key: encryptedGroupKey,
      pq_ciphertext: pqCiphertext,
      sig: uint8ArrayToBase64(sig)
    }
  }

  async receiveGroupKey(fromPeerId: string, encryptedGroupKey: string, pqCiphertext: string, sigBase64?: string): Promise<void> {
    if (!this.signingKeyPair) throw new Error('Signing key pair not initialized')
    if (!this.mlKemKeyPair) throw new Error('ML-KEM key pair not initialized')

    if (sigBase64) {
      const peerSigningKey = this.peerSigningKeys.get(fromPeerId)
      if (!peerSigningKey) throw new Error('No signing key for peer')
      const sigBytes = base64ToUint8Array(sigBase64)
      const dataToVerify = new TextEncoder().encode(encryptedGroupKey + pqCiphertext)
      if (!verify(peerSigningKey, dataToVerify, sigBytes)) {
        throw new Error('Invalid signature on key share')
      }
    }

    const ct = base64ToUint8Array(pqCiphertext)
    const mlkemSS = await mlKemDecapsulate(ct, this.mlKemKeyPair.secretKey)
    const kemKey = await deriveKemKey(mlkemSS)
    const groupKeyBase64 = await decrypt(kemKey, encryptedGroupKey)
    this.groupKey = await importGroupKey(groupKeyBase64)
  }

  signMlKemPublicKey(): string | null {
    if (!this.signingKeyPair || !this.mlKemKeyPair) return null
    const sig = sign(this.signingKeyPair.secretKey, this.mlKemKeyPair.publicKey)
    return uint8ArrayToBase64(sig)
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
    return Array.from(this.peerPublicKeys.keys())
  }

  hasPeers(): boolean {
    return this.peerPublicKeys.size > 0
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

}
