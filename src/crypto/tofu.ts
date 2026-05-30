export type VerificationStatus = 'unverified' | 'verified' | 'key_changed'

export interface StoredPeerKey {
  peerId: string
  roomId: string
  publicKeyBase64: string
  status: VerificationStatus
  firstSeen: number
  lastSeen: number
  verifiedAt?: number
}

interface TofuStore {
  version: number
  peers: Record<string, StoredPeerKey>
}

const STORAGE_KEY = 'parrhesia-tofu'
const VERIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function getKeyLookupKey(roomId: string, publicKeyBase64: string): string {
  return JSON.stringify([roomId, publicKeyBase64])
}

function loadTofuStore(): TofuStore {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return { version: 1, peers: {} }
  try {
    return JSON.parse(stored)
  } catch {
    return { version: 1, peers: {} }
  }
}

function saveTofuStore(store: TofuStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

function isVerificationExpired(record: StoredPeerKey): boolean {
  if (record.status !== 'verified') return false
  if (!record.verifiedAt) return true
  return Date.now() - record.verifiedAt > VERIFICATION_MAX_AGE_MS
}

export function getStoredKey(roomId: string, publicKeyBase64: string): StoredPeerKey | null {
  const store = loadTofuStore()
  const key = getKeyLookupKey(roomId, publicKeyBase64)
  return store.peers[key] || null
}

export function getStoredPeerKey(roomId: string, peerId: string, publicKeyBase64?: string): StoredPeerKey | null {
  if (publicKeyBase64) {
    return getStoredKey(roomId, publicKeyBase64)
  }
  const store = loadTofuStore()
  for (const record of Object.values(store.peers)) {
    if (record.roomId === roomId && record.peerId === peerId) {
      return record
    }
  }
  return null
}

export function storePeerKey(roomId: string, peerId: string, publicKeyBase64: string): StoredPeerKey {
  const store = loadTofuStore()
  const key = getKeyLookupKey(roomId, publicKeyBase64)
  const existing = store.peers[key]
  const now = Date.now()

  const record: StoredPeerKey = {
    peerId,
    roomId,
    publicKeyBase64,
    status: existing?.status || 'unverified',
    firstSeen: existing?.firstSeen || now,
    lastSeen: now,
    verifiedAt: existing?.verifiedAt
  }

  store.peers[key] = record
  saveTofuStore(store)
  return record
}

export interface KeyCheckResult {
  status: VerificationStatus
  stored: StoredPeerKey | null
  isNewKey: boolean
}

export function checkPeerKey(roomId: string, peerId: string, publicKeyBase64: string): KeyCheckResult {
  const store = loadTofuStore()
  const key = getKeyLookupKey(roomId, publicKeyBase64)
  const stored = store.peers[key]

  if (!stored) {
    return { status: 'unverified', stored: null, isNewKey: true }
  }

  store.peers[key].peerId = peerId
  store.peers[key].lastSeen = Date.now()

  if (isVerificationExpired(stored)) {
    store.peers[key].status = 'unverified'
    store.peers[key].verifiedAt = undefined
    saveTofuStore(store)
    return { status: 'unverified', stored: store.peers[key], isNewKey: false }
  }

  saveTofuStore(store)
  return { status: stored.status, stored: store.peers[key], isNewKey: false }
}

export function markAsVerified(roomId: string, peerId: string, publicKeyBase64: string): void {
  const store = loadTofuStore()
  const key = getKeyLookupKey(roomId, publicKeyBase64)
  if (store.peers[key]) {
    const now = Date.now()
    store.peers[key].status = 'verified'
    store.peers[key].verifiedAt = now
    store.peers[key].lastSeen = now
    store.peers[key].peerId = peerId
    saveTofuStore(store)
  }
}

export function resetVerification(roomId: string, publicKeyBase64: string): void {
  const store = loadTofuStore()
  const key = getKeyLookupKey(roomId, publicKeyBase64)
  if (store.peers[key]) {
    store.peers[key].status = 'unverified'
    store.peers[key].verifiedAt = undefined
    saveTofuStore(store)
  }
}

export async function generateSafetyNumber(myPublicKey: string, peerPublicKey: string): Promise<string> {
  const sorted = [myPublicKey, peerPublicKey].sort()
  const combined = sorted.join('')
  const data = new TextEncoder().encode(combined)
  let hashBuffer = await crypto.subtle.digest('SHA-256', data)
  let bytes = new Uint8Array(hashBuffer)

  const limit = 4294900000
  const groups: string[] = []
  let offset = 0

  while (groups.length < 6) {
    if (offset + 4 > bytes.length) {
      hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
      bytes = new Uint8Array(hashBuffer)
      offset = 0
    }

    const value = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
    offset += 4

    if (value < limit) {
      groups.push((value % 100000).toString().padStart(5, '0'))
    }
  }

  return groups.join(' ')
}
