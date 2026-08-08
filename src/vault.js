// Sciilo vault — encryption of document contents.
//
// This file runs IDENTICALLY in the browser and in the sidecar. It uses Web
// Crypto only, present natively on both sides (Node >= 22), so it has no
// dependencies: the guarantee shown to users promises "a handful of files,
// readable end to end". One more third-party library is one less promise.
//
// What the server receives and cannot open:
//   - the vault record: salt + sealed data key (no usable secret)
//   - contents: nonce | ciphertext | authentication tag
//
// What the server always sees: ids, dates, titles, structure. That is
// deliberate — titles keep the library usable without opening the vault.

const VERSION = 1

// PBKDF2 rather than Argon2id: Web Crypto does not provide Argon2, and adding
// it would force a WASM blob into the browser bundle AND the sidecar. The
// trade-off is explicit and REVERSIBLE: `kdf` and `iterations` travel with the
// vault record, so moving to Argon2id later re-encrypts no document at all —
// only the 32 bytes of the data key. That is the whole point of the
// indirection below.
const KDF = 'PBKDF2-SHA-512'
const ITERATIONS = 600_000

const RECOVERY_CONTEXT = `sciilo.vault.v${VERSION}|recovery`

const SALT_BYTES = 16
const NONCE_BYTES = 12   // 96 bits: the size GCM is proven secure for
const DEK_BITS = 256

const subtle = globalThis.crypto?.subtle

if (!subtle) {
    throw new Error('Web Crypto unavailable: the vault needs a modern browser or Node >= 22.')
}

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()

/**
 * Creates a vault. Called once, at sign-up.
 *
 * Nothing returned here allows recovering the password or the data key: the
 * record can be stored in the database without further precautions.
 */
export async function createVault(password) {

    const salt = randomBytes(SALT_BYTES)
    const kek = await deriveKek(password, salt, ITERATIONS)
    // The data key is drawn at random, NEVER derived from the password. That is
    // what lets a password change re-seal 32 bytes instead of re-encrypting the
    // whole library.
    const dek = await subtle.generateKey(
        {name: 'AES-GCM', length: DEK_BITS},
        true,                       // extractable: see the note on exportDek()
        ['encrypt', 'decrypt'],
    )
    // A second, independent way in. Without it, resetting a forgotten password
    // would hand back the account and destroy the library with it: the new
    // key-encryption key cannot unseal the data key sealed by the old one.
    const recoveryCode = newRecoveryCode()
    const recoverySalt = randomBytes(SALT_BYTES)
    const record = await sealDek(dek, kek, salt)
    record.recoverySalt = toBase64(recoverySalt)
    record.recoveryDek = await sealDekWith(dek, recoveryCode, recoverySalt)
    return {record, dek, recoveryCode}
}

// Crockford base32: no I, L, O or U, so nothing can be misread off a piece of
// paper, and nothing spells a word by accident. 32 characters carry 160 bits —
// far beyond brute force, whatever the derivation cost.
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_CHARS = 32
const RECOVERY_GROUP = 4

function newRecoveryCode() {

    const draw = randomBytes(RECOVERY_CHARS)
    let code = ''
    for (let index = 0; index < RECOVERY_CHARS; index += 1) {
        if (index > 0 && index % RECOVERY_GROUP === 0) code += '-'
        code += RECOVERY_ALPHABET[draw[index] % RECOVERY_ALPHABET.length]
    }
    return code
}

/**
 * Accepts a recovery code as a human would copy it: any case, with or without
 * the dashes, and with the characters Crockford says are confusable folded onto
 * the ones they are mistaken for.
 */
export function normaliseRecoveryCode(code) {

    return String(code ?? '')
        .toUpperCase()
        .replace(/[\s-]/g, '')
        .replace(/[IL]/g, '1')
        .replace(/O/g, '0')
        .replace(/U/g, 'V')
}

/**
 * Opens the vault with the recovery code instead of the password.
 *
 * Used after a password reset: the account comes back through e-mail, the
 * contents come back through this. Both are needed, and neither alone is
 * enough — which is exactly the property we want.
 */
