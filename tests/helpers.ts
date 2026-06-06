import { GroupKeyManager } from '../src/crypto/crypto'

const PEER_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

export interface Member {
  id: string
  mgr: GroupKeyManager
  signPub: string
  pqPub: string
  sig: string
}

export function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('parrhesia')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

export async function resetStorage(): Promise<void> {
  localStorage.clear()
  await deleteDb()
}

async function makeMember(id: string, isCreator: boolean, creatorId: string): Promise<Member> {
  await resetStorage()
  const mgr = new GroupKeyManager()
  const signPub = await mgr.initialize()
  mgr.setCreatorStatus(isCreator, creatorId, id)
  const pqPub = mgr.getMlKemPublicKeyBase64()
  const sig = mgr.signMlKemPublicKey()
  if (!pqPub || !sig) throw new Error('member init failed')
  return { id, mgr, signPub, pqPub, sig }
}

export async function buildGroup(n: number): Promise<Member[]> {
  const ids = PEER_IDS.slice(0, n)
  const creatorId = ids[0]
  const creator = await makeMember(creatorId, true, creatorId)
  await creator.mgr.generateAndSetGroupKey()
  const members: Member[] = [creator]

  for (let j = 1; j < n; j++) {
    const joiner = await makeMember(ids[j], false, creatorId)

    for (const m of members) {
      await m.mgr.addPeer(joiner.id, joiner.signPub, joiner.pqPub, joiner.sig)
    }
    for (const m of members) {
      await joiner.mgr.addPeer(m.id, m.signPub, m.pqPub, m.sig)
    }

    const committer = members.reduce((a, b) => (a.id < b.id ? a : b))
    const commit = await committer.mgr.initiateRekey()
    for (const m of members) {
      if (m.id === committer.id) continue
      await m.mgr.receiveCommit(commit)
    }
    const welcome = await committer.mgr.generateWelcomeForPeer(joiner.id)
    await joiner.mgr.receiveWelcome(welcome)

    members.push(joiner)
  }

  return members
}
