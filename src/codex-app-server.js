import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { codexInvocation } from './codex-cli.js'

export class CodexAppServer extends EventEmitter {
  constructor({ command, cwd, spawnProcess = spawn } = {}) {
    super()
    this.invocation = codexInvocation(command)
    this.cwd = cwd
    this.spawnProcess = spawnProcess
    this.nextId = 1
    this.pending = new Map()
    this.child = null
  }

  async start() {
    if (this.child) return
    const child = this.spawnProcess(
      this.invocation.command,
      [...this.invocation.prefixArgs, 'app-server'],
      {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      },
    )
    this.child = child
    child.once('error', error => this.failAll(error))
    child.once('exit', (code, signal) => {
      const error = new Error(`Codex App Server stopped (${signal || code}).`)
      this.child = null
      this.failAll(error)
      this.emit('exit', error)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => this.emit('log', chunk.trimEnd()))
    createInterface({ input: child.stdout }).on('line', line => this.receiveLine(line))

    await this.request('initialize', {
      clientInfo: {
        name: 'sciilo-sidecar',
        title: 'Sciilo Codex Sidecar',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    })
    this.notify('initialized')
    const account = await this.request('account/read', { refreshToken: false })
    if (account?.requiresOpenaiAuth && !account?.account) {
      throw new Error('Codex n’est pas authentifié. Lancez `sciilo-sidecar setup`.')
    }
  }

  request(method, params) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error('Codex App Server n’est pas disponible.'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject, method })
      this.write({ method, id, params })
    })
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params })
  }

  respond(id, result) {
    this.write({ id, result })
  }

  respondError(id, message, code = -32603) {
    this.write({ id, error: { code, message } })
  }

  write(frame) {
    this.child?.stdin?.write(`${JSON.stringify(frame)}\n`)
  }

  receiveLine(line) {
    if (!line.trim()) return
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      this.emit('log', `Ignored non-JSON Codex frame: ${line}`)
      return
    }
    if (frame.id !== undefined && !frame.method) {
      const pending = this.pending.get(String(frame.id))
      if (!pending) return
      this.pending.delete(String(frame.id))
      if (frame.error) {
        const error = new Error(frame.error.message || `Échec ${pending.method}`)
        error.code = frame.error.code
        pending.reject(error)
      } else {
        pending.resolve(frame.result)
      }
      return
    }
    if (frame.method && frame.id !== undefined) {
      this.emit('request', frame)
      return
    }
    if (frame.method) this.emit('notification', frame)
  }

  stop() {
    const child = this.child
    this.child = null
    if (child && !child.killed) child.kill('SIGTERM')
    this.failAll(new Error('Codex App Server stopped.'))
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