export async function openVaultWithRecovery(recoveryCode, record) {

    assertRecord(record)
    if (!record.recoveryDek || !record.recoverySalt) {
        throw new Error('This vault has no recovery code.')
    }
    const salt = fromBase64(record.recoverySalt)
    const key = await deriveKek(normaliseRecoveryCode(recoveryCode), salt, record.iterations)
    const wrapped = fromBase64(record.recoveryDek)
    try {
        return await subtle.unwrapKey(
            'raw',
            wrapped.subarray(NONCE_BYTES),
            key,
            {
                name: 'AES-GCM',
                iv: wrapped.subarray(0, NONCE_BYTES),
                additionalData: utf8.encode(RECOVERY_CONTEXT),
            },
            {name: 'AES-GCM', length: DEK_BITS},
            true,
            ['encrypt', 'decrypt'],
        )
    } catch {
        throw new Error('Vault locked: wrong recovery code, or altered record.')
    }
}

async function sealDekWith(dek, recoveryCode, salt) {

    const key = await deriveKek(normaliseRecoveryCode(recoveryCode), salt, ITERATIONS)
    const nonce = randomBytes(NONCE_BYTES)
    const wrapped = await subtle.wrapKey('raw', dek, key,
        {name: 'AES-GCM', iv: nonce, additionalData: utf8.encode(RECOVERY_CONTEXT)})
    return toBase64(concat(nonce, new Uint8Array(wrapped)))
}

/**
 * Opens an existing vault. Called at sign-in, with the password just typed.
 *
 * A wrong password does not "return false": GCM fails authentication and this
 * throws. There is therefore no oracle telling a wrong password apart from a
 * corrupted record.
 */
export async function openVault(password, record) {

    assertRecord(record)
    const salt = fromBase64(record.salt)
    const kek = await deriveKek(password, salt, record.iterations)
    const wrapped = fromBase64(record.wrappedDek)
    try {
        return await subtle.unwrapKey(
            'raw',
            wrapped.subarray(NONCE_BYTES),
            kek,
            {name: 'AES-GCM', iv: wrapped.subarray(0, NONCE_BYTES), additionalData: dekContext()},
            {name: 'AES-GCM', length: DEK_BITS},
            true,
            ['encrypt', 'decrypt'],
        )
    } catch {
        throw new Error('Vault locked: wrong password, or altered record.')
    }
}

/**
 * Changes the password WITHOUT touching any document.
 *
 * Only the salt and the sealed data key change: already encrypted contents stay
 * readable, because they are encrypted by the data key, which is unchanged.
 */
export async function rewrapVault(dek, newPassword, previous) {

    const salt = randomBytes(SALT_BYTES)
    const kek = await deriveKek(newPassword, salt, ITERATIONS)
    const record = await sealDek(dek, kek, salt)
    // The recovery code is a separate way in and survives password changes: the
    // slip of paper someone put away stays valid. Losing it here would be a
    // silent trap, since nothing would tell them until the day it matters.
    if (previous?.recoveryDek && previous?.recoverySalt) {
        record.recoverySalt = previous.recoverySalt
        record.recoveryDek = previous.recoveryDek
    }
    return record
}

/**
 * Encrypts a content. `context` BINDS the ciphertext to its exact location.
 *
 * Without that binding, a server unable to read would still be able to MOVE:
 * copy somebody else's encrypted content into your document, or put an old
 * version back in place of the current one. You would decrypt the lot without
 * noticing. The GCM authentication tag covers this context, so a moved block no
 * longer opens.
 */
export async function sealField(dek, plaintext, context) {

    const nonce = randomBytes(NONCE_BYTES)
    const sealed = await subtle.encrypt(
        {name: 'AES-GCM', iv: nonce, additionalData: contextBytes(context)},
        dek,
        utf8.encode(String(plaintext ?? '')),
    )
    return toBase64(concat(nonce, new Uint8Array(sealed)))
}

/**
 * Decrypts a content. Throws if the block was altered, truncated, or moved to a
 * document or field other than the one it was written for.
 */
export async function openField(dek, packed, context) {

    const bytes = fromBase64(packed)
    if (bytes.length <= NONCE_BYTES) {
        throw new Error('Unreadable encrypted content: block too short.')
    }
    try {
        const clear = await subtle.decrypt(
            {name: 'AES-GCM', iv: bytes.subarray(0, NONCE_BYTES), additionalData: contextBytes(context)},
            dek,
            bytes.subarray(NONCE_BYTES),
        )
        return fromUtf8.decode(clear)
    } catch {
        throw new Error('Unreadable encrypted content: altered, or filed under another identity.')
    }
}

/**
 * The context of a field. Two different fields of the same document, or the
 * same field across two documents, never share a context.
 */
