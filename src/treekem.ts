import {
  mlKemEncapsulate,
  mlKemDecapsulate,
  deriveKemKey,
  encrypt,
  decrypt,
  uint8ArrayToBase64,
  base64ToUint8Array,
  generateMlKemKeyPair,
  type MlKemKeyPair
} from './crypto'

const TREE_NODE_INFO = new TextEncoder().encode('parrhesia-tree-node')
const TREE_ROOT_INFO = new TextEncoder().encode('parrhesia-tree-root')
const HKDF_SALT = new Uint8Array(32)

export interface TreeNode {
  publicKey: Uint8Array | null
  secretKey: Uint8Array | null
  secret: Uint8Array | null
}

export interface TreeKemPathEntry {
  nodeIndex: number
  newPublicKey: string
  mlKemCiphertext: string
  encryptedSecret: string
}

export interface TreeKemCommit {
  committerLeafPos: number
  leafPublicKey: string
  path: TreeKemPathEntry[]
  epoch: number
}

export interface TreeKemWelcome {
  treePublicKeys: (string | null)[]
  numLeaves: number
  myLeafPos: number
  pathSecrets: TreeKemPathEntry[]
  epoch: number
}

export function nodeLevel(index: number): number {
  let level = 0
  let x = index
  while ((x & 1) === 1) {
    x >>= 1
    level++
  }
  return level
}

export function isLeaf(index: number): boolean {
  return index % 2 === 0
}

export function leftChild(index: number): number {
  const level = nodeLevel(index)
  if (level === 0) throw new Error('Leaves have no children')
  return index - (1 << (level - 1))
}

export function rightChild(index: number): number {
  const level = nodeLevel(index)
  if (level === 0) throw new Error('Leaves have no children')
  return index + (1 << (level - 1))
}

export function parent(index: number, numLeaves: number): number {
  if (index === root(numLeaves)) throw new Error('Root has no parent')
  const level = nodeLevel(index)
  const isLeft = ((index >> (level + 1)) & 1) === 0
  if (isLeft) {
    return index + (1 << level)
  }
  return index - (1 << level)
}

function treeWidth(numLeaves: number): number {
  if (numLeaves === 0) return 0
  return 2 * (numLeaves - 1) + 1
}

export function root(numLeaves: number): number {
  const width = treeWidth(numLeaves)
  let idx = (1 << log2(width)) - 1
  while (idx >= width) {
    idx = leftChild(idx)
  }
  return idx
}

function log2(x: number): number {
  if (x === 0) return 0
  let result = 0
  let val = x
  while (val > 1) {
    val >>= 1
    result++
  }
  return result
}

export function sibling(index: number, numLeaves: number): number {
  const p = parent(index, numLeaves)
  const l = leftChild(p)
  if (index === l) return rightChild(p)
  return l
}

export function directPath(leafIndex: number, numLeaves: number): number[] {
  const nodeIdx = 2 * leafIndex
  const r = root(numLeaves)
  if (nodeIdx === r) return []
  const path: number[] = []
  let current = nodeIdx
  while (current !== r) {
    current = parent(current, numLeaves)
    path.push(current)
  }
  return path
}

export function copath(leafIndex: number, numLeaves: number): number[] {
  const nodeIdx = 2 * leafIndex
  const r = root(numLeaves)
  if (nodeIdx === r) return []
  const result: number[] = []
  let current = nodeIdx
  while (current !== r) {
    result.push(sibling(current, numLeaves))
    current = parent(current, numLeaves)
  }
  return result
}

async function deriveNodeSecret(childSecret: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    childSecret as BufferSource,
    'HKDF',
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', salt: HKDF_SALT as BufferSource, info: TREE_NODE_INFO as BufferSource, hash: 'SHA-256' },
    keyMaterial,
    256
  )
  return new Uint8Array(bits)
}

export async function deriveRootGroupKey(rootSecret: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    rootSecret as BufferSource,
    'HKDF',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', salt: HKDF_SALT as BufferSource, info: TREE_ROOT_INFO as BufferSource, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
}

