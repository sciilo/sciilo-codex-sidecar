import test from 'node:test'
import assert from 'node:assert/strict'

import { publicCodexNotification } from '../src/bridge.js'

test('never forwards a mirrored user message to the application', () => {
  const visible = publicCodexNotification({
    method: 'item/started',
    params: {
      item: {
        type: 'userMessage',
        content: [{ type: 'inputText', text: 'SERVER-OWNED SCIILO INSTRUCTION' }],
      },
    },
  })

  assert.equal(visible, null)
})

test('reduces collaborator events to a status without forwarding instructions', () => {
  const visible = publicCodexNotification({
    method: 'item/started',
    params: {
      item: {
        id: 'collab-1',
        type: 'collabToolCall',
        tool: 'spawnAgent',
        prompt: 'PRIVATE DELEGATION',
        metadata: { instructions: 'PRIVATE NESTED INSTRUCTION', agentStatus: 'working' },
      },
    },
  })

  assert.deepEqual(visible.params.item, {
    id: 'collab-1',
    type: 'collabToolCall',
    status: undefined,
    tool: 'spawnAgent',
  })
  assert.doesNotMatch(JSON.stringify(visible), /PRIVATE|instructions|agentStatus/)
})

test('keeps terminal commands and their output on the local machine', () => {
  const started = publicCodexNotification({
    method: 'item/started',
    params: {
      item: {
        id: 'command-1',
        type: 'commandExecution',
        command: 'npm test -- --show-secrets',
        cwd: '/private/workspace',
        aggregatedOutput: 'A very large and private terminal transcript',
      },
    },
  })
  const delta = publicCodexNotification({
    method: 'item/commandExecution/outputDelta',
    params: { itemId: 'command-1', delta: 'more private output' },
  })

  assert.deepEqual(started.params.item, {
    id: 'command-1',
    type: 'commandExecution',
    status: undefined,
    activity: 'verify',
    detail: 'tests',
  })
  assert.equal(delta, null)
  assert.doesNotMatch(JSON.stringify(started), /show-secrets|workspace|transcript/)
})

test('does not mistake reading a test file for running the tests', () => {
  const visible = publicCodexNotification({
    method: 'item/started',
    params: {
      item: {
        id: 'command-read-test',
        type: 'commandExecution',
        command: 'sed -n 1,200p src/test/example.test.js',
      },
    },
  })

  assert.equal(visible.params.item.activity, 'inspect')
  assert.equal(visible.params.item.detail, 'files')
})

test('summarizes changed files by name without forwarding paths or diffs', () => {
  const visible = publicCodexNotification({
    method: 'item/completed',
    params: {
      item: {
        id: 'files-1',
        type: 'fileChange',
        changes: [
          { path: '/private/workspace/src/bridge.js', diff: 'PRIVATE DIFF' },
          { path: '/private/workspace/src/home.view.js', diff: 'ANOTHER PRIVATE DIFF' },
        ],
      },
    },
  })

  assert.deepEqual(visible.params.item, {
    id: 'files-1',
    type: 'fileChange',
    status: undefined,
    changeCount: 2,
    files: ['bridge.js', 'home.view.js'],
  })
  assert.doesNotMatch(JSON.stringify(visible), /private|workspace|DIFF/)
})

test('does not forward reasoning, plan or diff payloads', () => {
  for (const frame of [
    { method: 'item/reasoning/summaryTextDelta', params: { delta: 'long reasoning' } },
    { method: 'item/plan/delta', params: { delta: 'long plan' } },
    { method: 'turn/diff/updated', params: { diff: 'large diff' } },
  ]) {
    assert.equal(publicCodexNotification(frame), null)
  }
})

test('keeps tool arguments and results out of the activity summary', () => {
  const visible = publicCodexNotification({
    method: 'item/completed',
    params: {
      item: {
        id: 'tool-1',
        type: 'dynamicToolCall',
        tool: 'patch_diagram',
        arguments: { source: 'PRIVATE DOCUMENT', operations: [{ op: 'add_node' }] },
        contentItems: [{ text: 'PRIVATE RESULT' }],
        success: true,
      },
    },
  })

  assert.deepEqual(visible.params.item, {
    id: 'tool-1',
    type: 'dynamicToolCall',
    status: undefined,
    tool: 'patch_diagram',
    subject: '',
    success: true,
  })
  assert.doesNotMatch(JSON.stringify(visible), /PRIVATE|arguments|contentItems|operations/)
})

test('keeps only a short public subject for a tool activity', () => {
  const visible = publicCodexNotification({
    method: 'item/started',
    params: {
      item: {
        id: 'tool-2',
        type: 'dynamicToolCall',
        tool: 'create_markdown_board',
        arguments: {
          title: 'Release plan',
          markdown: 'PRIVATE DOCUMENT BODY',
        },
      },
    },
  })

  assert.equal(visible.params.item.subject, 'Release plan')
  assert.doesNotMatch(JSON.stringify(visible), /PRIVATE DOCUMENT BODY|"arguments":/)
})