export function fieldContext({documentId, field, ownerId = ''}) {

    if (!documentId || !field) {
        throw new Error('Incomplete context: documentId and field are required.')
    }
    return `sciilo.vault.v${VERSION}|${documentId}|${ownerId}|${field}`
}

/**
 * Exports the data key in the clear. Reserved for sealing it towards the
 * sidecar, which receives it encrypted for its ephemeral public key — never to
 * write it to disk nor to hand it to the server.
 */
export async function exportDek(dek) {

    return new Uint8Array(await subtle.exportKey('raw', dek))
}

/** Re-imports a data key obtained from exportDek(). */
export async function importDek(raw) {

    return subtle.importKey('raw', raw, {name: 'AES-GCM', length: DEK_BITS}, true,
        ['encrypt', 'decrypt'])
}

/**
 * A twin of the data key that can encrypt and decrypt but can no longer be
 * exported.
 *
 * This is what gets kept between page loads. Stored as-is in IndexedDB, the
 * browser hands back a usable handle whose bytes no script can read: an
 * injection can abuse the key while it sits on the page, but cannot carry it
 * off to decrypt the library offline, forever.
 *
 * The privileged operations — changing the password, sealing the key for a
 * sidecar — still need the exportable original, therefore the password. That
 * the key can only leave the browser right after someone proves who they are
 * is a property worth having, not a limitation to work around.
 */
export async function lockDown(dek) {

    return subtle.importKey('raw', await exportDek(dek),
        {name: 'AES-GCM', length: DEK_BITS}, false, ['encrypt', 'decrypt'])
}

// --- handing the data key to the sidecar -----------------------------------
//
// The agent must read and write contents, so the sidecar needs the data key.
// It cannot come from the server, which does not have it, and it must not be
// written to the sidecar's config file: a key at rest on the machine survives
// reboots, backups and stolen laptops, which is precisely what we are avoiding.
//
// So the sidecar mints a throwaway key pair when it starts and publishes the
// public half. The browser seals the data key for that public key alone and
// sends it through the Sciilo relay, which carries a block it cannot open. The
// private half never leaves the sidecar's memory and dies with the process.

const HANDOFF_CONTEXT = `sciilo.vault.v${VERSION}|handoff`
const HANDOFF_CURVE = {name: 'ECDH', namedCurve: 'P-256'}
const PUBLIC_KEY_BYTES = 65   // uncompressed P-256 point

/**
 * Mints the throwaway key pair. Called by the sidecar at start-up, once.
 *
 * The private key is non-extractable: it cannot be serialised, therefore it
 * cannot be written to disk, even by mistake.
 */
export async function createHandoffKeypair() {

    const pair = await subtle.generateKey(HANDOFF_CURVE, false, ['deriveBits'])
    const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey))
    return {publicKey: toBase64(publicKey), privateKey: pair.privateKey}
}

/**
 * Seals the data key for one recipient. Called by the browser when a sidecar
 * announces itself.
 *
 * A fresh ephemeral key pair is used every time, so two handoffs of the same
 * data key share nothing: an observer of the relay cannot tell they carry the
 * same secret.
 */
export async function sealDekFor(dek, recipientPublicKey) {

    const recipient = await subtle.importKey(
        'raw', fromBase64(recipientPublicKey), HANDOFF_CURVE, false, [])
    const ephemeral = await subtle.generateKey(HANDOFF_CURVE, false, ['deriveBits'])
    const shared = await handoffKey(ephemeral.privateKey, recipient)

    const nonce = randomBytes(NONCE_BYTES)
    const wrapped = await subtle.wrapKey('raw', dek, shared,
        {name: 'AES-GCM', iv: nonce, additionalData: utf8.encode(HANDOFF_CONTEXT)})
    const ephemeralPublic = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey))
    return toBase64(concat(ephemeralPublic, concat(nonce, new Uint8Array(wrapped))))
}

/**
 * Opens a sealed data key. Called by the sidecar with the private half it
 * minted at start-up.
 *
 * Throws for anything not sealed for this exact sidecar — including a block
 * replayed from another session, since the key pair changes at every start.
 */
