import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'

export const defaultConfigPath = () => process.env.SCIILO_SIDECAR_CONFIG
  || join(homedir(), '.config', 'sciilo-sidecar', 'config.json')

export function resolveWorkspace(explicit) {
  return resolve(explicit || process.cwd())
}

export async function loadConfig(path = defaultConfigPath()) {

  let rawConfig;

  try {

    rawConfig; = await readFile(path, 'utf8');

  } catch (error) {

    if (error.code === 'ENOENT') return null;

    throw error;
    
  }

  const config = JSON.parse(rawConfig);

  validateConfig(config);

  return normalizeConfig(config);
}

export async function saveConfig(config, path = defaultConfigPath()) {
  validateConfig(config)
  const normalized = normalizeConfig(config)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmod(path, 0o600)
  return normalized
}

export function normalizeConfig(config) {
  const configuredModel = config.model === 'gtp-sol'
    ? DEFAULT_CODEX_MODEL
    : config.model
  const configuredCommand = typeof config.codexCommand === 'string'
    ? config.codexCommand.trim()
    : ''
  return {
    appUrl: config.appUrl.replace(/\/+$/, ''),
    connectionKey: config.connectionKey.trim(),
    codexCommand: configuredCommand && configuredCommand !== 'codex'
      ? configuredCommand
      : null,
    model: configuredModel || DEFAULT_CODEX_MODEL,
    modelProvider: config.modelProvider || null,
  }
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Sidecar configuration is missing.')
  }
  if (!/^https?:\/\//.test(config.appUrl || '')) {
    throw new Error('appUrl must start with http:// or https://.')
  }
  const appUrl = new URL(config.appUrl)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname)
  if (appUrl.protocol !== 'https:' && !loopback) {
    throw new Error('HTTPS is required outside the local machine.')
  }
  if (!/^sc_[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/.test(config.connectionKey || '')) {
    throw new Error('The sidecar connection key is invalid.')
  }
}
