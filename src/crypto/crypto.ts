import { MlKem768 } from 'mlkem'
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { TreeKemState, deriveRootGroupKey, type TreeKemCommit, type TreeKemWelcome } from './treekem'
import { getOrCreateDeviceKey } from './deviceKey'
export type { TreeKemCommit, TreeKemWelcome } from './treekem'

export interface SigningKeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export interface MlKemKeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
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

const CHAIN_SALT = new Uint8Array(32)
const MESSAGE_STORAGE_INFO = new TextEncoder().encode('parrhesia-message-storage-v1')
const MAX_SKIP = 100

const DEVICE_BOUND_STORAGE_KEY = 'parrhesia-keypair-v3'
const LEGACY_STORAGE_KEYS = ['parrhesia-keypair', 'parrhesia-keypair-wrapped', 'parrhesia-message-salt']

interface ChainState {
  chainKey: Uint8Array
  counter: number
  skippedKeys: Map<number, CryptoKey>
}

interface DeviceBoundKeyData {
  encryptedKey: string
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

async function deriveChainKey(groupKeyBytes: Uint8Array, peerId: string): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', groupKeyBytes as BufferSource, 'HKDF', false, ['deriveBits'])
  const info = new TextEncoder().encode('parrhesia-chain-' + peerId)
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', salt: CHAIN_SALT as BufferSource, info: info as BufferSource, hash: 'SHA-256' },
    keyMaterial,
    256
  )
  return new Uint8Array(bits)
}

async function ratchetChain(chainKey: Uint8Array): Promise<{messageKey: CryptoKey, nextChainKey: Uint8Array}> {
  const keyMaterial = await crypto.subtle.importKey('raw', chainKey as BufferSource, 'HKDF', false, ['deriveKey', 'deriveBits'])
  const messageKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', salt: CHAIN_SALT as BufferSource, info: new TextEncoder().encode('msg') as BufferSource, hash: 'SHA-256' },
    keyMaterial,
    AES_PARAMS,
    false,
    ['encrypt', 'decrypt']
  )
  const nextBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', salt: CHAIN_SALT as BufferSource, info: new TextEncoder().encode('chain') as BufferSource, hash: 'SHA-256' },
    keyMaterial,
    256
  )
  return { messageKey, nextChainKey: new Uint8Array(nextBits) }
}

export function clearLegacyStorage(): void {
  for (const key of LEGACY_STORAGE_KEYS) {
    localStorage.removeItem(key)
  }
}

async function saveKeyPairDeviceBound(signingKeyPair: SigningKeyPair, publicKeyBase64: string, deviceKey: CryptoKey): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    deviceKey,
    signingKeyPair.secretKey as BufferSource
  )

  const data: DeviceBoundKeyData = {
    encryptedKey: uint8ArrayToBase64(new Uint8Array(encrypted)),
    iv: uint8ArrayToBase64(iv),
    publicKey: publicKeyBase64
  }

  localStorage.setItem(DEVICE_BOUND_STORAGE_KEY, JSON.stringify(data))
}

async function loadKeyPairDeviceBound(deviceKey: CryptoKey): Promise<{ keyPair: SigningKeyPair; publicKey: string } | null> {
  const stored = localStorage.getItem(DEVICE_BOUND_STORAGE_KEY)
  if (!stored) return null

  try {
    const data: DeviceBoundKeyData = JSON.parse(stored)
    const encryptedBytes = base64ToUint8Array(data.encryptedKey)
    const iv = base64ToUint8Array(data.iv)

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      deviceKey,
      encryptedBytes as BufferSource
    )

    const secretKey = new Uint8Array(decrypted)
    const publicKey = base64ToUint8Array(data.publicKey)
    if (secretKey.length !== 4032 || publicKey.length !== 1952) {
      localStorage.removeItem(DEVICE_BOUND_STORAGE_KEY)
      return null
    }

    return {
      keyPair: { publicKey, secretKey },
      publicKey: data.publicKey
    }
  } catch {
    localStorage.removeItem(DEVICE_BOUND_STORAGE_KEY)
    return null
  }
}

