const VERSION = 1

const KDF = 'PBKDF2-SHA-512'
const ITERATIONS = 600_000

const RECOVERY_CONTEXT = `sciilo.vault.v${VERSION}|recovery`

const SALT_BYTES = 16
const NONCE_BYTES = 12  
const DEK_BITS = 256

const subtle = globalThis.crypto?.subtle

if (!subtle) {
    throw new Error('Web Crypto unavailable!')
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export async function createVault(password) {

    const salt = randomBytes(SALT_BYTES)
    const kek = await deriveKek(password, salt, ITERATIONS)

    const dek = await subtle.generateKey(
        {name: 'AES-GCM', length: DEK_BITS},
        true,                       // extractable: see the note on exportDek()
        ['encrypt', 'decrypt'],
    )

    const recoveryCode = newRecoveryCode()
    const recoverySalt = randomBytes(SALT_BYTES)
    const record = await sealDek(dek, kek, salt)
    record.recoverySalt = toBase64(recoverySalt)
    record.recoveryDek = await sealDekWith(dek, recoveryCode, recoverySalt)
    return {record, dek, recoveryCode}
}

const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_CHARS = 32
const RECOVERY_GROUP = 4

function newRecoveryCode() {

    const draw = randomBytes(RECOVERY_CHARS);

    let code = '';

    for (let index = 0; index < RECOVERY_CHARS; index += 1) {
        if (index > 0 && index % RECOVERY_GROUP === 0) code += '-'
        code += RECOVERY_ALPHABET[draw[index] % RECOVERY_ALPHABET.length]
    }

    return code
}

export function normaliseRecoveryCode(code) {

    return String(code ?? '')
        .toUpperCase()
        .replace(/[\s-]/g, '')
        .replace(/[IL]/g, '1')
        .replace(/O/g, '0')
        .replace(/U/g, 'V')
}

export async function openVaultWithRecovery(recoveryCode, record) {

    assertRecord(record);

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
                additionalData: utf8Encoder.encode(RECOVERY_CONTEXT),
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
        {name: 'AES-GCM', iv: nonce, additionalData: utf8Encoder.encode(RECOVERY_CONTEXT)})
    return toBase64(concat(nonce, new Uint8Array(wrapped)))
}

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

export async function rewrapVault(dek, newPassword, previous) {

    const salt = randomBytes(SALT_BYTES)
    const kek = await deriveKek(newPassword, salt, ITERATIONS)
    const record = await sealDek(dek, kek, salt)

    if (previous?.recoveryDek && previous?.recoverySalt) {
        record.recoverySalt = previous.recoverySalt
        record.recoveryDek = previous.recoveryDek
    }
    return record
}

export async function sealField(dek, plaintext, context) {

    const nonce = randomBytes(NONCE_BYTES)
    const sealed = await subtle.encrypt(
        {name: 'AES-GCM', iv: nonce, additionalData: contextBytes(context)},
        dek,
        utf8Encoder.encode(String(plaintext ?? '')),
    )
    return toBase64(concat(nonce, new Uint8Array(sealed)))
}

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
        return utf8Decoder.decode(clear)
    } catch {
        throw new Error('Unreadable encrypted content: altered, or filed under another identity.')
    }
}

export function fieldContext({documentId, field, ownerId = ''}) {

    if (!documentId || !field) {
        throw new Error('Incomplete context: documentId and field are required.')
    }
    return `sciilo.vault.v${VERSION}|${documentId}|${ownerId}|${field}`
}

export async function exportDek(dek) {

    return new Uint8Array(await subtle.exportKey('raw', dek))
}

export async function importDek(raw) {

    return subtle.importKey('raw', raw, {name: 'AES-GCM', length: DEK_BITS}, true,
        ['encrypt', 'decrypt'])
}


export async function lockDown(dek) {

    return subtle.importKey('raw', await exportDek(dek),
        {name: 'AES-GCM', length: DEK_BITS}, false, ['encrypt', 'decrypt'])
}

const HANDOFF_CONTEXT = `sciilo.vault.v${VERSION}|handoff`
const HANDOFF_CURVE = {name: 'ECDH', namedCurve: 'P-256'}
const PUBLIC_KEY_BYTES = 65   // uncompressed P-256 point

export async function createHandoffKeypair() {

    const pair = await subtle.generateKey(HANDOFF_CURVE, false, ['deriveBits'])
    const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey))
    return {publicKey: toBase64(publicKey), privateKey: pair.privateKey}
}

export async function sealDekFor(dek, recipientPublicKey) {

    const recipient = await subtle.importKey('raw', fromBase64(recipientPublicKey), HANDOFF_CURVE, false, []);

    const ephemeral = await subtle.generateKey(HANDOFF_CURVE, false, ['deriveBits']);

    const shared = await handoffKey(ephemeral.privateKey, recipient);

    const nonce = randomBytes(NONCE_BYTES);

    const wrapped = await subtle.wrapKey('raw', dek, shared, {name: 'AES-GCM', iv: nonce, additionalData: utf8Encoder.encode(HANDOFF_CONTEXT)});

    const ephemeralPublic = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));

    return toBase64(concat(ephemeralPublic, concat(nonce, new Uint8Array(wrapped))));
}

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
                additionalData: utf8Encoder.encode(HANDOFF_CONTEXT),
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

    const shared = await subtle.deriveBits({name: 'ECDH', public: publicKey}, privateKey, 256)
    const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
    return subtle.deriveKey(
        {name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Encoder.encode(HANDOFF_CONTEXT)},
        material,
        {name: 'AES-GCM', length: 256},
        false,
        ['wrapKey', 'unwrapKey'],
    )
}

// --- internals -------------------------------------------------------------

async function deriveKek(password, salt, iterations) {

    if (typeof password !== 'string' || password.length === 0) {

        throw new Error('A password is required to derive the vault key.');

    }

    const material = await subtle.importKey(
        'raw', utf8Encoder.encode(password), 'PBKDF2', false, ['deriveKey'])

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

    const wrapped = await subtle.wrapKey('raw', dek, kek, {name: 'AES-GCM', iv: nonce, additionalData: dekContext()});

    return {
        version: VERSION,
        kdf: KDF,
        iterations: ITERATIONS,
        salt: toBase64(salt),
        wrappedDek: toBase64(concat(nonce, new Uint8Array(wrapped))),
    }

}

function dekContext() {

    return utf8Encoder.encode(`sciilo.vault.v${VERSION}|dek`)
}

function contextBytes(context) {

    const value = typeof context === 'string' ? context : fieldContext(context ?? {})
    return utf8Encoder.encode(value)
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

function toBase64(bytes) {

    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
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