async function encryptToNode(secret: Uint8Array, recipientPub: Uint8Array): Promise<{ mlKemCiphertext: string; encryptedSecret: string }> {
  const { ciphertext, sharedSecret } = await mlKemEncapsulate(recipientPub)
  const kemKey = await deriveKemKey(sharedSecret)
  const secretB64 = uint8ArrayToBase64(secret)
  const encryptedSecret = await encrypt(kemKey, secretB64)
  return {
    mlKemCiphertext: uint8ArrayToBase64(ciphertext),
    encryptedSecret
  }
}

async function decryptFromNode(mlKemCt: string, encryptedSecret: string, mySecretKey: Uint8Array): Promise<Uint8Array> {
  const ct = base64ToUint8Array(mlKemCt)
  const ss = await mlKemDecapsulate(ct, mySecretKey)
  const kemKey = await deriveKemKey(ss)
  const secretB64 = await decrypt(kemKey, encryptedSecret)
  return base64ToUint8Array(secretB64)
}

function ensureNode(nodes: (TreeNode | null)[], index: number): TreeNode {
  while (nodes.length <= index) nodes.push(null)
  if (!nodes[index]) {
    nodes[index] = { publicKey: null, secretKey: null, secret: null }
  }
  return nodes[index]!
}

function blankNode(nodes: (TreeNode | null)[], index: number): void {
  if (index < nodes.length && nodes[index]) {
    nodes[index] = { publicKey: null, secretKey: null, secret: null }
  }
}

export class TreeKemState {
  nodes: (TreeNode | null)[] = []
  numLeaves: number = 0
  myLeafPos: number = 0

  static createForCreator(mlKemPub: Uint8Array, mlKemSk: Uint8Array): TreeKemState {
    const state = new TreeKemState()
    state.numLeaves = 1
    state.myLeafPos = 0
    const node = ensureNode(state.nodes, 0)
    node.publicKey = mlKemPub
    node.secretKey = mlKemSk
    node.secret = crypto.getRandomValues(new Uint8Array(32))
    return state
  }

  addLeaf(mlKemPublicKey: Uint8Array): number {
    const leafPos = this.numLeaves
    this.numLeaves++
    const nodeIdx = 2 * leafPos
    const node = ensureNode(this.nodes, nodeIdx)
    node.publicKey = mlKemPublicKey
    node.secretKey = null
    node.secret = null
    const dp = directPath(leafPos, this.numLeaves)
    for (const idx of dp) {
      blankNode(this.nodes, idx)
    }
    const oldDp = directPath(this.myLeafPos, this.numLeaves)
    for (const idx of oldDp) {
      ensureNode(this.nodes, idx)
    }
    return leafPos
  }

  removeLeaf(leafPos: number): void {
    const nodeIdx = 2 * leafPos
    blankNode(this.nodes, nodeIdx)
    if (this.numLeaves <= 1) return
    const dp = directPath(leafPos, this.numLeaves)
    for (const idx of dp) {
      blankNode(this.nodes, idx)
    }
  }

  async generateCommit(): Promise<TreeKemCommit> {
    const leafNodeIdx = 2 * this.myLeafPos
    const leafSecret = crypto.getRandomValues(new Uint8Array(32))
    const leafNode = ensureNode(this.nodes, leafNodeIdx)
    leafNode.secret = leafSecret

    const newLeafKp = await generateMlKemKeyPair()
    leafNode.publicKey = newLeafKp.publicKey
    leafNode.secretKey = newLeafKp.secretKey

    const dp = directPath(this.myLeafPos, this.numLeaves)
    const cp = copath(this.myLeafPos, this.numLeaves)

    let currentSecret: Uint8Array = leafSecret
    const pathEntries: TreeKemPathEntry[] = []

    for (let i = 0; i < dp.length; i++) {
      const pathNodeIdx = dp[i]
      const copathNodeIdx = cp[i]

      currentSecret = await deriveNodeSecret(currentSecret)
      const pathNode = ensureNode(this.nodes, pathNodeIdx)
      pathNode.secret = currentSecret

      const kp = await generateMlKemKeyPair()
      pathNode.publicKey = kp.publicKey
      pathNode.secretKey = kp.secretKey

      const copathNode = this.resolveNode(copathNodeIdx)
      if (copathNode && copathNode.publicKey) {
        const { mlKemCiphertext, encryptedSecret } = await encryptToNode(currentSecret, copathNode.publicKey)
        pathEntries.push({
          nodeIndex: pathNodeIdx,
          newPublicKey: uint8ArrayToBase64(kp.publicKey),
          mlKemCiphertext,
          encryptedSecret
        })
      } else {
        pathEntries.push({
          nodeIndex: pathNodeIdx,
          newPublicKey: uint8ArrayToBase64(kp.publicKey),
          mlKemCiphertext: '',
          encryptedSecret: ''
        })
      }
    }

    return {
      committerLeafPos: this.myLeafPos,
      leafPublicKey: uint8ArrayToBase64(newLeafKp.publicKey),
      path: pathEntries,
      epoch: 0
    }
  }

