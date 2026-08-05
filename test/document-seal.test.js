import test from 'node:test'
import assert from 'node:assert/strict'

import { createVault } from '../src/vault.js'
import {
  diagramKind, excerptOf, guessLanguage, isSealed, openText, openValue, productVisionSource,
  sealArguments, sealValue,
} from '../src/document-seal.js'

const MERMAID = 'sequenceDiagram\n  Alice->>Bob: hello'

async function key() {
  return (await createVault('a demonstration password, long enough')).dek
}

test('a sealed field carries no readable trace of what it held', async () => {
  const token = await sealValue(await key(), crypto.randomUUID(), 'source', MERMAID)

  assert.ok(isSealed(token))
  assert.ok(!token.includes('Alice'))
  assert.ok(!token.includes('sequenceDiagram'))
})

test('what is sealed comes back exactly', async () => {
  const dek = await key()
  const id = crypto.randomUUID()

  assert.equal(await openValue(dek, await sealValue(dek, id, 'source', MERMAID)), MERMAID)
})

test('a block cannot be moved to another document', async () => {
  const dek = await key()
  const token = await sealValue(dek, crypto.randomUUID(), 'source', MERMAID)

  // Rewriting the identifier is exactly the attack the binding exists to stop:
  // the ciphertext is intact, only its claimed home changed.
  const moved = token.replace(/v1:[0-9a-f-]{36}:/, `v1:${crypto.randomUUID()}:`)

  await assert.rejects(() => openValue(dek, moved))
})

test('a field cannot be passed off as another', async () => {
  const dek = await key()
  const id = crypto.randomUUID()
  const token = await sealValue(dek, id, 'excerpt', 'the visible summary')

  await assert.rejects(() => openValue(dek, token.replace(':excerpt:', ':source:')))
})

test('content is restored inside the prose a tool wrote around it', async () => {
  const dek = await key()
  const id = crypto.randomUUID()
  const token = await sealValue(dek, id, 'source', MERMAID)

  const answer = await openText(dek, `Diagram "Login" (id=${id}):\n${token}\nEnd of source.`)

  assert.ok(answer.includes(MERMAID))
  assert.ok(answer.startsWith('Diagram "Login"'))
  assert.ok(!answer.includes('sciilo:sealed'))
})

test('an unopenable token stays put rather than vanishing', async () => {
  const dek = await key()
  const stranger = await sealValue(await key(), crypto.randomUUID(), 'source', MERMAID)

  const answer = await openText(dek, `before ${stranger} after`)

  // Dropping it would hand the agent a plausible but amputated document, and
  // it would rewrite the file believing it had read all of it.
  assert.ok(answer.includes(stranger))
})

test('creating a diagram mints the identifier the seal binds to', async () => {
  const args = await sealArguments(await key(), 'create_diagram',
    { title: 'Login', lang: 'mermaid', source: MERMAID })

  assert.match(args.documentId, /^[0-9a-f-]{36}$/)
  assert.ok(args.source.includes(args.documentId))
  assert.equal(args.title, 'Login')          // le titre reste lisible, c'est assumé
})

test('the label the server can no longer infer travels with the call', async () => {
  const args = await sealArguments(await key(), 'create_diagram',
    { title: 'Login', lang: 'mermaid', source: MERMAID })

  assert.equal(args.kind, 'Sequence diagram')
  assert.ok(!isSealed(args.kind))
})

test('a board seals its summary, not just its body', async () => {
  const dek = await key()
  const args = await sealArguments(dek, 'create_markdown_board',
    { title: 'Notes', source: '# Titre\n\nUn secret commercial.' })

  assert.ok(isSealed(args.excerpt))
  assert.equal(await openValue(dek, args.excerpt), 'Titre Un secret commercial.')
})

test('an update seals against the document it targets', async () => {
  const dek = await key()
  const id = crypto.randomUUID()

  const args = await sealArguments(dek, 'update_diagram', { document_id: id, source: MERMAID })

  assert.equal(await openValue(dek, args.source), MERMAID)
  assert.ok(args.source.includes(id))
})

test('without a key nothing is sealed and nothing is lost', async () => {
  const input = { title: 'Login', lang: 'mermaid', source: MERMAID }

  assert.deepEqual(await sealArguments(null, 'create_diagram', input), input)
})

test('tools that carry no content are left alone', async () => {
  const input = { query: 'login' }

  assert.deepEqual(await sealArguments(await key(), 'search', input), input)
})

test('the labels match what the server used to infer', () => {
  assert.equal(diagramKind('mermaid', 'erDiagram\n  A ||--o{ B : has'), 'Data model')
  assert.equal(diagramKind('mermaid', 'flowchart TD\n  a-->b'), 'Flowchart')
  assert.equal(diagramKind('mermaid', 'stateDiagram-v2\n  [*] --> A'), 'State diagram')
  assert.equal(diagramKind('mermaid', 'mindmap\n  root'), 'Mind map')
  assert.equal(diagramKind('mermaid', '%% sciilo:product-vision\nmindmap'), 'Product Vision')
  assert.equal(diagramKind('plantuml', '@startuml\nclass A\n@enduml'), 'Class diagram')
  assert.equal(diagramKind('plantuml', '@startuml\nA -> B\n@enduml'), 'Sequence diagram')
})