export async function openSealedDek(privateKey, sealed) {

    const bytes = fromBase64(sealed)
    if (bytes.length <= PUBLIC_KEY_BYTES + NONCE_BYTES) {
        throw new Error('Unreadable sealed key: block too short.')
    }
    try {
        const ephemeral = await subtle.importKey(
            'raw', bytes.subarray(0, PUBLIC_KEY_BYTES), HANDOFF_CURVE, false, [])
        const shared = await handoffKey(privateKey, ephemeral)
        return await subtle.unwrapKey(
            'raw',
            bytes.subarray(PUBLIC_KEY_BYTES + NONCE_BYTES),
            shared,
            {
                name: 'AES-GCM',
                iv: bytes.subarray(PUBLIC_KEY_BYTES, PUBLIC_KEY_BYTES + NONCE_BYTES),
                additionalData: utf8.encode(HANDOFF_CONTEXT),
            },
            {name: 'AES-GCM', length: DEK_BITS},
            true,
            ['encrypt', 'decrypt'],
        )
    } catch {
        throw new Error('Unreadable sealed key: not sealed for this sidecar, or altered.')
    }
}

async function handoffKey(privateKey, publicKey) {

    // The raw shared secret is never used as a key directly: HKDF separates it
    // from any other use of the same curve and binds it to this protocol.
    const shared = await subtle.deriveBits({name: 'ECDH', public: publicKey}, privateKey, 256)
    const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
    return subtle.deriveKey(
        {name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(HANDOFF_CONTEXT)},
        material,
        {name: 'AES-GCM', length: 256},
        false,
        ['wrapKey', 'unwrapKey'],
    )
}

// --- internals -------------------------------------------------------------

async function deriveKek(password, salt, iterations) {

    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('A password is required to derive the vault key.')
    }
    const material = await subtle.importKey(
        'raw', utf8.encode(password), 'PBKDF2', false, ['deriveKey'])
    // The key-encryption key can ONLY seal and unseal the data key. It cannot
    // encrypt a document: were it to leak, it would open nothing on its own.
    return subtle.deriveKey(
        {name: 'PBKDF2', salt, iterations, hash: 'SHA-512'},
        material,
        {name: 'AES-GCM', length: 256},
        false,                      // non-extractable: it never leaves
        ['wrapKey', 'unwrapKey'],
    )
}

async function sealDek(dek, kek, salt) {

    const nonce = randomBytes(NONCE_BYTES)
    const wrapped = await subtle.wrapKey('raw', dek, kek,
        {name: 'AES-GCM', iv: nonce, additionalData: dekContext()})
    return {
        version: VERSION,
        kdf: KDF,
        iterations: ITERATIONS,
        salt: toBase64(salt),
        wrappedDek: toBase64(concat(nonce, new Uint8Array(wrapped))),
    }
}

function dekContext() {

    return utf8.encode(`sciilo.vault.v${VERSION}|dek`)
}

function contextBytes(context) {

    const value = typeof context === 'string' ? context : fieldContext(context ?? {})
    return utf8.encode(value)
}

function assertRecord(record) {

    if (!record || typeof record !== 'object') {
        throw new Error('Missing vault record.')
    }
    if (record.version !== VERSION) {
        throw new Error(`Unsupported vault version: ${record.version}.`)
    }
    if (record.kdf !== KDF) {
        throw new Error(`Unsupported derivation: ${record.kdf}.`)
    }
    if (!Number.isInteger(record.iterations) || record.iterations < 100_000) {
        throw new Error('Invalid or too weak iteration count.')
    }
}

function randomBytes(length) {

    return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

function concat(head, tail) {

    const out = new Uint8Array(head.length + tail.length)
    out.set(head, 0)
    out.set(tail, head.length)
    return out
}

// btoa/atob rather than Buffer: Buffer does not exist in a browser, and this
// file must stay strictly identical on both sides.
//
// The bytes reach btoa in slices, not one character at a time. A pasted image
// or a board thumbnail seals into megabytes, and appending byte by byte cost
// more than the encryption itself — an order of magnitude more, and it grew
// FASTER than the payload, so the biggest documents were the ones that froze
// the page. 8 KB per slice stays far under every engine's apply() argument
// limit while flattening that curve.
const B64_SLICE = 0x2000

function toBase64(bytes) {

    let binary = ''
    for (let index = 0; index < bytes.length; index += B64_SLICE) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + B64_SLICE))
    }
    return btoa(binary)
}

function fromBase64(value) {

    if (typeof value !== 'string') throw new Error('Encrypted block expected as base64.')
    const binary = atob(value)
    const out = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
        out[index] = binary.charCodeAt(index)
    }
    return out
}

export const VAULT_PARAMS = Object.freeze({version: VERSION, kdf: KDF, iterations: ITERATIONS})
