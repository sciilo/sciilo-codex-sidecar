import test from 'node:test'
import assert from 'node:assert/strict'

import { createHandoffKeypair, openSealedDek, sealDekFor, createVault, sealField, openField }
  from '../src/vault.js'

const CONTEXT = 'sciilo.vault.v1|doc-1||attributes'

test('the sidecar announces a public half it can never write to disk', async () => {
  const vault = await createHandoffKeypair()

  assert.equal(typeof vault.publicKey, 'string')
  assert.equal(vault.privateKey.extractable, false)

  await assert.rejects(() => crypto.subtle.exportKey('pkcs8', vault.privateKey))
})

test('a key sealed by the browser opens here, and unlocks contents', async () => {
  const { dek } = await createVault('a demonstration password, long enough')
  const sealedContent = await sealField(dek, 'what the agent must re-read', CONTEXT)

  const parcel = await sealDekFor(dek, (await handoff()).publicKey)
  const pair = lastPair

  const received = await openSealedDek(pair.privateKey, parcel)

  assert.equal(await openField(received, sealedContent, CONTEXT), 'what the agent must re-read')
})

test('a parcel from an earlier run no longer opens', async () => {
  const { dek } = await createVault('a demonstration password, long enough')
  const firstRun = await createHandoffKeypair()
  const parcel = await sealDekFor(dek, firstRun.publicKey)

  // Restarting the sidecar mints a new pair; the old private half is gone with
  // the process, so a parcel captured earlier is worthless.
  const secondRun = await createHandoffKeypair()

  assert.notEqual(secondRun.publicKey, firstRun.publicKey)
  await assert.rejects(() => openSealedDek(secondRun.privateKey, parcel),
    /not sealed for this sidecar/)
})

test('an altered parcel is refused rather than half-trusted', async () => {
  const { dek } = await createVault('a demonstration password, long enough')
  const vault = await createHandoffKeypair()
  const parcel = await sealDekFor(dek, vault.publicKey)

  const bytes = atob(parcel).split('')
  bytes[bytes.length - 1] = String.fromCharCode(bytes.at(-1).charCodeAt(0) ^ 0x01)

  await assert.rejects(() => openSealedDek(vault.privateKey, btoa(bytes.join(''))),
    /Unreadable sealed key/)
})

let lastPair = null

async function handoff() {
  lastPair = await createHandoffKeypair()
  return lastPair
}
