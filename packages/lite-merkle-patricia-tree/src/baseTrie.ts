// import Semaphore from 'semaphore-async-await'
import { keccak, KECCAK256_RLP } from 'ethereumjs-util'
import { bufferToNibbles, matchingNibbleLength, doKeysMatch } from './util/nibbles'
import {
  TrieNode,
  decodeNode,
  decodeRawNode,
  isRawNode,
  BranchNode,
  ExtensionNode,
  LeafNode,
  EmbeddedNode,
  Nibbles
} from './trieNode'

type BatchDBOp = PutBatch | DelBatch

interface PutBatch {
  type: 'put'
  key: Buffer
  value: Buffer
}

interface DelBatch {
  type: 'del'
  key: Buffer
}

/**
 * DB is a wrapper around the underlying in memory Map db.
 * It is a replacement for leveldb or memdown used in https://github.com/ethereumjs/ethereumjs-monorepo/blob/master/packages/trie/src/db.ts
 */
class DB {
  _db: Map<string, Buffer>

  /**
   * Initialize a DB instance.
   */
  constructor () {
    this._db = new Map()
  }

  /**
   * Retrieves a raw value from db.
   * @param key
   * @returns `Buffer` if a value is found or `undefined` if no value is found.
   */
  get (key: Buffer): Buffer | undefined {
    const value = this._db.get(key.toString('hex'))
    return value
  }

  /**
   * Writes a value directly to db.
   * @param key The key as a `Buffer`
   * @param value The value `Buffer` to be stored
   */
  put (key: Buffer, val: Buffer): void {
    this._db.set(key.toString('hex'), val)
  }

  /**
   * Removes a raw value in the underlying db.
   * @param keys
   */
  del (key: Buffer): void {
    this._db.delete(key.toString('hex'))
  }

  /**
   * Performs a batch operation on db.
   * @param opStack A stack of operations
   */
  batch (opStack: BatchDBOp[]): void {
    // console.log('batch db: ', opStack)
    opStack.forEach(op => {
      if (op.type === 'put') {
        this.put(op.key, op.value)
      } else if (op.type === 'del') {
        this.del(op.key)
      }
    })
  }
}

export type Proof = Buffer[]

interface Path {
  node: TrieNode | null
  remaining: Nibbles
  stack: TrieNode[]
}

/**
 * The basic Trie interface, use with `import { Trie } from './merkle-patricia-tree'`.
 * Light weight and synchronous implementation of the Ethereum modified Merkle Patricia Tree.
 * Most of the core logic is taken from `https://github.com/ethereumjs/ethereumjs-monorepo`.
 * Replaces database and async logic with a simple Map to temporarily store trie nodes.
 * This implementation is for one time use cases: put serialized BlockReceipts
 * in the Trie and build an inclusion proof with `findPath`.
 */
export class Trie {
  /** The key value Map storing Trie nodes */
  db: DB
  /** The root for an empty trie */
  EMPTY_TRIE_ROOT: Buffer
  private _root: Buffer
  // protected lock: Semaphore

  /**
   * Initialize a Trie instance
   */
  constructor () {
    this.EMPTY_TRIE_ROOT = KECCAK256_RLP
    // this.lock = new Semaphore(1)
    this.db = new DB()
    this._root = this.EMPTY_TRIE_ROOT
  }

  /**
   * Gets the current root of the `trie`
   */
  get root (): Buffer {
    return this._root
  }

  /**
   * Trie has no checkpointing so return false
   */
  get isCheckpoint (): Boolean {
    return false
  }

  /**
   * Gets a value given a `key`
   * @param key - the key to search for
   * @returns `Buffer` if a value was found or `null` if no value was found.
   */
  get (key: Buffer): Buffer | null {
    const { node, remaining } = this.findPath(key)
    let value: Buffer | null = null
    if (node && remaining.length === 0) {
      value = node.value
    }
    return value
  }

  /**
   * Stores a given `value` at the given `key`.
   * @param key
   * @param value
   */
  put (key: Buffer, value: Buffer): void {
    // If value is empty, delete
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!value || value.toString() === '') {
      return this.del(key)
    }

