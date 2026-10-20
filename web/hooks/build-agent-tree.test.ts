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

const statusAgents = () => new Map([
  { ...agent('Main', null, true), state: 'thinking' as const },
  { ...agent('Done parent', 'Main'), state: 'complete' as const },
  { ...agent('Working grandchild', 'Done parent'), state: 'tool_calling' as const },
  { ...agent('Finished leaf', 'Main'), state: 'complete' as const },
  { ...agent('Working parent', 'Main'), state: 'thinking' as const },
  { ...agent('Finished grandchild', 'Working parent'), state: 'complete' as const },
  { ...agent('Approval', 'Main'), state: 'waiting_permission' as const },
  { ...agent('Paused', 'Main'), state: 'paused' as const },
  { ...agent('Error', 'Main'), state: 'error' as const },
].map(item => [item.id, item]))

test('active filter removes finished branches but preserves ancestry and agents needing attention', () => {
  const agents = statusAgents()
  const tree = buildAgentTree(agents, 'active')
  assert.deepEqual(tree.map(node => node.agent.id), ['Main'])
  assert.deepEqual(tree[0].children.map(node => node.agent.id), ['Approval', 'Done parent', 'Error', 'Paused', 'Working parent'])
  assert.deepEqual(tree[0].children[1].children.map(node => node.agent.id), ['Working grandchild'])
  assert.deepEqual(tree[0].children[4].children, [])
  assert.equal(agents.size, 9) // filtering must not delete session/accounting data
})

test('done filter keeps completed descendants under their working parent', () => {
  const tree = buildAgentTree(statusAgents(), 'done')
  assert.deepEqual(tree[0].children.map(node => node.agent.id), ['Done parent', 'Finished leaf', 'Working parent'])
  assert.deepEqual(tree[0].children[0].children, [])
  assert.deepEqual(tree[0].children[2].children.map(node => node.agent.id), ['Finished grandchild'])
})

test('a filter with no matching subagents retains the main-session anchor', () => {
  const agents = new Map([{ ...agent('Main', null, true), state: 'complete' as const },
    { ...agent('Finished', 'Main'), state: 'complete' as const }].map(item => [item.id, item]))
  const tree = buildAgentTree(agents, 'active')
  assert.deepEqual(tree.map(node => node.agent.id), ['Main'])
  assert.deepEqual(tree[0].children, [])
  assert.equal(buildAgentTree(agents, 'all')[0].children.length, 1)
})
