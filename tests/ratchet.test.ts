import { describe, it, expect } from 'vitest'
import { buildGroup, type Member } from './helpers'

describe('symmetric chain ratchet', () => {
  it('decrypts messages in order', async () => {
    const [a, b] = await buildGroup(2)
    const texts = ['m0', 'm1', 'm2']
    const sent = []
    for (const t of texts) sent.push(await a.mgr.encryptMessage(t))
    for (let i = 0; i < texts.length; i++) {
      expect(await b.mgr.decryptMessage('a', sent[i].payload, sent[i].epoch, sent[i].counter)).toBe(texts[i])
    }
  })

  it('decrypts out of order using skipped keys', async () => {
    const [a, b] = await buildGroup(2)
    const e0 = await a.mgr.encryptMessage('m0')
    const e1 = await a.mgr.encryptMessage('m1')
    const e2 = await a.mgr.encryptMessage('m2')

    expect(await b.mgr.decryptMessage('a', e2.payload, e2.epoch, e2.counter)).toBe('m2')
    expect(await b.mgr.decryptMessage('a', e0.payload, e0.epoch, e0.counter)).toBe('m0')
    expect(await b.mgr.decryptMessage('a', e1.payload, e1.epoch, e1.counter)).toBe('m1')
  })

  it('rejects a replayed (already consumed) counter', async () => {
    const [a, b] = await buildGroup(2)
    const e0 = await a.mgr.encryptMessage('m0')
    expect(await b.mgr.decryptMessage('a', e0.payload, e0.epoch, e0.counter)).toBe('m0')
    await expect(
      b.mgr.decryptMessage('a', e0.payload, e0.epoch, e0.counter)
    ).rejects.toThrow(/already consumed/)
  })

  it('rejects a gap larger than MAX_SKIP', async () => {
    const [a, b] = await buildGroup(2)
    let last = await a.mgr.encryptMessage('x0')
    for (let i = 1; i < 102; i++) last = await a.mgr.encryptMessage('x' + i)
    expect(last.counter).toBe(101)
    await expect(
      b.mgr.decryptMessage('a', last.payload, last.epoch, last.counter)
    ).rejects.toThrow(/Too many skipped/)
  })

  it('decrypts a previous-epoch message after a rekey, but rejects an unknown epoch', async () => {
    const members: Member[] = await buildGroup(2)
    const [a, b] = members

    const e = await a.mgr.encryptMessage('old-epoch-msg')
    const oldEpoch = e.epoch

    const commit = await a.mgr.initiateRekey()
    await b.mgr.receiveCommit(commit)
    expect(b.mgr.getEpoch()).toBe(oldEpoch + 1)

    expect(await b.mgr.decryptMessage('a', e.payload, e.epoch, e.counter)).toBe('old-epoch-msg')
    await expect(
      b.mgr.decryptMessage('a', e.payload, oldEpoch + 5, e.counter)
    ).rejects.toThrow(/Unknown epoch/)
  })
})
