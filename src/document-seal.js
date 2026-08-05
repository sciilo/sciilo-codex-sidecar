import { fieldContext, openField, sealField } from './vault.js'

export const MARKER = 'sciilo:sealed:v1:'

const TOKEN = /sciilo:sealed:v1:([0-9a-fA-F-]{36}):([a-z_]+):([A-Za-z0-9+/]+={0,2})/g

export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(MARKER)
}

function contextOf(documentId, field) {
  return fieldContext({ documentId, field })
}

export async function sealValue(key, documentId, field, plaintext) {
  const sealed = await sealField(key, String(plaintext), contextOf(documentId, field))
  return `${MARKER}${documentId}:${field}:${sealed}`
}

export async function openValue(key, token) {
  const parts = TOKEN.exec(token)
  TOKEN.lastIndex = 0
  if (!parts) throw new Error('Not a sealed field.')
  const [, documentId, field, payload] = parts
  return openField(key, payload, contextOf(documentId, field))
}

export async function openText(key, text) {
  if (typeof text !== 'string' || !text.includes(MARKER)) return text
  const tokens = text.match(TOKEN) || []
  let out = text
  for (const token of tokens) {
    try {
      out = out.replace(token, await openValue(key, token))
    } catch {
      // ...
    }
  }
  return out
}

export function diagramKind(language, source) {
  const lang = String(language || '').trim().toLowerCase()
  const lower = String(source || '').trim().toLowerCase()

  if (lang === 'plantuml') {
    if (/\b(?:class|interface|enum|annotation|entity|struct)\b/.test(lower)) {
      return 'Class diagram'
    }
    if (lower.includes('[*]') || /\bstate\s+[\w"]/.test(lower)) return 'State diagram'
    return 'Sequence diagram'
  }
  if (lang !== 'mermaid') return 'Diagram'

  if (lower.includes('%% sciilo:product-vision')) return 'Product Vision'
  if (/^erdiagram\b/.test(lower)) return 'Data model'
  if (/^classdiagram\b/.test(lower)) return 'Class diagram'
  if (/^sequencediagram\b/.test(lower)) return 'Sequence diagram'
  if (/^statediagram(?:-v2)?\b/.test(lower)) return 'State diagram'
  if (/^mindmap\b/.test(lower)) return 'Mind map'
  if (/^journey\b/.test(lower)) return 'User journey'
  if (/^c4(?:context|container|component|dynamic|deployment)\b/.test(lower)) return 'C4 architecture'
  if (/^(?:flowchart|graph)\b/.test(lower)) return 'Flowchart'
  return 'Mermaid diagram'
}

/** PlantUML announces itself; everything else here is Mermaid. */
export function guessLanguage(source) {
  return /^\s*@startuml/i.test(String(source || '')) ? 'plantuml' : 'mermaid'
}

export function excerptOf(source) {
  const plain = String(source || '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 180 ? `${plain.slice(0, 177).trimEnd()}...` : plain
}

const VISION_MARKER = '%% sciilo:product-vision'

const VISION_SECTIONS = [
  ['emotions', 'Desired momentum'],
  ['problem', 'Problem'],
  ['users', 'Users'],
  ['value', 'Value proposition'],
  ['capabilities', 'Main capabilities'],
  ['journeys', 'Key journeys'],
  ['unknowns', 'Unknowns to confirm'],
]

function visionEscaped(value) {
  return String(value ?? '').replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/"/g, '#quot;')
}

function visionBranch(lines, key, label, items) {
  lines.push(`    ${key}["${visionEscaped(label)}"]`)
  items.forEach((item, index) => {
    lines.push(`      ${key}_${index + 1}["${visionEscaped(item)}"]`)
  })
}

function visionList(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(value => String(value ?? '').trim()).filter(Boolean).slice(0, 6)
}

export function productVisionSource(args = {}) {
  const lines = [VISION_MARKER, 'mindmap', `  product(("${visionEscaped(args.product)}"))`]
  visionBranch(lines, 'vision', 'Vision', [String(args.vision ?? '')])
  for (const [key, label] of VISION_SECTIONS) {
    visionBranch(lines, key, label, visionList(args[key]))
  }
  return lines.join('\n')
}

const CONTENT_TOOLS = {
  create_diagram: { fields: ['source'], creates: true, derive: deriveDiagram },
  update_diagram: { fields: ['source'], idFrom: 'document_id', derive: deriveDiagram },
  create_markdown_board: { fields: ['source', 'excerpt'], creates: true, derive: deriveMarkdown },
  update_markdown_board: { fields: ['source', 'excerpt'], idFrom: 'document_id', derive: deriveMarkdown },
  create_product_vision: {
    fields: ['source'],
    creates: true,
    derive: deriveVision,
    strip: ['product', 'vision', ...VISION_SECTIONS.map(([key]) => key)],
  },

  add_note: { fields: ['content'], idFrom: 'document_id' },
  update_note: { fields: ['content'], idFrom: 'document_id' },
}

function deriveDiagram(args) {
  const lang = args.lang || guessLanguage(args.source)
  return { kind: diagramKind(lang, args.source) }
}

function deriveMarkdown(args) {
  return { excerpt: excerptOf(args.source) }
}

function deriveVision(args) {
  return { source: productVisionSource(args), lang: 'mermaid' }
}

/**
 * Seals the content-bearing arguments of a tool call.
 *
 * Returns the arguments unchanged when there is no key, when the tool carries
 * no content, or when there is nothing to seal. Refusing to write would be a
 * worse failure than writing in clear: the user would lose the work, and the
 * database guard already reports anything readable that reaches storage.
 */
export async function sealArguments(key, tool, args) {
  const spec = CONTENT_TOOLS[tool]
  if (!key || !spec || !args || typeof args !== 'object') return args

  const sealedArgs = { ...args, ...(spec.derive ? spec.derive(args) : {}) }
  const documentId = spec.creates
    ? (sealedArgs.documentId = randomId())
    : sealedArgs[spec.idFrom]
  if (!documentId) return args

  for (const field of spec.fields) {
    const value = sealedArgs[field]
    if (typeof value !== 'string' || !value || isSealed(value)) continue
    sealedArgs[field] = await sealValue(key, documentId, field, value)
  }
  for (const field of spec.strip || []) {
    delete sealedArgs[field]
  }
  return sealedArgs
}

function randomId() {
  return crypto.randomUUID()
}