  private resolveNode(nodeIdx: number): TreeNode | null {
    if (nodeIdx >= this.nodes.length) return null
    const node = this.nodes[nodeIdx]
    if (!node) return null
    if (node.publicKey) return node
    if (!isLeaf(nodeIdx)) {
      const level = nodeLevel(nodeIdx)
      if (level > 0) {
        const left = leftChild(nodeIdx)
        const right = rightChild(nodeIdx)
        const leftNode = this.resolveNode(left)
        if (leftNode) return leftNode
        return this.resolveNode(right)
      }
    }
    return null
  }

  async processCommit(commit: TreeKemCommit): Promise<Uint8Array> {
    const committerLeafNode = 2 * commit.committerLeafPos
    const cNode = ensureNode(this.nodes, committerLeafNode)
    cNode.publicKey = base64ToUint8Array(commit.leafPublicKey)
    cNode.secretKey = null
    cNode.secret = null

    for (const entry of commit.path) {
      const node = ensureNode(this.nodes, entry.nodeIndex)
      node.publicKey = base64ToUint8Array(entry.newPublicKey)
      node.secretKey = null
      node.secret = null
    }

    const myDp = directPath(this.myLeafPos, this.numLeaves)
    const myCp = copath(this.myLeafPos, this.numLeaves)
    const committerDp = directPath(commit.committerLeafPos, this.numLeaves)

    let decryptedSecret: Uint8Array | null = null
    let startIdx = -1

    for (let i = 0; i < myCp.length; i++) {
      const myCopathNode = myCp[i]
      const committerPathIdx = committerDp.indexOf(myCopathNode)
      if (committerPathIdx !== -1) {
        continue
      }

      const myPathNode = myDp[i]
      const matchingEntry = commit.path.find(e => e.nodeIndex === myPathNode)
      if (matchingEntry && matchingEntry.mlKemCiphertext) {
        const myNode = this.findDecryptionNode(myCp[i])
        if (myNode && myNode.secretKey) {
          decryptedSecret = await decryptFromNode(
            matchingEntry.mlKemCiphertext,
            matchingEntry.encryptedSecret,
            myNode.secretKey
          )
          startIdx = i
          break
        }
      }
    }

    if (!decryptedSecret || startIdx < 0) {
      for (let i = 0; i < myDp.length; i++) {
        const matchingEntry = commit.path.find(e => e.nodeIndex === myDp[i])
        if (matchingEntry && matchingEntry.mlKemCiphertext) {
          const myCopathNodeIdx = myCp[i]
          const myNode = this.findDecryptionNode(myCopathNodeIdx)
          if (myNode && myNode.secretKey) {
            decryptedSecret = await decryptFromNode(
              matchingEntry.mlKemCiphertext,
              matchingEntry.encryptedSecret,
              myNode.secretKey
            )
            startIdx = i
            break
          }
        }
      }
    }

    if (!decryptedSecret || startIdx < 0) {
      throw new Error('Could not decrypt any path node in commit')
    }

    const pathNode = ensureNode(this.nodes, myDp[startIdx])
    pathNode.secret = decryptedSecret

    let currentSecret: Uint8Array = decryptedSecret
    for (let i = startIdx + 1; i < myDp.length; i++) {
      currentSecret = await deriveNodeSecret(currentSecret)
      const node = ensureNode(this.nodes, myDp[i])
      node.secret = currentSecret
    }

    const r = root(this.numLeaves)
    const rootNode = ensureNode(this.nodes, r)
    if (!rootNode.secret) throw new Error('Failed to derive root secret')
    return rootNode.secret
  }

