#!/usr/bin/env node

import { createInterface } from 'node:readline/promises'
import { createRequire } from 'node:module'
import { stdin, stdout } from 'node:process'
import {
  DEFAULT_CODEX_MODEL,
  defaultConfigPath,
  loadConfig,
  resolveWorkspace,
  saveConfig,
} from '../src/config.js'
import { runCodexSync } from '../src/codex-cli.js'
import { SidecarBridge } from '../src/bridge.js'
import { banner } from '../src/banner.js'

const require = createRequire(import.meta.url)

const { version } = require('../package.json')

const [command = 'start', ...args] = process.argv.slice(2)
const configPath = valueAfter(args, '--config') || defaultConfigPath()
const chosenWorkspace = valueAfter(args, '--workspace')
const workspace = resolveWorkspace(chosenWorkspace)

try {
  if (command === 'setup') {
    await setup(configPath)
  } else if (command === 'status') {
    await status(configPath)
  } else if (command === 'start') {
    let config = await loadConfig(configPath)
    if (!config) config = await setup(configPath)
    await start({ ...config, workspace }, configPath)
  } else if (['help', '--help', '-h'].includes(command)) {
    usage()
  } else {
    usage()
    process.exitCode = 2
  }
} catch (error) {
  console.error(`sidecar: ${error.message}`)
  process.exitCode = 1
}

async function setup(path) {
  const previous = await loadConfig(path)
  const terminal = createInterface({ input: stdin, output: stdout })
  try {
    stdout.write(banner('Codex sidecar · setup', { version }))
    const appUrl = await terminal.question(
      `Application URL [${previous?.appUrl || 'https://sciilo.ai'}]: `,
    ) || previous?.appUrl || 'https://sciilo.ai'
    const connectionKey = await terminal.question(
      `Connection key${previous ? ' [leave empty to keep the current one]' : ''}: `,
    ) || previous?.connectionKey
    const modelProvider = await terminal.question(
      `Codex provider${previous?.modelProvider ? ` [${previous.modelProvider}]` : ' [Codex configuration]' }: `,
    ) || previous?.modelProvider || null
    const defaultModel = previous?.model || DEFAULT_CODEX_MODEL
    const model = await terminal.question(
      `Model [${defaultModel}]: `,
    ) || defaultModel
    const config = await saveConfig({
      appUrl,
      connectionKey,
      codexCommand: previous?.codexCommand,
      modelProvider,
      model,
    }, path)
    console.log(`Configuration saved to ${path} (mode 0600).`)
    configureCodexAuthentication(config.codexCommand)
    return config
  } finally {
    terminal.close()
  }
}

function configureCodexAuthentication(codexCommand) {
  const statusResult = runCodexSync(codexCommand, ['login', 'status'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (statusResult.status === 0) {
    console.log(commandOutput(statusResult) || 'Codex is already signed in.')
    return
  }

  const apiKey = process.env.SCIILO_CODEX_API_KEY
  if (apiKey) {
    const login = runCodexSync(codexCommand, ['login', '--with-api-key'], {
      input: `${apiKey}\n`,
      stdio: ['pipe', 'inherit', 'inherit'],
      encoding: 'utf8',
    })
    if (login.status !== 0) throw new Error('Signing in to Codex with an API key failed.')
    console.log('API key handed to the Codex credential store; the sidecar keeps no copy.')
    return
  }

  console.log('No Codex session found. Opening the Codex sign-in…')
  const login = runCodexSync(codexCommand, ['login'], { stdio: 'inherit' })
  if (login.status !== 0) {
    throw new Error('Codex sign-in did not complete.')
  }
}

async function status(path) {
  const config = await loadConfig(path)
  if (!config) {
    console.log(`Sidecar is not configured yet (${path}).`)
    return
  }
  const login = runCodexSync(config.codexCommand, ['login', 'status'], {
    encoding: 'utf8',
  })
  const loginStatus = login.status === 0
    ? commandOutput(login) || 'signed in'
    : 'not signed in'
  console.log(`Application : ${config.appUrl}`)
  console.log(`Workspace   : ${workspace}${chosenWorkspace ? '' : ' (current directory)'}`)
  console.log(`Codex       : ${loginStatus}`)
  console.log(`Key         : configured (${config.connectionKey.slice(0, 12)}…)`)
}

async function start(config, path) {
  stdout.write(banner('Codex sidecar', { version }))
  const bridge = new SidecarBridge(config)
  bridge.on('connected', () => console.log(
    `sidecar: connected to ${config.appUrl} — project ${config.workspace}`))
  bridge.on('disconnected', ({ pairingRequired } = {}) => {
    if (!pairingRequired) {
      console.log('sidecar: connection lost, retrying…')
    }
  })
  let pairingUpdate
  bridge.on('pairingRequired', ({ reason } = {}) => {
    if (pairingUpdate) return
    pairingUpdate = renewConnectionKey(path, config, bridge, reason)
      .then(updated => {
        if (updated) config = { ...updated, workspace: config.workspace }
      })
      .catch(error => console.error(`sidecar: ${error.message}`))
      .finally(() => {
        pairingUpdate = null
      })
  })
  bridge.on('log', line => {
    if (line) console.error(`codex: ${line}`)
  })
  bridge.on('error', error => console.error(`sidecar: ${error.message}`))
  const stop = () => {
    bridge.stop()
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await bridge.start()
}

async function renewConnectionKey(path, config, bridge, reason) {
  console.log(`sidecar: ${revocationDetail(reason)}`)
  console.log('sidecar: click Connect in Sciilo, copy the new key, then paste it here.')

  if (!stdin.isTTY || !stdout.isTTY) {
    console.log(`sidecar: not an interactive terminal; run "sciilo-sidecar setup --config ${path}" instead.`)
    return null
  }

  const terminal = createInterface({ input: stdin, output: stdout })
  try {
    while (true) {
      const connectionKey = (await terminal.question('New connection key: ')).trim()
      if (!connectionKey) {
        console.log('The key is required.')
        continue
      }
      try {
        const updated = await saveConfig({ ...config, connectionKey }, path)
        console.log('sidecar: new key saved, reconnecting…')
        bridge.updateConnectionKey(updated.connectionKey)
        return updated
      } catch (error) {
        console.log(`Key rejected: ${error.message}`)
      }
    }
  } finally {
    terminal.close()
  }
}

function revocationDetail(reason) {
  if (reason === 'replaced') return 'its connection key was replaced in Sciilo.'
  if (reason === 'reconnect_flood') {
    return 'its connection key was revoked: several sidecars fought over the connection. '
      + 'Stop the extra one before generating a new key.'
  }
  return 'its connection key was revoked in Sciilo.'
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : null
}

function commandOutput(result) {
  return result.stdout?.trim() || result.stderr?.trim() || ''
}

function usage() {
  console.log(`Usage:
  sciilo-sidecar setup [--config path]
  sciilo-sidecar start [--workspace path] [--config path]
  sciilo-sidecar status [--workspace path] [--config path]

Without --workspace, the sidecar takes the current directory as the project.

Codex is installed automatically as a private sidecar dependency.

See README.md for ChatGPT sign-in, existing-session, and API-key paths.`)
}
