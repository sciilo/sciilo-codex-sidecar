import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// `src/vault.js` is a COPY, and it must stay a copy character for character.
//
// It drifted once already, silently: the copy was reformatted by hand — renamed
// identifiers, semicolons, reworded errors — and a performance fix made
// upstream never reached it. Neither showed up anywhere, because nothing
// compared the two. The file's own header promises it "runs IDENTICALLY in the
// browser and in the sidecar"; this is what makes the promise checkable.
//
// It matters more than tidiness. The browser seals a content and the sidecar
// opens it: any divergence in a context string, a nonce length or a base64
// encoder breaks that in production, not here, and it breaks it as "the agent
// cannot read the document" — a symptom that points nowhere near the cause.
//
// The check skips when the upstream repository is not on this machine: a
// contributor who only cloned the sidecar must still be able to run the suite.
// It says so out loud rather than passing quietly, because a check that reports
// green when it verified nothing is worse than no check.

const HERE = dirname(fileURLToPath(import.meta.url))
const COPY = join(HERE, '..', 'src', 'vault.js')

// The sciilo repository is a separate clone; the sidecar is distributed from
// its own. SCIILO_VAULT names the upstream file when the two are not siblings.
const UPSTREAM = process.env.SCIILO_VAULT
  ? resolve(process.env.SCIILO_VAULT)
  : join(HERE, '..', '..', 'sidecar', 'vault', 'vault.js')

async function readOrNull(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

test('the vault is the upstream file, unchanged', async (t) => {
  const upstream = await readOrNull(UPSTREAM)
  if (upstream === null) {
    t.skip(`upstream vault not found at ${UPSTREAM} — set SCIILO_VAULT to check parity`)
    return
  }

  const copy = await readOrNull(COPY)

  assert.equal(copy, upstream,
    `src/vault.js has drifted from ${UPSTREAM}. Do not edit the copy: change the `
    + 'upstream file, then run `npm run vault:sync`.')
})
