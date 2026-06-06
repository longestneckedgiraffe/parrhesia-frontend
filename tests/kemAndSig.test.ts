import { describe, it, expect } from 'vitest'
import {
  generateMlKemKeyPair,
  mlKemEncapsulate,
  mlKemDecapsulate,
  generateSigningKeyPair,
  sign,
  verify,
} from '../src/crypto/crypto'

describe('ML-KEM key exchange', () => {
  it('encapsulate and decapsulate agree on the shared secret', async () => {
    const kp = await generateMlKemKeyPair()
    const { ciphertext, sharedSecret } = await mlKemEncapsulate(kp.publicKey)
    const recovered = await mlKemDecapsulate(ciphertext, kp.secretKey)
    expect(Array.from(recovered)).toEqual(Array.from(sharedSecret))
  })
})

describe('ML-DSA signatures', () => {
  it('verifies a valid signature', () => {
    const kp = generateSigningKeyPair()
    const msg = new TextEncoder().encode('authenticated data')
    const sig = sign(kp.secretKey, msg)
    expect(verify(kp.publicKey, msg, sig)).toBe(true)
  })

  it('rejects a tampered message', () => {
    const kp = generateSigningKeyPair()
    const msg = new TextEncoder().encode('authenticated data')
    const sig = sign(kp.secretKey, msg)
    const tampered = new Uint8Array(msg)
    tampered[0] ^= 1
    expect(verify(kp.publicKey, tampered, sig)).toBe(false)
  })
})
