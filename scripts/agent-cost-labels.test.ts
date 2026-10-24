// Branchline fork modifications; see FORK.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentCostLabel } from '../web/lib/cost-agent-label'

test('equal-named agents remain visibly distinct in cost rows and selected chart headings', () => {
  const groups = [{ id: 'a', agentId: 'agent-01234567', agentName: 'Reviewer' },
    { id: 'b', agentId: 'agent-89abcdef', agentName: 'Reviewer' },
    { id: 'c', agentId: 'main', agentName: 'Main session' }]
  assert.notEqual(agentCostLabel(groups[0], groups), agentCostLabel(groups[1], groups))
  assert.ok(agentCostLabel(groups[0], groups).includes('01234567'))
  assert.equal(agentCostLabel(groups[2], groups), 'Main session')
  const collision = [{ id: 'a', agentId: 'first-same-suffix', agentName: 'Reviewer' },
    { id: 'b', agentId: 'second-same-suffix', agentName: 'Reviewer' }]
  assert.notEqual(agentCostLabel(collision[0], collision), agentCostLabel(collision[1], collision))
})
