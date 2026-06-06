import { describe, it, expect, beforeEach } from 'vitest'
import {
  getOrCreateKeyPair,
  deriveMessageStorageKey,
  encryptMessages,
  decryptMessages,
  generateSigningKeyPair,
} from '../src/crypto/crypto'
import { getOrCreateDeviceKey } from '../src/crypto/deviceKey'
import { resetStorage, deleteDb } from './helpers'

describe('at-rest device key', () => {
  beforeEach(async () => {
    await resetStorage()
  })

  it('is a non-extractable AES-GCM key, stable across calls', async () => {
    const k1 = await getOrCreateDeviceKey()
    const k2 = await getOrCreateDeviceKey()
    expect(k1.extractable).toBe(false)
    expect((k1.algorithm as AesKeyAlgorithm).name).toBe('AES-GCM')

    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k1, new TextEncoder().encode('hi'))
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k2, ct)
    expect(new TextDecoder().decode(pt)).toBe('hi')
  })
})

describe('device-bound identity', () => {
  beforeEach(async () => {
    await resetStorage()
  })

  it('persists and reloads the same identity', async () => {
    const first = await getOrCreateKeyPair()
    const second = await getOrCreateKeyPair()
    expect(second.publicKey).toBe(first.publicKey)
    expect(Array.from(second.keyPair.secretKey)).toEqual(Array.from(first.keyPair.secretKey))
  })

  it('regenerates a fresh identity when the device key is lost', async () => {
    const first = await getOrCreateKeyPair()
    await deleteDb()
    const second = await getOrCreateKeyPair()
    expect(second.publicKey).not.toBe(first.publicKey)
  })
})

describe('message storage key (derived from identity)', () => {
  it('is deterministic for the same identity', async () => {
    const id = generateSigningKeyPair()
    const k1 = await deriveMessageStorageKey(id.secretKey)
    const k2 = await deriveMessageStorageKey(new Uint8Array(id.secretKey))
    const sample = [{ text: 'a' }, { text: 'b' }]
    const enc = await encryptMessages(sample, k1)
    expect(await decryptMessages(enc, k2)).toEqual(sample)
  })

  it('cannot be reproduced by a different identity', async () => {
    const id = generateSigningKeyPair()
    const other = generateSigningKeyPair()
    const k = await deriveMessageStorageKey(id.secretKey)
    const kOther = await deriveMessageStorageKey(other.secretKey)
    const enc = await encryptMessages([{ text: 'secret' }], k)
    await expect(decryptMessages(enc, kOther)).rejects.toThrow()
  })
})
