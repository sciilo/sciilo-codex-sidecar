import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export function bundledCodexEntrypoint(resolvePackage = require.resolve) {
  return resolvePackage('@openai/codex/bin/codex.js')
}

export function codexInvocation(configuredCommand, resolvePackage) {
  if (configuredCommand) {
    return {
      command: configuredCommand,
      prefixArgs: [],
      source: 'configured',
    }
  }
  return {
    command: process.execPath,
    prefixArgs: [bundledCodexEntrypoint(resolvePackage)],
    source: 'bundled',
  }
}

export function runCodexSync(
  configuredCommand,
  args,
  options,
  spawnProcess = spawnSync,
) {
  const invocation = codexInvocation(configuredCommand)
  return spawnProcess(
    invocation.command,
    [...invocation.prefixArgs, ...args],
    options,
  )
}
