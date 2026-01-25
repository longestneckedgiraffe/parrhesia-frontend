const SETTINGS_KEY = 'parrhesia-settings'

interface Settings {
  tofuEnabled: boolean
}

function loadSettings(): Settings {
  const stored = localStorage.getItem(SETTINGS_KEY)
  if (!stored) return { tofuEnabled: false }
  try {
    return JSON.parse(stored)
  } catch {
    return { tofuEnabled: false }
  }
}

function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function isTofuEnabled(): boolean {
  return loadSettings().tofuEnabled
}

export function setTofuEnabled(enabled: boolean): void {
  const settings = loadSettings()
  settings.tofuEnabled = enabled
  saveSettings(settings)
}

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
  return `${roomId}:${peerId}`
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
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(hashBuffer)

  const groups: string[] = []
  for (let i = 0; i < 6; i++) {
    const offset = i * 4
    const value = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
    groups.push((value % 100000).toString().padStart(5, '0'))
  }

  return groups.join(' ')
}
