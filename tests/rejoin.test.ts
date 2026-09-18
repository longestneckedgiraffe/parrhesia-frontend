import { describe, expect, it } from 'vitest'
import { GroupKeyManager } from '../src/crypto/crypto'
import { buildGroup, type Member } from './helpers'

async function rejoin(id: string, creatorId: string): Promise<Member> {
  const mgr = new GroupKeyManager()
  const signPub = await mgr.initialize()
  mgr.setCreatorStatus(false, creatorId, id)
  const pqPub = mgr.getMlKemPublicKeyBase64()!
  const sig = mgr.signMlKemPublicKey()!
  return { id, mgr, signPub, pqPub, sig }
}

async function addPeer(member: Member, peer: Member): Promise<void> {
  await member.mgr.addPeer(peer.id, peer.signPub, peer.pqPub, peer.sig)
}

async function expectMessages(members: Member[]): Promise<void> {
  for (const sender of members) {
    const message = await sender.mgr.encryptMessage(`from ${sender.id}`)
    for (const receiver of members) {
      if (sender === receiver) continue
      await expect(receiver.mgr.decryptMessage(sender.id, message.payload, message.epoch, message.counter))
        .resolves.toBe(`from ${sender.id}`)
    }
  }
}

describe('room rejoin membership', () => {
  it('keeps remaining connections usable when the old socket leaves after rejoining', async () => {
    const [a, b] = await buildGroup(2)
    const c = await rejoin('c', a.id)
    expect(c.signPub).toBe(b.signPub)
    await addPeer(a, c)
    await addPeer(c, a)
    await addPeer(c, b)
    const commit = await a.mgr.initiateRekey()
    await b.mgr.receiveCommit(commit)
    await c.mgr.receiveWelcome(await a.mgr.generateWelcomeForPeer(c.id))

    expect(() => a.mgr.removePeer(b.id)).not.toThrow()
    expect(() => c.mgr.removePeer(b.id)).not.toThrow()
    await c.mgr.receiveCommit(await a.mgr.initiateRekey())
    expect(a.mgr.getPeerColor(c.id)).toBe(c.mgr.getMyColor())
    expect(c.mgr.getPeerColor(a.id)).toBe(a.mgr.getMyColor())
    await expectMessages([a, c])
  })

  it('assigns the same colors at every connection while an identity overlaps', async () => {
    const [a, b] = await buildGroup(2)
    const c = await rejoin('c', a.id)
    await addPeer(a, c)
    await addPeer(b, c)
    await addPeer(c, a)
    await addPeer(c, b)

    expect(a.mgr.getPeerColor(b.id)).toBe(b.mgr.getMyColor())
    expect(a.mgr.getPeerColor(c.id)).toBe(c.mgr.getMyColor())
    expect(b.mgr.getPeerColor(c.id)).toBe(c.mgr.getMyColor())
    expect(c.mgr.getPeerColor(b.id)).toBe(b.mgr.getMyColor())
  })

  it('ignores a repeated key announcement without resetting message counters or adding a leaf', async () => {
    const [a, b] = await buildGroup(2)
    const replay = await b.mgr.encryptMessage('already delivered')
    await a.mgr.decryptMessage(b.id, replay.payload, replay.epoch, replay.counter)
    await expectMessages([a, b])
    await addPeer(a, b)
    await expect(a.mgr.decryptMessage(b.id, replay.payload, replay.epoch, replay.counter)).rejects.toThrow('already consumed')
    await expectMessages([a, b])
    const welcome = await a.mgr.generateWelcomeForPeer(b.id)
    expect(welcome.numLeaves).toBe(2)
    await b.mgr.receiveCommit(await a.mgr.initiateRekey())
    await expectMessages([a, b])
  })

  it('rejects replacement keys on an existing peer ID without disrupting the session', async () => {
    const [a, b] = await buildGroup(2)
    const replacement = await rejoin(b.id, a.id)
    await expect(addPeer(a, replacement)).rejects.toThrow('Peer keys changed')
    await expectMessages([a, b])
  })

  it('excludes the original creator when a member admitted by welcome takes over', async () => {
    const [a, b, c] = await buildGroup(3)
    b.mgr.removePeer(a.id)
    c.mgr.removePeer(a.id)
    const commit = await b.mgr.initiateRekey()
    await c.mgr.receiveCommit(commit)
    await expect(a.mgr.receiveCommit(commit)).rejects.toThrow()
    await expectMessages([b, c])
  })

  it('keeps a former joiner able to welcome peers across repeated departures and returns', async () => {
    const [a, b, c] = await buildGroup(3)
    for (const member of [b, c]) member.mgr.removePeer(a.id)
    await c.mgr.receiveCommit(await b.mgr.initiateRekey())
    let previous = c

    for (const id of ['d', 'e', 'f']) {
      b.mgr.removePeer(previous.id)
      const returning = await rejoin(id, a.id)
      expect(returning.signPub).toBe(c.signPub)
      await addPeer(b, returning)
      await addPeer(returning, b)
      await b.mgr.initiateRekey()
      await returning.mgr.receiveWelcome(await b.mgr.generateWelcomeForPeer(returning.id))
      await expectMessages([b, returning])
      await b.mgr.receiveCommit(await returning.mgr.initiateRekey(), returning.id)
      await expectMessages([b, returning])
      previous = returning
    }
  })

  it('accepts legacy welcomes and learns rotated leaf ownership from subsequent commits', async () => {
    const [a, b] = await buildGroup(2)
    const c = await rejoin('c', a.id)
    await addPeer(a, c)
    await addPeer(b, c)
    await addPeer(c, a)
    await addPeer(c, b)
    await b.mgr.receiveCommit(await a.mgr.initiateRekey())
    const welcome = await a.mgr.generateWelcomeForPeer(c.id)
    delete welcome.leafPeerIds
    delete welcome.senderPeerId
    delete welcome.signature
    await c.mgr.receiveWelcome(welcome)
    const commit = await a.mgr.initiateRekey()
    await b.mgr.receiveCommit(commit, a.id)
    await c.mgr.receiveCommit(commit, a.id)
    await expectMessages([a, b, c])

    b.mgr.removePeer(a.id)
    c.mgr.removePeer(a.id)
    const removal = await c.mgr.initiateRekey()
    await b.mgr.receiveCommit(removal, c.id)
    await expect(a.mgr.receiveCommit(removal, c.id)).rejects.toThrow()
    await expectMessages([b, c])
  })

  it.each([
    ['a', 'a'],
    ['b', 'b'],
    ['a'],
    ['', 'b']
  ])('rejects tampered welcome membership %j without replacing the working tree', async (...leafPeerIds) => {
    const [a, b] = await buildGroup(2)
    const welcome = await a.mgr.generateWelcomeForPeer(b.id)
    await expect(b.mgr.receiveWelcome({ ...welcome, leafPeerIds })).rejects.toThrow('Invalid tree membership')
    await expectMessages([a, b])
  })

  it('rejects unsigned membership maps without replacing the working tree', async () => {
    const [a, b] = await buildGroup(2)
    const welcome = await a.mgr.generateWelcomeForPeer(b.id)
    delete welcome.signature
    await expect(b.mgr.receiveWelcome(welcome)).rejects.toThrow('Invalid tree membership signature')
    await expectMessages([a, b])
  })

  it('keeps signed welcomes within the relay limit for a full room and repeated rejoins', async () => {
    const ids = Array.from({ length: 16 }, () => crypto.randomUUID()).sort()
    const members = await buildGroup(16, ids)
    for (const sender of members) {
      const commit = await sender.mgr.initiateRekey()
      for (const receiver of members) {
        if (sender !== receiver) await receiver.mgr.receiveCommit(commit, sender.id)
      }
    }

    const leader = members[0]
    async function expectFrameFits(peer: Member): Promise<void> {
      const welcome = await leader.mgr.generateWelcomeForPeer(peer.id)
      const frame = JSON.stringify({ type: 'tree_welcome', target_peer_id: peer.id, tree_welcome: JSON.stringify(welcome) })
      expect(new TextEncoder().encode(frame).length).toBeLessThanOrEqual(65536)
    }
    for (const peer of members.slice(1)) await expectFrameFits(peer)

    for (let attempt = 0; attempt < 4; attempt++) {
      const previous = members.pop()!
      for (const member of members) member.mgr.removePeer(previous.id)
      const returning = await rejoin(crypto.randomUUID(), leader.id)
      for (const member of members) {
        await addPeer(member, returning)
        await addPeer(returning, member)
      }
      const commit = await leader.mgr.initiateRekey()
      for (const member of members.slice(1)) await member.mgr.receiveCommit(commit, leader.id)
      await expectFrameFits(returning)
      await returning.mgr.receiveWelcome(await leader.mgr.generateWelcomeForPeer(returning.id))
      members.push(returning)
    }
    await expectMessages(members)
  }, 20000)
})
