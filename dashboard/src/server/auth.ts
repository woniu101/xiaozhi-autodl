import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { FastifyRequest } from 'fastify'
import { RUNTIME_ROOT } from './config.js'

interface SecretFile {
  version: number
  salt?: string
  passwordHash?: string
  sessionSecret: string
}

export interface Session {
  id: string
  csrf: string
  expiresAt: number
}

const secretPath = resolve(RUNTIME_ROOT, 'secrets/dashboard.json')
const sessions = new Map<string, Session>()
let secrets: SecretFile
let setupInProgress = false

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

async function persist(next: SecretFile): Promise<void> {
  await mkdir(dirname(secretPath), { recursive: true, mode: 0o700 })
  const temporary = `${secretPath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, secretPath)
  secrets = next
}

export async function initializeAuth(): Promise<{ credentialPath: string; initialized: boolean }> {
  try {
    const loaded = JSON.parse(await readFile(secretPath, 'utf8')) as SecretFile & { initialPassword?: string }
    secrets = {
      version: 2,
      salt: loaded.salt,
      passwordHash: loaded.passwordHash,
      sessionSecret: loaded.sessionSecret || randomBytes(32).toString('hex'),
    }
    // 读取旧版文件后立即迁移，保留哈希口令并删除历史明文字段。
    if (loaded.version !== 2 || loaded.initialPassword || !loaded.sessionSecret) await persist(secrets)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await persist({ version: 2, sessionSecret: randomBytes(32).toString('hex') })
  }
  return { credentialPath: secretPath, initialized: isInitialized() }
}

export function isInitialized(): boolean {
  return Boolean(secrets?.salt && secrets?.passwordHash)
}

export function validatePasscode(passcode: string): string | undefined {
  if (passcode.length < 8 || passcode.length > 32 || /[\r\n\0]/.test(passcode)) {
    return '运维口令需为 8-32 位，支持数字、字母和符号'
  }
  return undefined
}

export function verifyPassword(password: string): boolean {
  if (!isInitialized()) return false
  const actual = Buffer.from(hashPassword(password, secrets.salt!), 'hex')
  const expected = Buffer.from(secrets.passwordHash!, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function setupPassword(passcode: string): Promise<void> {
  if (isInitialized() || setupInProgress) throw new Error('运维口令已经创建')
  const validation = validatePasscode(passcode)
  if (validation) throw new Error(validation)
  setupInProgress = true
  try {
    const salt = randomBytes(16).toString('hex')
    await persist({
      version: 2,
      salt,
      passwordHash: hashPassword(passcode, salt),
      sessionSecret: secrets.sessionSecret,
    })
    sessions.clear()
  } finally {
    setupInProgress = false
  }
}

export async function changePassword(current: string, next: string): Promise<void> {
  if (!verifyPassword(current)) throw new Error('当前口令不正确')
  const validation = validatePasscode(next)
  if (validation) throw new Error(validation)
  const salt = randomBytes(16).toString('hex')
  await persist({
    version: 2,
    salt,
    passwordHash: hashPassword(next, salt),
    sessionSecret: randomBytes(32).toString('hex'),
  })
  sessions.clear()
}

function signature(id: string): string {
  return createHmac('sha256', secrets.sessionSecret).update(id).digest('base64url')
}

export function createSession(): { cookie: string; session: Session } {
  const id = randomBytes(24).toString('base64url')
  const session = { id, csrf: randomBytes(24).toString('base64url'), expiresAt: Date.now() + 12 * 60 * 60 * 1000 }
  sessions.set(id, session)
  return { cookie: `${id}.${signature(id)}`, session }
}

export function getSession(request: FastifyRequest): Session | undefined {
  const raw = request.cookies.xiaozhi_dashboard
  if (!raw) return undefined
  const [id, sig] = raw.split('.')
  if (!id || !sig) return undefined
  const actual = Buffer.from(sig)
  const expected = Buffer.from(signature(id))
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  const session = sessions.get(id)
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(id)
    return undefined
  }
  session.expiresAt = Date.now() + 12 * 60 * 60 * 1000
  return session
}

export function destroySession(request: FastifyRequest): void {
  const id = request.cookies.xiaozhi_dashboard?.split('.')[0]
  if (id) sessions.delete(id)
}
