import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import WebSocket from 'ws'
import { CodexAppServer } from './codex-app-server.js'
import { createHandoffKeypair, openSealedDek } from './vault.js'
import { DEFAULT_REASONING_EFFORT } from './config.js'
import { openText, sealArguments } from './document-seal.js'

const RECONNECT_DELAYS = [500, 1_000, 2_000, 5_000, 10_000, 30_000]
const HANDSHAKE_TIMEOUT = 10_000
const HEARTBEAT_INTERVAL = 20_000
const HEARTBEAT_TIMEOUT = 8_000
export const PAIRING_REQUIRED_CLOSE_CODE = 4001
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
])

export class SidecarBridge extends EventEmitter {
  constructor(config, {
    WebSocketClass = WebSocket,
    codex = new CodexAppServer({
      command: config.codexCommand,
      cwd: config.workspace,
    }),
  } = {}) {
    super()
    this.config = config
    this.WebSocketClass = WebSocketClass
    this.codex = codex
    this.socket = null
    this.tools = []
    // Server-owned, received once per connection and reused for every thread
    // this process starts. Never read from disk, never written to it.
    this.baseInstructions = null
    this.threads = new Map()
    this.activeByThread = new Map()
    this.pendingTools = new Map()
    this.pendingApprovals = new Map()
    this.pendingInputs = new Map()
    this.reconnectAttempt = 0
    this.reconnectTimer = null
    this.handshakeTimer = null
    this.heartbeat = null
    this.heartbeatTimeout = null
    this.stopping = false
    this.pairingRequired = false
    this.context = null
    this.ready = false
    this.instanceId = randomUUID()
  }

  async start() {
    this.codex.on('notification', frame => this.onCodexNotification(frame))
    this.codex.on('request', frame => this.onCodexRequest(frame))
    this.codex.on('log', line => this.emit('log', line))
    this.codex.on('exit', error => this.emit('error', error))
    await this.codex.start()
    // A throwaway key pair, forged at start-up and lost on exit. The private
    // half is non-extractable: it cannot be serialised, therefore it cannot be
    // written to a config file even by mistake. The browser seals the vault key
    // for this public half alone; Sciilo relays a block it cannot open.
    this.vault = await createHandoffKeypair()
    this.vaultKey = null
    this.connect()
  }

  stop() {
    this.stopping = true
    clearTimeout(this.reconnectTimer)
    this.clearHandshakeTimeout()
    this.clearHeartbeat()
    this.socket?.close()
    this.socket = null
    this.codex.stop()
  }

