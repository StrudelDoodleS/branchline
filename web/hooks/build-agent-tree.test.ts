// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentTree } from '../lib/agent-tree'

const agent = (id: string, parentId: string | null = null, isMain = false) => ({ id, name: id, parentId, isMain })

test('keeps grandchildren under their actual parent even when they arrive first', () => {
  const agents = [agent('Test runner', 'Implementer'), agent('Reviewer', 'Main'), agent('Implementer', 'Main'), agent('Main', null, true)]
  const tree = buildAgentTree(new Map(agents.map(item => [item.id, item])))
  assert.deepEqual(tree.map(node => node.agent.id), ['Main'])
  assert.deepEqual(tree[0].children.map(node => node.agent.id), ['Implementer', 'Reviewer'])
  assert.deepEqual(tree[0].children[0].children.map(node => node.agent.id), ['Test runner'])
})

test('shows agents with missing parents and breaks cycles without dropping agents', () => {
  const agents = [agent('Main', null, true), agent('Orphan', 'Missing'), agent('Loop A', 'Loop B'), agent('Loop B', 'Loop A'), agent('Self', 'Self')]
  const tree = buildAgentTree(new Map(agents.map(item => [item.id, item])))
  const ids: string[] = []
  const visit = (nodes: typeof tree) => nodes.forEach(node => { ids.push(node.agent.id); visit(node.children) })
  visit(tree)
  assert.deepEqual(ids.slice().sort(), ['Loop A', 'Loop B', 'Main', 'Orphan', 'Self'])
  assert.equal(new Set(ids).size, 5)
  assert.equal(tree[0].agent.id, 'Main')
  assert.deepEqual(buildAgentTree(new Map()), [])
})
