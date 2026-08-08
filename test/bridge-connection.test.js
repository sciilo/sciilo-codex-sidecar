import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { SidecarBridge } from '../src/bridge.js'

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances = []

  constructor(url, options) {
    super()
    this.url = url
    this.options = options
    this.readyState = FakeWebSocket.CONNECTING
    this.sent = []
    FakeWebSocket.instances.push(this)
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open')
  }

  message(frame) {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }

  send(payload) {
    this.sent.push(JSON.parse(payload))
  }

  close(code = 1000, reason = '') {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', code, Buffer.from(reason))
  }

  terminate() {
    this.close(1006, 'heartbeat_timeout')
  }
}

const config = {
  appUrl: 'https://app.sciilo.test',
  connectionKey: 'secret',
  workspace: '/workspace/product',
}

test('uses one bounded transport and becomes ready only after the welcome handshake', () => {
  FakeWebSocket.instances.length = 0
  const bridge = new SidecarBridge(config, {
    WebSocketClass: FakeWebSocket,
    codex: { stop() {} },
  })
  let connected = 0
  bridge.on('connected', () => { connected++ })

  try {
    bridge.connect()
    bridge.connect()
    assert.equal(FakeWebSocket.instances.length, 1,
      'parallel connection attempts must share the active transport')

    const socket = FakeWebSocket.instances[0]
    assert.equal(socket.options.handshakeTimeout, 10_000)
    socket.open()
    assert.equal(bridge.ready, false)
    assert.notEqual(bridge.handshakeTimer, null)

    socket.message({
      type: 'sidecar.welcome',
      protocol: 'sciilo.sidecar.v1',
      tools: [{ name: 'list_documents' }],
    })

    assert.equal(bridge.ready, true)
    assert.equal(bridge.handshakeTimer, null)
    assert.equal(connected, 1)
    assert.equal(socket.sent.at(-1).type, 'sidecar.ready')
    assert.equal(socket.sent.at(-1).instanceId, bridge.instanceId)

    socket.close()
    assert.equal(bridge.ready, false)
  } finally {
    bridge.stop()
  }
})

test('any application frame acknowledges the sidecar heartbeat', () => {
  FakeWebSocket.instances.length = 0
  const bridge = new SidecarBridge(config, {
    WebSocketClass: FakeWebSocket,
    codex: { stop() {} },
  })
  try {
    bridge.connect()
    const socket = FakeWebSocket.instances[0]
    socket.open()
    bridge.heartbeatTimeout = setTimeout(() => {}, 60_000)

    socket.message({ type: 'pong' })

    assert.equal(bridge.heartbeatTimeout, null)
  } finally {
    bridge.stop()
  }
})

test('passes server-owned instructions through without owning a prompt', async () => {
  const requests = []
  const bridge = new SidecarBridge(config, {
    WebSocketClass: FakeWebSocket,
    codex: {
      stop() {},
      async request(method, parameters) {
        requests.push({ method, parameters })
        if (method === 'thread/start') return { thread: { id: 'thread-server-policy' } }
        return { turn: { id: 'turn-server-policy' } }
      },
    },
  })
  bridge.ready = true

  await bridge.startTurn({
    requestId: 'request-server-policy',
    conversationId: 'conversation-server-policy',
    message: 'Bonjour',
    baseInstructions: 'SERVER-OWNED INSTRUCTIONS',
  })

  assert.equal(requests[0].method, 'thread/start')
  assert.equal(requests[0].parameters.baseInstructions, 'SERVER-OWNED INSTRUCTIONS')
  assert.equal(requests[1].method, 'turn/start')
})

/**
 * The server sends the instructions once per connection, not with every turn.
 * A second conversation therefore arrives WITHOUT them, and its thread must
 * still be configured — otherwise the agent would quietly lose its policy from
 * the second conversation onwards, which is a failure nothing would report.
 */
test('a later thread is configured from the instructions kept in memory', async () => {
  const requests = []
  const bridge = new SidecarBridge(config, {
    WebSocketClass: FakeWebSocket,
    codex: {
      stop() {},
      async request(method, parameters) {
        requests.push({ method, parameters })
        if (method === 'thread/start') return { thread: { id: `thread-${requests.length}` } }
        return { turn: { id: `turn-${requests.length}` } }
      },
    },
  })
  bridge.ready = true

  await bridge.startTurn({
    requestId: 'request-1',
    conversationId: 'conversation-1',
    message: 'Bonjour',
    baseInstructions: 'SERVER-OWNED INSTRUCTIONS',
  })
  // Deuxième conversation, trame nue : le serveur ne les renvoie plus.
  await bridge.startTurn({
    requestId: 'request-2',
    conversationId: 'conversation-2',
    message: 'Encore',
  })

  const starts = requests.filter(request => request.method === 'thread/start')
  assert.equal(starts.length, 2)
  assert.equal(starts[1].parameters.baseInstructions, 'SERVER-OWNED INSTRUCTIONS')
})

test('without instructions ever received, a thread starts without inventing any', async () => {
  const requests = []
  const bridge = new SidecarBridge(config, {
    WebSocketClass: FakeWebSocket,
    codex: {
      stop() {},
      async request(method, parameters) {
        requests.push({ method, parameters })
        if (method === 'thread/start') return { thread: { id: 'thread-bare' } }
        return { turn: { id: 'turn-bare' } }
      },
    },
  })
  bridge.ready = true

  await bridge.startTurn({
    requestId: 'request-bare',
    conversationId: 'conversation-bare',
    message: 'Bonjour',
  })

  assert.equal('baseInstructions' in requests[0].parameters, false)
})

test('replays a pending approval with the same request id after a browser reconnect', () => {
  FakeWebSocket.instances.length = 0
  const responses = []
  const bridge = new SidecarBridge(config, {
    WebSocketClass: FakeWebSocket,
    codex: {
      stop() {},
      respond(id, result) { responses.push({ id, result }) },
    },
  })
  try {
    bridge.connect()
    const socket = FakeWebSocket.instances[0]
    socket.open()
    socket.message({
      type: 'sidecar.welcome',
      protocol: 'sciilo.sidecar.v1',
      tools: [],
    })
    bridge.activeByThread.set('thread-approval', {
      requestId: 'turn-approval',
      conversationId: 'conversation-approval',
      threadId: 'thread-approval',
    })
    bridge.onCodexRequest({
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-approval',
        command: 'npm run test:e2e',
        reason: 'Run the browser checks.',
      },
    })
    const first = socket.sent.at(-1)
    assert.equal(first.type, 'approval.request')
    assert.equal(first.turnRequestId, 'turn-approval')
    assert.equal(first.conversationId, 'conversation-approval')

    socket.message({ type: 'interaction.sync' })
    const replay = socket.sent.at(-1)
    assert.deepEqual(replay, first)

    socket.message({
      type: 'approval.resolve',
      requestId: first.requestId,
      decision: 'accept',
    })
    assert.deepEqual(responses, [{ id: 42, result: { decision: 'accept' } }])

    bridge.onCodexRequest({
      id: 43,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-approval',
        questions: [{ id: 'choice', question: 'Choose?', options: [] }],
      },
    })
    const input = socket.sent.at(-1)
    assert.equal(input.type, 'input.request')
    socket.message({ type: 'interaction.sync' })
    assert.deepEqual(socket.sent.at(-1), input)
  } finally {
    bridge.stop()
  }
})