  connect() {
    if (this.stopping || this.pairingRequired) return
    if (this.socket && [this.WebSocketClass.CONNECTING, this.WebSocketClass.OPEN]
      .includes(this.socket.readyState)) return
    const socket = new this.WebSocketClass(sidecarWebSocketUrl(this.config.appUrl), {
      headers: { Authorization: `Bearer ${this.config.connectionKey}` },
      handshakeTimeout: HANDSHAKE_TIMEOUT,
    })
    this.socket = socket
    socket.on('open', () => {
      if (this.socket !== socket) return
      this.ready = false
      this.startHandshakeTimeout(socket)
      this.startHeartbeat(socket)
    })
    socket.on('message', data => {
      if (this.socket !== socket) return
      this.markSocketAlive(socket)
      try {
        this.onApplicationFrame(JSON.parse(data.toString()))
      } catch (error) {
        this.emit('error', new Error(`Invalid application frame: ${error.message}`))
      }
    })
    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return
      this.clearHandshakeTimeout()
      this.clearHeartbeat()
      this.socket = null
      this.ready = false
      if (code === PAIRING_REQUIRED_CLOSE_CODE) {
        this.requirePairing(reason?.toString() || 'connection_key_invalid')
      }
      this.emit('disconnected', {
        pairingRequired: this.pairingRequired,
        reason: reason?.toString() || null,
      })
      if (!this.pairingRequired) this.scheduleReconnect()
    })
    socket.on('error', error => {
      this.emit('error', error)
      if (this.socket === socket && socket.readyState !== this.WebSocketClass.CLOSED) {
        socket.terminate?.()
      }
    })
  }

  clearHeartbeat() {
    clearInterval(this.heartbeat)
    clearTimeout(this.heartbeatTimeout)
    this.heartbeat = null
    this.heartbeatTimeout = null
  }

  clearHandshakeTimeout() {
    clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  startHandshakeTimeout(socket) {
    this.clearHandshakeTimeout()
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null
      if (this.socket === socket && !this.ready
          && socket.readyState === this.WebSocketClass.OPEN) {
        socket.terminate?.()
      }
    }, HANDSHAKE_TIMEOUT)
  }

  startHeartbeat(socket) {
    this.clearHeartbeat()
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== this.WebSocketClass.OPEN) return
      if (!this.send({ type: 'ping' })) return
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = setTimeout(() => {
        this.heartbeatTimeout = null
        if (this.socket === socket && socket.readyState === this.WebSocketClass.OPEN) {
          socket.terminate?.()
        }
      }, HEARTBEAT_TIMEOUT)
    }, HEARTBEAT_INTERVAL)
  }

  markSocketAlive(socket) {
    if (this.socket !== socket) return
    clearTimeout(this.heartbeatTimeout)
    this.heartbeatTimeout = null
  }

  scheduleReconnect() {
    if (this.stopping || this.pairingRequired || this.reconnectTimer) return
    const index = Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, RECONNECT_DELAYS[index])
  }

  send(frame) {
    if (this.socket?.readyState === this.WebSocketClass.OPEN) {
      try {
        this.socket.send(JSON.stringify(frame))
        return true
      } catch (error) {
        this.emit('error', error)
        this.socket.terminate?.()
      }
    }
    return false
  }

  requirePairing(reason = 'connection_key_invalid') {
    if (this.pairingRequired) return
    this.pairingRequired = true
    this.ready = false
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.clearHandshakeTimeout()
    this.clearHeartbeat()
    this.emit('pairingRequired', { reason })
  }

  updateConnectionKey(connectionKey) {
    if (!connectionKey || typeof connectionKey !== 'string') {
      throw new Error('The new connection key is missing.')
    }
    const previous = this.socket
    this.socket = null
    this.clearHandshakeTimeout()
    this.clearHeartbeat()
    previous?.close()
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.config = { ...this.config, connectionKey }
    this.pairingRequired = false
    this.ready = false
    this.reconnectAttempt = 0
    this.connect()
  }

  onApplicationFrame(frame) {
    switch (frame.type) {
      case 'sidecar.pairing_required':
        this.requirePairing(frame.reason || 'revoked')
        break
      case 'sidecar.welcome':
        this.clearHandshakeTimeout()
        this.reconnectAttempt = 0
        this.tools = frame.tools || []
        this.ready = true
        this.emit('connected')
        this.send({
          type: 'sidecar.ready',
          protocol: frame.protocol,
          instanceId: this.instanceId,
          codex: true,
          toolCount: this.tools.length,
          workspace: workspaceIdentity(this.config.workspace),
          vaultPublicKey: this.vault?.publicKey ?? null,
        })
        break
      case 'vault.key':
      
        openSealedDek(this.vault.privateKey, frame.sealed)
          .then(key => {
            this.vaultKey = key
            this.emit('vaultUnlocked')
          })
          .catch(() => {
            // Sealed for another sidecar, or altered in transit. Working
            // without it beats working with a key we cannot trust.
            this.vaultKey = null
            this.emit('vaultLocked')
          })
        break
      case 'assistant.turn':
        this.startTurn(frame).catch(error => this.send({
          type: 'assistant.failed',
          requestId: frame.requestId,
          message: error.message,
        }))
        break
      case 'assistant.interrupt':
        this.interrupt(frame).catch(error => this.emit('error', error))
        break
      case 'context.update':
        this.context = frame.context || null
        break
      case 'approval.resolve':
        this.resolveApproval(frame)
        break
      case 'input.resolve':
        this.resolveInput(frame)
        break
      case 'interaction.sync':
        this.replayPendingInteractions()
        break
      case 'tool.result':
        this.resolveTool(frame)
        break
      default:
        break
    }
  }

  async startTurn(frame) {
    if (!this.ready) {
      throw new Error('The sidecar is still loading the application tools.')
    }
    // The server owns these instructions and now sends them ONCE per connection,
    // not with every turn: they only ever configure a newly created thread, and
    // resending thousands of words per message was both waste and one more
    // chance to capture the prompt off a machine that is not ours. Keeping them
    // here is what makes the second thread of a session as well-configured as
    // the first. The cache dies with the process, exactly like the threads it
    // configures — so the server, which tracks the same transport, sends again
    // at the next connection without either side asking.
    if (typeof frame.baseInstructions === 'string' && frame.baseInstructions.trim()) {
      this.baseInstructions = frame.baseInstructions
    }
    const conversationId = frame.conversationId || randomUUID()
    let threadId = this.threads.get(conversationId)
    const startsNewThread = !threadId
    if (!threadId) {
      const threadOptions = {
        cwd: this.config.workspace,
        model: this.config.model,
        modelProvider: this.config.modelProvider,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        dynamicTools: dynamicTools(this.tools),
        // Codex settings travel in `config`, keyed as in config.toml — no
        // top-level `reasoningEffort` parameter exists, and passing one is
        // accepted in silence while the machine's own value keeps winning.
        config: {
          model_reasoning_effort:
            this.config.reasoningEffort || DEFAULT_REASONING_EFFORT,
        },
      }
      if (this.baseInstructions) {
        threadOptions.baseInstructions = this.baseInstructions
      }
      const started = await this.codex.request('thread/start', threadOptions)
      threadId = started.thread.id
      this.threads.set(conversationId, threadId)
    }
    if (this.activeByThread.has(threadId)) {
      throw new Error('A Codex turn is already running in this conversation.')
    }

    const state = {
      requestId: frame.requestId,
      conversationId,
      threadId,
      turnId: null,
      text: '',
    }
    this.activeByThread.set(threadId, state)
    const context = frame.context || this.context
    const inputText = buildTurnInput(frame.message, {
      context,
      history: startsNewThread ? frame.history : null,
    })
    try {
      const response = await this.codex.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: inputText, text_elements: [] }],
      })
      state.turnId = response.turn.id
    } catch (error) {
      this.activeByThread.delete(threadId)
      throw error
    }
  }

  async interrupt(frame) {
    const threadId = this.threads.get(frame.conversationId)
    const state = threadId ? this.activeByThread.get(threadId) : null
    const turnId = frame.turnId || state?.turnId
    if (threadId && turnId) {
      await this.codex.request('turn/interrupt', { threadId, turnId })
    }
  }

  onCodexNotification(frame) {
    const params = frame.params || {}
    const state = params.threadId ? this.activeByThread.get(params.threadId) : null
    const visible = publicCodexNotification(frame)
    if (visible) {
      this.send({
        type: 'codex.event',
        requestId: state?.requestId,
        conversationId: state?.conversationId,
        method: visible.method,
        params: visible.params,
      })
    }
    if (frame.method === 'item/agentMessage/delta' && state) {
      state.text += params.delta || ''
      this.send({
        type: 'assistant.delta',
        requestId: state.requestId,
        conversationId: state.conversationId,
        turnId: params.turnId,
        delta: params.delta || '',
        fullText: state.text,
      })
    } else if (frame.method === 'item/completed' && state
      && params.item?.type === 'agentMessage' && params.item.text) {
      state.text = params.item.text
    } else if (frame.method === 'turn/completed' && state) {
      const failed = params.turn?.status === 'failed'
      this.send({
        type: failed ? 'assistant.failed' : 'assistant.completed',
        requestId: state.requestId,
        conversationId: state.conversationId,
        turnId: params.turn?.id,
        text: state.text,
        message: params.turn?.error?.message,
      })
      this.activeByThread.delete(params.threadId)
    }
  }

  onCodexRequest(frame) {
    if (frame.method === 'currentTime/read') {
      this.codex.respond(frame.id, {
        currentTimeAt: Math.floor(Date.now() / 1_000),
      })
      return
    }
    if (frame.method === 'item/tool/call') {
      this.dispatchToolCall(frame)
      return
    }
    if (frame.method === 'item/tool/requestUserInput') {
      const externalId = randomUUID()
      const state = this.activeStateFor(frame)
      this.pendingInputs.set(externalId, {
        codexId: frame.id,
        turnRequestId: state?.requestId,
        conversationId: state?.conversationId,
        questions: frame.params?.questions || [],
      })
      if (!this.send(this.pendingInputFrame(externalId,
        this.pendingInputs.get(externalId)))) {
        this.pendingInputs.delete(externalId)
        this.codex.respond(frame.id, { answers: {} })
      }
      return
    }
    if (APPROVAL_METHODS.has(frame.method)) {
      const externalId = randomUUID()
      const state = this.activeStateFor(frame)
      this.pendingApprovals.set(externalId, {
        codexId: frame.id,
        method: frame.method,
        params: frame.params,
        turnRequestId: state?.requestId,
        conversationId: state?.conversationId,
      })
      const sent = this.send(this.pendingApprovalFrame(externalId,
        this.pendingApprovals.get(externalId)))
      if (!sent) this.resolveApproval({ requestId: externalId, decision: 'decline' })
      return
    }
    if (frame.method === 'mcpServer/elicitation/request') {
      this.send({
        type: 'error',
        message: `MCP server ${frame.params?.serverName || ''} asked for an unsupported input.`,
      })
      this.codex.respond(frame.id, {
        action: 'decline',
        content: null,
        _meta: null,
      })
      return
    }
    this.codex.respondError(frame.id, `Unsupported Codex request: ${frame.method}`, -32601)
  }

  /**
   * Sends a tool call out, with its content sealed first.
   *
   * The sealed arguments are what gets remembered, not the originals: they are
   * echoed back in `artifact.created`, and echoing the clear text there would
   * hand the server exactly what the sealing just took away from it.
   *
   * Sealing failure does not cancel the call. Losing the user's work is the
   * worse outcome, and the database guard reports anything readable that lands
   * in storage — a silent skip here cannot pass for success there.
   */
  async dispatchToolCall(frame) {
    const externalId = randomUUID()
    const state = this.activeStateFor(frame)
    let args = frame.params.arguments || {}
    try {
      args = await sealArguments(this.vaultKey, frame.params.tool, args)
    } catch (failure) {
      this.emit('vaultSealFailed', { tool: frame.params.tool, reason: failure.message })
    }
    this.pendingTools.set(externalId, {
      codexId: frame.id,
      tool: frame.params.tool,
      arguments: args,
      turnRequestId: state?.requestId,
      conversationId: state?.conversationId,
    })
    if (!this.send({
      type: 'tool.call',
      requestId: externalId,
      tool: frame.params.tool,
      arguments: args,
    })) {
      this.pendingTools.delete(externalId)
      this.codex.respond(frame.id, {
        contentItems: [{ type: 'inputText', text: 'The application is disconnected.' }],
        success: false,
      })
    }
  }

  activeStateFor(frame) {
    return frame.params?.threadId
      ? this.activeByThread.get(frame.params.threadId)
      : this.activeByThread.size === 1
        ? this.activeByThread.values().next().value
        : null
  }

  pendingApprovalFrame(requestId, pending) {
    return {
      type: 'approval.request',
      requestId,
      turnRequestId: pending?.turnRequestId,
      conversationId: pending?.conversationId,
      kind: approvalKind(pending?.method || ''),
      title: approvalTitle(pending?.method || ''),
      command: pending?.params?.command,
      reason: pending?.params?.reason,
      detail: pending?.params?.command || pending?.params?.reason,
    }
  }

  pendingInputFrame(requestId, pending) {
    return {
      type: 'input.request',
      requestId,
      turnRequestId: pending?.turnRequestId,
      conversationId: pending?.conversationId,
      questions: pending?.questions || [],
    }
  }

  replayPendingInteractions() {
    for (const [requestId, pending] of this.pendingApprovals) {
      this.send(this.pendingApprovalFrame(requestId, pending))
    }
    for (const [requestId, pending] of this.pendingInputs) {
      this.send(this.pendingInputFrame(requestId, pending))
    }
  }

  async resolveTool(frame) {
    const pending = this.pendingTools.get(frame.requestId)
    if (!pending) return
    this.pendingTools.delete(frame.requestId)
    // The other half of the boundary. A read tool now answers with ciphertext
    // where the document body used to be; the agent has to receive the body.
    // Without this, sealing would not make the project private — it would make
    // it incomprehensible to the one writing it.
    let content = frame.content || ''
    try {
      content = await openText(this.vaultKey, content)
    } catch (failure) {
      this.emit('vaultOpenFailed', { tool: pending.tool, reason: failure.message })
    }
    this.codex.respond(pending.codexId, {
      contentItems: [{ type: 'inputText', text: content }],
      success: Boolean(frame.success),
    })
    const result = parseToolContent(frame.content)
    this.send({
      type: 'artifact.created',
      requestId: frame.requestId,
      tool: pending.tool,
      arguments: pending.arguments,
      result,
      success: Boolean(frame.success),
      turnRequestId: pending.turnRequestId,
      conversationId: pending.conversationId,
    })
  }

  resolveApproval(frame) {
    const pending = this.pendingApprovals.get(frame.requestId)
    if (!pending) return
    this.pendingApprovals.delete(frame.requestId)
    const accepted = frame.decision === 'accept'
    const legacy = pending.method === 'execCommandApproval'
      || pending.method === 'applyPatchApproval'
    if (pending.method === 'item/permissions/requestApproval') {
      this.codex.respond(pending.codexId, {
        permissions: accepted ? compactPermissions(pending.params?.permissions) : {},
        scope: 'turn',
      })
      return
    }
    this.codex.respond(pending.codexId, {
      decision: legacy
        ? accepted ? 'approved' : { denied: { rejection: 'Declined by the user.' } }
        : accepted ? 'accept' : 'decline',
    })
  }

  resolveInput(frame) {
    const pending = this.pendingInputs.get(frame.requestId)
    if (!pending) return
    this.pendingInputs.delete(frame.requestId)
    this.codex.respond(pending.codexId, { answers: frame.answers || {} })
  }
}