    // await this.lock.wait()
    if (this.root.equals(KECCAK256_RLP)) {
      // If no root, initialize this trie
      this._createInitialNode(key, value)
    } else {
      // First try to find the given key or its nearest node
      const { remaining, stack } = this.findPath(key)
      // console.log('put! ', remaining, stack.slice())
      // then update
      this._updateNode(key, value, remaining, stack)
    }
    // this.lock.signal()
  }

  /**
   * Deletes a value given a `key`.
   * @param key
   */
  del (key: Buffer): void {
    // await this.lock.wait()
    const { node, stack } = this.findPath(key)
    if (node) {
      this._deleteNode(key, stack)
    }
    // this.lock.signal()
  }

  /**
   * Retrieves a node from db by hash.
   */
  lookupNode (node: Buffer | Buffer[]): TrieNode | null {
    if (isRawNode(node)) {
      return decodeRawNode(node as Buffer[])
    }
    let foundNode: null | TrieNode = null
    const value = this.db.get(node as Buffer)

    if (value !== undefined) {
      foundNode = decodeNode(value)
    }
    return foundNode
  }

  /**
   * Tries to find a path to the node for the given key.
   * It returns a `stack` of nodes to the closest node.
   * @param key - the search key
   */
  findPath (key: Buffer): Path {
    // eslint-disable-next-line no-async-promise-executor
    const stack: TrieNode[] = []
    const targetKey = bufferToNibbles(key)

    const onFound = (nodeHash: Buffer, keyProgress: Nibbles): any => {
      // console.log('keyProgress: ', keyProgress)
      const keyRemainder = targetKey.slice(matchingNibbleLength(keyProgress, targetKey))
      const node = this.lookupNode(nodeHash)
      if (node === null) {
        return
      }
      stack.push(node)

      if (node instanceof BranchNode) {
        if (keyRemainder.length === 0) {
          // we exhausted the key without finding a node
          return { node, remaining: [], stack }
        } else {
          const branchIndex = keyRemainder[0]
          const childRef = node.getBranch(branchIndex)
          if (!childRef) {
            // there are no more nodes to find and we didn't find the key
            return { node: null, remaining: keyRemainder, stack }
          } else {
            // node found, continuing search
            const childKey = keyProgress.slice() // This copies the key to a new array.
            childKey.push(branchIndex)
            // walkController.onlyBranchIndex(node, keyProgress, branchIndex)
            return onFound(childRef as Buffer, childKey)
          }
        }
      } else if (node instanceof LeafNode) {
        if (doKeysMatch(keyRemainder, node.key)) {
          // keys match, return node with empty key
          return { node, remaining: [], stack }
        } else {
          // reached leaf but keys dont match
          return { node: null, remaining: keyRemainder, stack }
        }
      } else if (node instanceof ExtensionNode) {
        const matchingLen = matchingNibbleLength(keyRemainder, node.key)
        if (matchingLen !== node.key.length) {
          // keys don't match, fail
          return { node: null, remaining: keyRemainder, stack }
        } else {
          // keys match, continue search
          // walkController.allChildren(node, keyProgress)
          const keyExtension = node.key
          const childKey = keyProgress.concat(keyExtension)
          const childRef = node.value
          return onFound(childRef, childKey)
        }
      }
    }
    // console.log('start root: ', this._root.toString('hex'))

    // walk trie and process nodes
    return onFound(this._root, [])
    // await this.walkTrie(this._root, onFound)

    // Resolve if _walkTrie finishes without finding any nodes
    // resolve({ node: null, remaining: [], stack })
  }

  /**
   * Creates the initial node from an empty tree.
   * @private
   */
  _createInitialNode (key: Buffer, value: Buffer): void {
    const newNode = new LeafNode(bufferToNibbles(key), value)
    this._root = newNode.hash()
    this.db.put(this.root, newNode.serialize())
  }

  /**
   * Updates a node.
   * @private
   * @param key
   * @param value
   * @param keyRemainder
   * @param stack
   */
  _updateNode (
    k: Buffer,
    value: Buffer,
    keyRemainder: Nibbles,
    stack: TrieNode[]
  ): void {
    const toSave: BatchDBOp[] = []
    const lastNode = stack.pop()
    if (lastNode === undefined) {
      throw new Error('Stack underflow')
    }

    // add the new nodes
    const key = bufferToNibbles(k)

    // Check if the last node is a leaf and the key matches to this
    let matchLeaf = false

    if (lastNode instanceof LeafNode) {
      let l = 0
      for (let i = 0; i < stack.length; i++) {
        const n = stack[i]
        if (n instanceof BranchNode) {
          l++
        } else {
          l += n.key.length
        }
      }

      if (
        matchingNibbleLength(lastNode.key, key.slice(l)) === lastNode.key.length &&
        keyRemainder.length === 0
      ) {
        matchLeaf = true
      }
    }

    if (matchLeaf) {
      // just updating a found value
      lastNode.value = value
      stack.push(lastNode)
    } else if (lastNode instanceof BranchNode) {
      stack.push(lastNode)
      if (keyRemainder.length !== 0) {
        // add an extension to a branch node
        keyRemainder.shift()
        // create a new leaf
        const newLeaf = new LeafNode(keyRemainder, value)
        stack.push(newLeaf)
      } else {
        lastNode.value = value
      }
    } else {
      // console.log('inserting new leaf')
      // create a branch node
      const lastKey = lastNode.key
      const matchingLength = matchingNibbleLength(lastKey, keyRemainder)
      const newBranchNode = new BranchNode()

      // create a new extension node
      if (matchingLength !== 0) {
        // console.log('creating extention node, matching key length: ', matchingLength)
        const newKey = lastNode.key.slice(0, matchingLength)
        const newExtNode = new ExtensionNode(newKey, value)
        stack.push(newExtNode)
        lastKey.splice(0, matchingLength)
        keyRemainder.splice(0, matchingLength)
      }

      stack.push(newBranchNode)

      if (lastKey.length !== 0) {
        const branchKey = lastKey.shift()!

        if (lastKey.length !== 0 || lastNode instanceof LeafNode) {
          // shrinking extension or leaf
          lastNode.key = lastKey
          const formattedNode = this._formatNode(lastNode, false, toSave)
          newBranchNode.setBranch(branchKey, formattedNode as EmbeddedNode)
        } else {
          // remove extension or attaching
          this._formatNode(lastNode, false, toSave, true)
          newBranchNode.setBranch(branchKey, lastNode.value)
        }
      } else {
        newBranchNode.value = lastNode.value
      }

      if (keyRemainder.length !== 0) {
        keyRemainder.shift()
        // add a leaf node to the new branch node
        const newLeafNode = new LeafNode(keyRemainder, value)
        stack.push(newLeafNode)
      } else {
        newBranchNode.value = value
      }
    }
    // console.log('toSave: ', toSave.slice())

    this._saveStack(key, stack, toSave)
  }

  /**
   * Deletes a node from the database.
   * @private
   */
  _deleteNode (k: Buffer, stack: TrieNode[]): void {
    const processBranchNode = (
      key: Nibbles,
      branchKey: number,
      branchNode: TrieNode,
      parentNode: TrieNode,
      stack: TrieNode[]
    ): number[] => {
      // branchNode is the node ON the branch node not THE branch node
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!parentNode || parentNode instanceof BranchNode) {
        // branch->?
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (parentNode) {
          stack.push(parentNode)
        }

        if (branchNode instanceof BranchNode) {
          // create an extension node
          // branch->extension->branch
          const extensionNode = new ExtensionNode([branchKey], null)
          stack.push(extensionNode)
          key.push(branchKey)
        } else {
          const branchNodeKey = branchNode.key
          // branch key is an extension or a leaf
          // branch->(leaf or extension)
          branchNodeKey.unshift(branchKey)
          branchNode.key = branchNodeKey.slice(0)
          key = key.concat(branchNodeKey)
        }
        stack.push(branchNode)
      } else {
        // parent is an extension
        let parentKey = parentNode.key

        if (branchNode instanceof BranchNode) {
          // ext->branch
          parentKey.push(branchKey)
          key.push(branchKey)
          parentNode.key = parentKey
          stack.push(parentNode)
        } else {
          const branchNodeKey = branchNode.key
          // branch node is an leaf or extension and parent node is an exstention
          // add two keys together
          // dont push the parent node
          branchNodeKey.unshift(branchKey)
          key = key.concat(branchNodeKey)
          parentKey = parentKey.concat(branchNodeKey)
          branchNode.key = parentKey
        }

        stack.push(branchNode)
      }

      return key
    }

    let lastNode = stack.pop()!
    let parentNode = stack.pop()
    const opStack: BatchDBOp[] = []

    let key = bufferToNibbles(k)

    if (parentNode === undefined) {
      // the root here has to be a leaf.
      this._root = this.EMPTY_TRIE_ROOT
      return
    }

    if (lastNode instanceof BranchNode) {
      lastNode.value = null
    } else {
      // the lastNode has to be a leaf if it's not a branch.
      // And a leaf's parent, if it has one, must be a branch.
      if (!(parentNode instanceof BranchNode)) {
        throw new Error('Expected branch node')
      }
      const lastNodeKey = lastNode.key
      key.splice(key.length - lastNodeKey.length)
      // delete the value
      this._formatNode(lastNode, false, opStack, true)
      parentNode.setBranch(key.pop(), null)
      lastNode = parentNode
      parentNode = stack.pop()
    }

    // nodes on the branch
    // count the number of nodes on the branch
    const branchNodes: Array<[number, EmbeddedNode]> = lastNode.getChildren()

    // if there is only one branch node left, collapse the branch node
    if (branchNodes.length === 1) {
      // add the one remaing branch node to node above it
      const branchNode = branchNodes[0][1]
      const branchNodeKey = branchNodes[0][0]

      // look up node
      const foundNode = this.lookupNode(branchNode)
      if (foundNode) {
        key = processBranchNode(
          key,
          branchNodeKey,
          foundNode,
          parentNode,
          stack
        )
        this._saveStack(key, stack, opStack)
      }
    } else {
      // simple removing a leaf and recaluclation the stack
      if (parentNode) {
        stack.push(parentNode)
      }

      stack.push(lastNode)
      this._saveStack(key, stack, opStack)
    }
  }

  /**
   * Saves a stack of nodes to the database.
   * @private
   * @param key - the key. Should follow the stack
   * @param stack - a stack of nodes to the value given by the key
   * @param opStack - a stack of levelup operations to commit at the end of this funciton
   */
  _saveStack (key: Nibbles, stack: TrieNode[], opStack: BatchDBOp[]): void {
    let lastRoot

    // update nodes
    while (stack.length) {
      const node = stack.pop()!
      if (node instanceof LeafNode) {
        key.splice(key.length - node.key.length)
      } else if (node instanceof ExtensionNode) {
        key.splice(key.length - node.key.length)
        if (lastRoot) {
          node.value = lastRoot
        }
      } else if (node instanceof BranchNode) {
        if (lastRoot) {
          const branchKey = key.pop()!
          node.setBranch(branchKey, lastRoot)
        }
      }
      lastRoot = this._formatNode(node, stack.length === 0, opStack) as Buffer
    }

    if (lastRoot) {
      // console.log('save root', lastRoot.toString('hex'))
      this._root = lastRoot
    }

    this.db.batch(opStack)
  }

  /**
   * Formats node to be saved by `db.batch`.
   * @private
   * @param node - the node to format.
   * @param topLevel - if the node is at the top level.
   * @param opStack - the opStack to push the node's data.
   * @param remove - whether to remove the node (only used for CheckpointTrie).
   * @returns The node's hash used as the key or the rawNode.
   */
  _formatNode (
    node: TrieNode,
    topLevel: boolean,
    opStack: BatchDBOp[],
    remove: boolean = false
  ): Buffer | Array<EmbeddedNode | null> {
    const rlpNode = node.serialize()

    if (rlpNode.length >= 32 || topLevel) {
      // Do not use TrieNode.hash() here otherwise serialize()
      // is applied twice (performance)
      const hashRoot = keccak(rlpNode)

      if (remove && this.isCheckpoint) {
        opStack.push({
          type: 'del',
          key: hashRoot
        })
      } else {
        opStack.push({
          type: 'put',
          key: hashRoot,
          value: rlpNode
        })
      }

      return hashRoot
    }

    return node.raw()
  }
}
