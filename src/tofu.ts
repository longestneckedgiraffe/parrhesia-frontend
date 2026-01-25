export type VerificationStatus = 'unverified' | 'verified' | 'key_changed'

export interface StoredPeerKey {
  peerId: string
  roomId: string
  publicKeyBase64: string
  status: VerificationStatus
  firstSeen: number
  lastSeen: number
}

interface TofuStore {
  version: number
  peers: Record<string, StoredPeerKey>
}

const STORAGE_KEY = 'parrhesia-tofu'

function getPeerLookupKey(roomId: string, peerId: string): string {
  return JSON.stringify([roomId, peerId])
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

export function getStoredPeerKey(roomId: string, peerId: string): StoredPeerKey | null {
  const store = loadTofuStore()
  const key = getPeerLookupKey(roomId, peerId)
  return store.peers[key] || null
}

export function storePeerKey(roomId: string, peerId: string, publicKeyBase64: string): StoredPeerKey {
  const store = loadTofuStore()
  const key = getPeerLookupKey(roomId, peerId)
  const now = Date.now()

  const record: StoredPeerKey = {
    peerId,
    roomId,
    publicKeyBase64,
    status: 'unverified',
    firstSeen: now,
    lastSeen: now
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
  const stored = getStoredPeerKey(roomId, peerId)

  if (!stored) {
    return { status: 'unverified', stored: null, isNewKey: true }
  }

  if (stored.publicKeyBase64 === publicKeyBase64) {
    const store = loadTofuStore()
    const key = getPeerLookupKey(roomId, peerId)
    store.peers[key].lastSeen = Date.now()
    saveTofuStore(store)
    return { status: stored.status, stored, isNewKey: false }
  }

  return { status: 'key_changed', stored, isNewKey: false }
}

export function acceptKeyChange(roomId: string, peerId: string, newPublicKey: string): void {
  const store = loadTofuStore()
  const key = getPeerLookupKey(roomId, peerId)
  const existing = store.peers[key]
  const now = Date.now()

  store.peers[key] = {
    peerId,
    roomId,
    publicKeyBase64: newPublicKey,
    status: 'unverified',
    firstSeen: existing?.firstSeen || now,
    lastSeen: now
  }

  saveTofuStore(store)
}

export function markAsVerified(roomId: string, peerId: string): void {
  const store = loadTofuStore()
  const key = getPeerLookupKey(roomId, peerId)
  if (store.peers[key]) {
    store.peers[key].status = 'verified'
    store.peers[key].lastSeen = Date.now()
    saveTofuStore(store)
  }
}

export function resetVerification(roomId: string, peerId: string): void {
  const store = loadTofuStore()
  const key = getPeerLookupKey(roomId, peerId)
  if (store.peers[key]) {
    store.peers[key].status = 'unverified'
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