test('an update knows the language it was never told', () => {
  assert.equal(guessLanguage('@startuml\nA -> B'), 'plantuml')
  assert.equal(guessLanguage(MERMAID), 'mermaid')
})

test('a long excerpt is cut where the server cut it', () => {
  const excerpt = excerptOf('x'.repeat(400))

  assert.equal(excerpt.length, 180)
  assert.ok(excerpt.endsWith('...'))
})

// ---------------------------------------------------------------------------
// The Product Vision mindmap is now assembled here instead of on the server.
// The expected string below is pinned identically in the Java test
// (SealedContentCapabilitiesTest.theProductVisionSourceIsTheOneTheSidecarComposes),
// so a change on either side breaks the other's build rather than silently
// producing two different documents for the same input.
// ---------------------------------------------------------------------------

const VISION_INPUT = {
  title: 'Vision Sciilo',
  product: 'Sciilo',
  vision: 'Comprendre son produit',
  emotions: ['savoir où on va', 'oser livrer'],
  problem: [],
  users: [],
  value: [],
  capabilities: [],
  journeys: [],
  unknowns: [],
}

const VISION_SOURCE = [
  '%% sciilo:product-vision',
  'mindmap',
  '  product(("Sciilo"))',
  '    vision["Vision"]',
  '      vision_1["Comprendre son produit"]',
  '    emotions["Desired momentum"]',
  '      emotions_1["savoir où on va"]',
  '      emotions_2["oser livrer"]',
  '    problem["Problem"]',
  '    users["Users"]',
  '    value["Value proposition"]',
  '    capabilities["Main capabilities"]',
  '    journeys["Key journeys"]',
  '    unknowns["Unknowns to confirm"]',
].join('\n')

test('the vision mindmap is composed exactly as the server used to compose it', () => {
  assert.equal(productVisionSource(VISION_INPUT), VISION_SOURCE)
})

test('the vision leaves with nothing readable but its title', async () => {
  const dek = await key()

  const args = await sealArguments(dek, 'create_product_vision', VISION_INPUT)

  // Every structured field folded into the sealed source must be gone. Shipping
  // them alongside their own ciphertext is the one mistake that would make this
  // whole boundary pointless.
  for (const field of ['product', 'vision', 'emotions', 'problem', 'users',
    'value', 'capabilities', 'journeys', 'unknowns']) {
    assert.equal(args[field], undefined, `${field} est parti en clair`)
  }
  assert.equal(args.title, 'Vision Sciilo')
  assert.equal(await openValue(dek, args.source), VISION_SOURCE)
})

test('a note is sealed against the board that holds it', async () => {
  const dek = await key()
  const board = crypto.randomUUID()

  const args = await sealArguments(dek, 'add_note', { document_id: board, content: 'Idée à protéger' })

  assert.ok(isSealed(args.content))
  assert.ok(!args.content.includes('Idée'))
  assert.equal(await openValue(dek, args.content), 'Idée à protéger')
  assert.equal(args.document_id, board)
})

test('two notes of the same board do not produce the same ciphertext', async () => {
  const dek = await key()
  const board = crypto.randomUUID()
  const note = { document_id: board, content: 'Idée à protéger' }

  const first = await sealArguments(dek, 'add_note', note)
  const second = await sealArguments(dek, 'add_note', note)

  // They share one context on purpose; what must never be shared is the nonce.
  // Equal ciphertexts would tell the server which notes are identical.
  assert.notEqual(first.content, second.content)
  assert.equal(await openValue(dek, second.content), 'Idée à protéger')
})

test('a note cannot be replanted in another board', async () => {
  const dek = await key()
  const args = await sealArguments(dek, 'add_note',
    { document_id: crypto.randomUUID(), content: 'Idée à protéger' })

  const moved = args.content.replace(/v1:[0-9a-f-]{36}:/, `v1:${crypto.randomUUID()}:`)

  await assert.rejects(() => openValue(dek, moved))
})

test('editing a note seals it too', async () => {
  const dek = await key()
  const board = crypto.randomUUID()

  const args = await sealArguments(dek, 'update_note',
    { document_id: board, note_id: crypto.randomUUID(), content: 'Version corrigée' })

  assert.equal(await openValue(dek, args.content), 'Version corrigée')
})

test('creating a noteboard carries nothing to seal', async () => {
  const input = { title: 'Idées produit' }

  // Le titre reste lisible, comme partout ailleurs : c'est écrit dans la garantie.
  assert.deepEqual(await sealArguments(await key(), 'create_noteboard', input), input)
})