  private findDecryptionNode(nodeIdx: number): TreeNode | null {
    if (nodeIdx >= this.nodes.length) return null
    const node = this.nodes[nodeIdx]
    if (node && node.secretKey) return node
    if (!isLeaf(nodeIdx) && nodeLevel(nodeIdx) > 0) {
      const l = leftChild(nodeIdx)
      const r = rightChild(nodeIdx)
      const leftResult = this.findDecryptionNode(l)
      if (leftResult) return leftResult
      return this.findDecryptionNode(r)
    }
    return null
  }

  async generateWelcome(joinerLeafPos: number, peerMlKemPub: Uint8Array, epoch: number): Promise<TreeKemWelcome> {
    const treePublicKeys: (string | null)[] = []
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i]
      if (node && node.publicKey) {
        treePublicKeys.push(uint8ArrayToBase64(node.publicKey))
      } else {
        treePublicKeys.push(null)
      }
    }

    treePublicKeys[2 * joinerLeafPos] = uint8ArrayToBase64(peerMlKemPub)

    const dp = directPath(joinerLeafPos, this.numLeaves)
    const pathSecrets: TreeKemPathEntry[] = []

    for (const nodeIdx of dp) {
      const node = this.nodes[nodeIdx]
      if (node && node.secret) {
        const { mlKemCiphertext, encryptedSecret } = await encryptToNode(node.secret, peerMlKemPub)
        pathSecrets.push({
          nodeIndex: nodeIdx,
          newPublicKey: node.publicKey ? uint8ArrayToBase64(node.publicKey) : '',
          mlKemCiphertext,
          encryptedSecret
        })
        break
      }
    }

    return {
      treePublicKeys,
      numLeaves: this.numLeaves,
      myLeafPos: joinerLeafPos,
      pathSecrets,
      epoch
    }
  }

  static async fromWelcome(welcome: TreeKemWelcome, myMlKemKeyPair: MlKemKeyPair): Promise<TreeKemState> {
    const state = new TreeKemState()
    state.numLeaves = welcome.numLeaves
    state.myLeafPos = welcome.myLeafPos

    for (let i = 0; i < welcome.treePublicKeys.length; i++) {
      const pk = welcome.treePublicKeys[i]
      if (pk) {
        const node = ensureNode(state.nodes, i)
        node.publicKey = base64ToUint8Array(pk)
      }
    }

    const myNodeIdx = 2 * state.myLeafPos
    const myNode = ensureNode(state.nodes, myNodeIdx)
    myNode.publicKey = myMlKemKeyPair.publicKey
    myNode.secretKey = myMlKemKeyPair.secretKey

    if (welcome.pathSecrets.length > 0) {
      const entry = welcome.pathSecrets[0]
      const decryptedSecret = await decryptFromNode(
        entry.mlKemCiphertext,
        entry.encryptedSecret,
        myMlKemKeyPair.secretKey
      )

      const dp = directPath(state.myLeafPos, state.numLeaves)
      const entryDpIdx = dp.indexOf(entry.nodeIndex)
      if (entryDpIdx >= 0) {
        const node = ensureNode(state.nodes, entry.nodeIndex)
        node.secret = decryptedSecret

        let currentSecret: Uint8Array = decryptedSecret
        for (let i = entryDpIdx + 1; i < dp.length; i++) {
          currentSecret = await deriveNodeSecret(currentSecret)
          const pathNode = ensureNode(state.nodes, dp[i])
          pathNode.secret = currentSecret
        }
      }
    }

    return state
  }

  getRootSecret(): Uint8Array {
    const r = root(this.numLeaves)
    const rootNode = this.nodes[r]
    if (!rootNode || !rootNode.secret) {
      const myNodeIdx = 2 * this.myLeafPos
      const myNode = this.nodes[myNodeIdx]
      if (myNode && myNode.secret) return myNode.secret
      throw new Error('No root secret available')
    }
    return rootNode.secret
  }
}