export async function deriveMessageStorageKey(identitySecretKey: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey('raw', identitySecretKey as BufferSource, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', salt: CHAIN_SALT as BufferSource, info: MESSAGE_STORAGE_INFO as BufferSource, hash: 'SHA-256' },
    keyMaterial,
    AES_PARAMS,
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

export async function getOrCreateKeyPair(): Promise<{ keyPair: SigningKeyPair; publicKey: string }> {
  const deviceKey = await getOrCreateDeviceKey()

  const stored = await loadKeyPairDeviceBound(deviceKey)
  if (stored) return stored

  const keyPair = generateSigningKeyPair()
  const publicKey = uint8ArrayToBase64(keyPair.publicKey)
  await saveKeyPairDeviceBound(keyPair, publicKey, deviceKey)

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
  private myPeerId: string = ''
  private epoch: number = 0
  private myChainState: ChainState | null = null
  private peerChainStates: Map<string, ChainState> = new Map()
  private previousEpochChains: Map<string, ChainState> | null = null
  private previousEpochTimeout: ReturnType<typeof setTimeout> | null = null
  private treeState: TreeKemState | null = null
  private peerLeafPositions: Map<string, number> = new Map()

  async initialize(): Promise<string> {
    const { keyPair, publicKey } = await getOrCreateKeyPair()
    this.signingKeyPair = keyPair
    this.myPublicKey = publicKey
    const prefs = await deriveColorPreferences(publicKey)
    this.colorPreferences.set(publicKey, prefs)
    this.myColor = prefs[0]

    this.mlKemKeyPair = await generateMlKemKeyPair()

    return publicKey
  }

  async getMessageStorageKey(): Promise<CryptoKey> {
    if (!this.signingKeyPair) throw new Error('Signing key pair not initialized')
    return deriveMessageStorageKey(this.signingKeyPair.secretKey)
  }

  getMyColor(): PeerColor {
    return this.myColor
  }

  setCreatorStatus(isCreator: boolean, creatorId: string, myPeerId: string): void {
    this.isCreator = isCreator
    this.creatorId = creatorId
    this.myPeerId = myPeerId
  }

  async generateAndSetGroupKey(): Promise<void> {
    if (!this.mlKemKeyPair) throw new Error('ML-KEM key pair not initialized')
    this.treeState = TreeKemState.createForCreator(this.mlKemKeyPair.publicKey, this.mlKemKeyPair.secretKey)
    this.groupKey = await deriveRootGroupKey(this.treeState.getRootSecret())
    await this.initializeChains()
  }

  private async exportGroupKeyBytes(): Promise<Uint8Array> {
    if (!this.groupKey) throw new Error('No group key')
    const raw = await crypto.subtle.exportKey('raw', this.groupKey)
    return new Uint8Array(raw)
  }

  private async initializeChains(): Promise<void> {
    if (!this.groupKey || !this.myPeerId) return
    const groupKeyBytes = await this.exportGroupKeyBytes()
    this.myChainState = {
      chainKey: await deriveChainKey(groupKeyBytes, this.myPeerId),
      counter: 0,
      skippedKeys: new Map()
    }
    this.peerChainStates.clear()
    for (const [peerId] of this.peerPublicKeys) {
      this.peerChainStates.set(peerId, {
        chainKey: await deriveChainKey(groupKeyBytes, peerId),
        counter: 0,
        skippedKeys: new Map()
      })
    }
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
    if (this.treeState) {
      const leafPos = this.treeState.addLeaf(base64ToUint8Array(pqPublicKeyBase64))
      this.peerLeafPositions.set(peerId, leafPos)
    }
    if (this.groupKey && this.myPeerId) {
      const groupKeyBytes = await this.exportGroupKeyBytes()
      this.peerChainStates.set(peerId, {
        chainKey: await deriveChainKey(groupKeyBytes, peerId),
        counter: 0,
        skippedKeys: new Map()
      })
    }
  }

  removePeer(peerId: string): void {
    const pubKey = this.peerPublicKeys.get(peerId)
    this.peerPublicKeys.delete(peerId)
    this.peerColors.delete(peerId)
    this.peerMlKemPublicKeys.delete(peerId)
    this.peerSigningKeys.delete(peerId)
    this.peerChainStates.delete(peerId)
    if (pubKey) this.colorPreferences.delete(pubKey)
    if (this.treeState) {
      const leafPos = this.peerLeafPositions.get(peerId)
      if (leafPos !== undefined) {
        this.treeState.removeLeaf(leafPos)
        this.peerLeafPositions.delete(peerId)
      }
    }
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

  async generateWelcomeForPeer(peerId: string): Promise<TreeKemWelcome> {
    if (!this.treeState) throw new Error('Tree state not initialized')
    const leafPos = this.peerLeafPositions.get(peerId)
    if (leafPos === undefined) throw new Error(`No leaf position for peer ${peerId}`)
    const peerMlKemPub = this.peerMlKemPublicKeys.get(peerId)
    if (!peerMlKemPub) throw new Error(`No ML-KEM public key for peer ${peerId}`)
    return this.treeState.generateWelcome(leafPos, peerMlKemPub, this.epoch)
  }

  async receiveWelcome(welcome: TreeKemWelcome): Promise<void> {
    if (!this.mlKemKeyPair) throw new Error('ML-KEM key pair not initialized')
    this.treeState = await TreeKemState.fromWelcome(welcome, this.mlKemKeyPair)
    this.epoch = welcome.epoch
    this.groupKey = await deriveRootGroupKey(this.treeState.getRootSecret())
    await this.initializeChains()
  }

  async receiveCommit(commit: TreeKemCommit): Promise<void> {
    if (!this.treeState) throw new Error('Tree state not initialized')
    this.savePreviousEpochChains()
    this.epoch = commit.epoch
    const rootSecret = await this.treeState.processCommit(commit)
    this.groupKey = await deriveRootGroupKey(rootSecret)
    await this.initializeChains()
  }

  signMlKemPublicKey(): string | null {
    if (!this.signingKeyPair || !this.mlKemKeyPair) return null
    const sig = sign(this.signingKeyPair.secretKey, this.mlKemKeyPair.publicKey)
    return uint8ArrayToBase64(sig)
  }

  async encryptMessage(message: string): Promise<{payload: string, epoch: number, counter: number}> {
    if (!this.myChainState) throw new Error('Chain not initialized')
    const { messageKey, nextChainKey } = await ratchetChain(this.myChainState.chainKey)
    const counter = this.myChainState.counter
    this.myChainState.chainKey = nextChainKey
    this.myChainState.counter++
    const payload = await encrypt(messageKey, message)
    return { payload, epoch: this.epoch, counter }
  }

  async decryptMessage(fromPeerId: string, encryptedMessage: string, epoch: number, counter: number): Promise<string> {
    let chainStates: Map<string, ChainState>
    if (epoch === this.epoch) {
      chainStates = this.peerChainStates
    } else if (epoch === this.epoch - 1 && this.previousEpochChains) {
      chainStates = this.previousEpochChains
    } else {
      throw new Error('Unknown epoch')
    }

    const peerChain = chainStates.get(fromPeerId)
    if (!peerChain) throw new Error('No chain for peer')

    const skippedKey = peerChain.skippedKeys.get(counter)
    if (skippedKey) {
      peerChain.skippedKeys.delete(counter)
      return decrypt(skippedKey, encryptedMessage)
    }

    if (counter < peerChain.counter) throw new Error('Message key already consumed')
    if (counter - peerChain.counter > MAX_SKIP) throw new Error('Too many skipped messages')

    while (peerChain.counter < counter) {
      const { messageKey, nextChainKey } = await ratchetChain(peerChain.chainKey)
      peerChain.skippedKeys.set(peerChain.counter, messageKey)
      peerChain.chainKey = nextChainKey
      peerChain.counter++
    }

    const { messageKey, nextChainKey } = await ratchetChain(peerChain.chainKey)
    peerChain.chainKey = nextChainKey
    peerChain.counter++
    return decrypt(messageKey, encryptedMessage)
  }

  hasTreeState(): boolean {
    return this.treeState !== null
  }

  hasGroupKey(): boolean {
    return this.groupKey !== null
  }

  hasChain(): boolean {
    return this.myChainState !== null
  }

  getEpoch(): number {
    return this.epoch
  }

  shouldInitiateRekey(excludePeerId?: string): boolean {
    if (!this.myPeerId) return false
    let allIds = [this.myPeerId, ...this.peerPublicKeys.keys()]
    if (excludePeerId) allIds = allIds.filter(id => id !== excludePeerId)
    allIds.sort()
    return allIds[0] === this.myPeerId
  }

  savePreviousEpochChains(): void {
    if (this.previousEpochTimeout) {
      clearTimeout(this.previousEpochTimeout)
    }
    this.previousEpochChains = new Map()
    for (const [peerId, state] of this.peerChainStates) {
      this.previousEpochChains.set(peerId, {
        chainKey: new Uint8Array(state.chainKey),
        counter: state.counter,
        skippedKeys: new Map(state.skippedKeys)
      })
    }
    this.previousEpochTimeout = setTimeout(() => {
      this.previousEpochChains = null
      this.previousEpochTimeout = null
    }, 30000)
  }

  async initiateRekey(): Promise<TreeKemCommit> {
    if (!this.treeState) throw new Error('Tree state not initialized')
    this.savePreviousEpochChains()
    this.epoch++
    const commit = await this.treeState.generateCommit()
    commit.epoch = this.epoch
    this.groupKey = await deriveRootGroupKey(this.treeState.getRootSecret())
    await this.initializeChains()
    return commit
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
