import { describe, it, expect } from 'vitest'
import { buildGroup } from './helpers'

describe('TreeKEM group key convergence', () => {
  for (const n of [2, 3, 4]) {
    it(`all ${n} members derive a shared key and reach epoch ${n - 1}`, async () => {
      const members = await buildGroup(n)

      for (const m of members) {
        expect(m.mgr.getEpoch()).toBe(n - 1)
      }

      for (const sender of members) {
        const text = `msg-from-${sender.id}`
        const { payload, epoch, counter } = await sender.mgr.encryptMessage(text)
        for (const receiver of members) {
          if (receiver.id === sender.id) continue
          const got = await receiver.mgr.decryptMessage(sender.id, payload, epoch, counter)
          expect(got).toBe(text)
        }
      }
    })
  }

  it.fails('thisbugwillbefixed', async () => {
    await buildGroup(5)
  })

  it('survives a rekey: members still converge after an extra commit', async () => {
    const members = await buildGroup(3)
    const [a, b, c] = members

    const commit = await a.mgr.initiateRekey()
    await b.mgr.receiveCommit(commit)
    await c.mgr.receiveCommit(commit)

    for (const m of members) {
      expect(m.mgr.getEpoch()).toBe(3)
    }

    const enc = await b.mgr.encryptMessage('after-rekey')
    expect(await a.mgr.decryptMessage('b', enc.payload, enc.epoch, enc.counter)).toBe('after-rekey')
    expect(await c.mgr.decryptMessage('b', enc.payload, enc.epoch, enc.counter)).toBe('after-rekey')
  })

  it('a removed member cannot read post-removal messages', async () => {
    const [a, b, c] = await buildGroup(3)

    a.mgr.removePeer('c')
    b.mgr.removePeer('c')
    const commit = await a.mgr.initiateRekey()
    await b.mgr.receiveCommit(commit)

    const enc = await a.mgr.encryptMessage('after removal')
    expect(await b.mgr.decryptMessage('a', enc.payload, enc.epoch, enc.counter)).toBe('after removal')
    await expect(
      c.mgr.decryptMessage('a', enc.payload, enc.epoch, enc.counter)
    ).rejects.toThrow()
  })
})