export function workspaceIdentity(workspace) {
  const normalized = String(workspace || '')
  return {
    name: basename(normalized) || 'Project',
    fingerprint: createHash('sha256').update(normalized).digest('hex'),
  }
}

export function buildTurnInput(message, { context = null, history = null } = {}) {
  const blocks = []
  if (Array.isArray(history) && history.length) {
    const previous = history
      .filter(entry => ['user', 'assistant'].includes(entry?.role)
        && typeof entry.text === 'string' && entry.text.trim())
      .map(entry => ({ role: entry.role, text: entry.text }))
    if (previous.length) {
      blocks.push(`<conversation_history>${JSON.stringify(previous)}</conversation_history>`)
    }
  }
  blocks.push(String(message || ''))
  if (context) {
    blocks.push(`<application_context>${JSON.stringify(context)}</application_context>`)
  }
  return blocks.join('\n\n')
}

export function sidecarWebSocketUrl(appUrl) {
  const url = new URL(appUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/sidecar/connect`
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function dynamicTools(tools) {
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
}

export function parseToolContent(content) {
  if (typeof content !== 'string') return content
  try {
    return JSON.parse(content)
  } catch {
    const result = { message: content }
    const documentId = content.match(
      /\bid=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i,
    )?.[1]
    if (documentId) result.document_id = documentId
    return result
  }
}

export function publicCodexNotification(frame) {
  const method = frame?.method
  if (!method) return null
  if (method === 'turn/started' || method === 'turn/completed') {
    return { method, params: publicTurnParams(frame.params) }
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = publicCodexItem(frame.params?.item)
    return item ? {
      method,
      params: {
        threadId: frame.params?.threadId,
        turnId: frame.params?.turnId,
        item,
      },
    } : null
  }
  if (method === 'warning' || method === 'configWarning' || method === 'error') {
    return {
      method,
      params: { message: compactPublicText(frame.params?.message
        || frame.params?.summary || frame.params?.error) },
    }
  }
  if (method === 'model/rerouted') {
    return {
      method,
      params: {
        fromModel: compactPublicText(frame.params?.fromModel, 80),
        toModel: compactPublicText(frame.params?.toModel, 80),
      },
    }
  }
  return null
}

function publicTurnParams(params = {}) {
  const turn = params.turn || {}
  return {
    threadId: params.threadId,
    turn: {
      id: turn.id,
      status: turn.status,
    },
  }
}

function publicCodexItem(item) {
  if (!item || ['userMessage', 'agentMessage'].includes(item.type)) return null
  const summary = {
    id: item.id,
    type: item.type,
    status: item.status,
  }
  switch (item.type) {
    case 'reasoning':
    case 'plan':
    case 'contextCompaction':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return summary
    case 'commandExecution':
      return { ...summary, ...commandActivity(item.command) }
    case 'fileChange':
      return { ...summary, ...publicFileChanges(item.changes) }
    case 'dynamicToolCall':
      return {
        ...summary,
        tool: compactPublicText(item.tool, 120),
        subject: publicToolSubject(item.arguments),
        success: item.success,
      }
    case 'mcpToolCall':
    case 'collabToolCall':
      return {
        ...summary,
        tool: compactPublicText(item.tool, 120),
        status: item.error ? 'failed' : item.status,
      }
    case 'webSearch':
      return { ...summary, subject: compactPublicText(item.query, 140) }
    case 'imageView':
      return summary
    default:
      return null
  }
}

function commandActivity(command) {
  const text = (Array.isArray(command) ? command.join(' ') : String(command || '')).trim()
  if (/(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w.-]+)?\b/i.test(text)
      || /(?:^|[\s;&|])(?:node\s+--test|pytest|playwright\s+test|cargo\s+test|go\s+test)\b/i.test(text)
      || /(?:^|[\s;&|])(?:mvn|\.\/gradlew|gradle)\b[^;&|]*\btest\b/i.test(text)) {
    return { activity: 'verify', detail: 'tests' }
  }
  if (/(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+run\s+(?:build|package)\b/i.test(text)
      || /(?:^|[\s;&|])(?:vite\s+build|cargo\s+build)\b/i.test(text)
      || /(?:^|[\s;&|])(?:mvn|\.\/gradlew|gradle)\b[^;&|]*\b(?:build|compile|package)\b/i.test(text)) {
    return { activity: 'verify', detail: 'build' }
  }
  if (/(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+run\s+(?:lint|format)\b/i.test(text)
      || /(?:^|[\s;&|])(?:eslint|prettier)\b/i.test(text)) {
    return { activity: 'verify', detail: 'lint' }
  }
  if (/(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+run\s+typecheck\b/i.test(text)
      || /(?:^|[\s;&|])tsc\b/i.test(text)) {
    return { activity: 'verify', detail: 'types' }
  }
  if (/(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+run\s+(?:verify|check)\b/i.test(text)
      || /(?:^|[\s;&|])(?:cargo\s+check|mvn\b[^;&|]*\bverify\b)/i.test(text)) {
    return { activity: 'verify', detail: 'checks' }
  }
  if (/\bgit\s+(?:status|diff|log|show)\b/i.test(text)) {
    return { activity: 'inspect', detail: 'git' }
  }
  if (/(?:^|[\s;&|])(?:rg|grep)\b/i.test(text)) {
    return { activity: 'inspect', detail: 'codeSearch' }
  }
  if (/(?:^|[\s;&|])(?:sed|cat|head|tail)\b/i.test(text)) {
    return { activity: 'inspect', detail: 'files' }
  }
  if (/(?:^|[\s;&|])(?:find|ls|pwd)\b/i.test(text)) {
    return { activity: 'inspect', detail: 'structure' }
  }
  if (/(?:^|[\s;&|])(?:ps|ss)\b/i.test(text)) {
    return { activity: 'inspect', detail: 'services' }
  }
  return { activity: 'command', detail: 'localCommand' }
}

function publicFileChanges(changes) {
  const list = Array.isArray(changes) ? changes : []
  const files = [...new Set(list.map(change => publicFileName(change?.path)).filter(Boolean))]
    .slice(0, 4)
  return { changeCount: list.length, files }
}

function publicFileName(path) {
  const segments = String(path || '').replaceAll('\\', '/').split('/').filter(Boolean)
  return compactPublicText(segments.at(-1), 100)
}

function publicToolSubject(args = {}) {
  for (const key of ['title', 'name', 'query', 'term']) {
    if (typeof args?.[key] === 'string' && args[key].trim()) {
      return compactPublicText(args[key].replace(/\s+/g, ' ').trim(), 140)
    }
  }
  return ''
}

function compactPublicText(value, limit = 320) {
  const text = typeof value === 'string'
    ? value
    : value == null ? '' : String(value?.message || value)
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function approvalKind(method) {
  if (method === 'item/permissions/requestApproval') return 'permissions'
  if (method.includes('fileChange') || method === 'applyPatchApproval') return 'file-change'
  return 'command'
}

function approvalTitle(method) {
  if (method === 'item/permissions/requestApproval') {
    return 'Allow additional permissions'
  }
  if (method.includes('fileChange') || method === 'applyPatchApproval') {
    return 'Allow file changes'
  }
  return 'Allow the command to run'
}

function compactPermissions(permissions = {}) {
  return Object.fromEntries(
    Object.entries(permissions).filter(([, value]) => value != null),
  )
}
