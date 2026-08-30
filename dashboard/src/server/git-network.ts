import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { RUNTIME_ROOT } from './config.js'
import { run, type CommandResult } from './process.js'

export type GitNetworkMode = 'auto' | 'direct' | 'autodl' | 'custom'
export type GitTransport = 'direct' | 'autodl' | 'custom'

export interface GitNetworkConfig {
  mode: GitNetworkMode
  customProxy?: string
}

export interface GitNetworkResult extends CommandResult {
  attempts: number
  elapsedMs: number
  transport?: GitTransport
}

type NetworkStatus = {
  checkedAt: string
  ok: boolean
  transport?: GitTransport
  elapsedMs: number
  message?: string
}

const configPath = resolve(RUNTIME_ROOT, 'config/git-network.json')
const statusPath = resolve(RUNTIME_ROOT, 'run/git-network-status.json')
const turboPath = '/etc/network_turbo'
const defaultConfig: GitNetworkConfig = { mode: 'auto' }
const proxyKeys = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
  return trimmed
}

export function parseTurboEnvironment(content: string): NodeJS.ProcessEnv {
  const allowed = new Set(['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'no_proxy', 'NO_PROXY', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE'])
  const environment: NodeJS.ProcessEnv = {}
  const expression = /export\s+([A-Za-z_][A-Za-z0-9_]*)=([^&;\n]+)/g
  for (const match of content.matchAll(expression)) {
    if (allowed.has(match[1])) environment[match[1]] = stripQuotes(match[2])
  }
  return environment
}

function normalizeProxy(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('代理地址格式无效') }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) throw new Error('代理仅支持 http、https、socks5 或 socks5h')
  if (!url.hostname || !url.port) throw new Error('代理地址需要包含主机和端口')
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('代理地址不能包含路径、查询参数或片段')
  return url.toString().replace(/\/$/, '')
}

export function validateGitNetworkConfig(input: Partial<GitNetworkConfig>, existing?: GitNetworkConfig): GitNetworkConfig {
  if (!['auto', 'direct', 'autodl', 'custom'].includes(input.mode || '')) throw new Error('不支持的 GitHub 网络模式')
  const mode = input.mode as GitNetworkMode
  const supplied = input.customProxy?.trim()
  const customProxy = supplied ? normalizeProxy(supplied) : existing?.customProxy
  if (mode === 'custom' && !customProxy) throw new Error('自定义代理模式需要填写代理地址')
  return { mode, customProxy }
}

export async function readGitNetworkConfig(): Promise<GitNetworkConfig> {
  try { return validateGitNetworkConfig(JSON.parse(await readFile(configPath, 'utf8')) as GitNetworkConfig) }
  catch { return defaultConfig }
}

export async function saveGitNetworkConfig(input: Partial<GitNetworkConfig>): Promise<GitNetworkConfig> {
  const current = await readGitNetworkConfig()
  const config = validateGitNetworkConfig(input, current)
  await mkdir(resolve(RUNTIME_ROOT, 'config'), { recursive: true })
  const temporary = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, configPath)
  return config
}

function redactProxy(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.username || url.password) {
      url.username = '[credentials]'
      url.password = ''
    }
    return url.toString().replace(/\/$/, '')
  } catch { return '[invalid proxy]' }
}

async function turboEnvironment(): Promise<NodeJS.ProcessEnv | undefined> {
  try {
    const environment = parseTurboEnvironment(await readFile(turboPath, 'utf8'))
    return environment.http_proxy || environment.HTTP_PROXY || environment.https_proxy || environment.HTTPS_PROXY ? environment : undefined
  } catch { return undefined }
}

function directEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(proxyKeys.map((key) => [key, '']))
}

async function transportEnvironment(transport: GitTransport, config: GitNetworkConfig): Promise<NodeJS.ProcessEnv | undefined> {
  if (transport === 'direct') return directEnvironment()
  if (transport === 'autodl') return turboEnvironment()
  if (!config.customProxy) return undefined
  return {
    ...directEnvironment(),
    http_proxy: config.customProxy,
    https_proxy: config.customProxy,
    HTTP_PROXY: config.customProxy,
    HTTPS_PROXY: config.customProxy,
  }
}

export function transportPlan(mode: GitNetworkMode, academicAvailable = true, customAvailable = true): GitTransport[] {
  if (mode === 'direct') return ['direct']
  if (mode === 'autodl') return academicAvailable ? ['autodl'] : []
  if (mode === 'custom') return customAvailable ? ['custom'] : []
  return academicAvailable ? ['direct', 'autodl'] : ['direct']
}

async function writeNetworkStatus(status: NetworkStatus) {
  await mkdir(resolve(RUNTIME_ROOT, 'run'), { recursive: true })
  const temporary = `${statusPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, statusPath)
}

function safeMessage(result: CommandResult): string {
  return (result.stderr || result.errorMessage || result.stdout || '')
    .trim()
    .replace(/(https?|socks5h?):\/\/[^/@\s]+@/gi, '$1://[credentials]@')
    .slice(0, 240)
}

export async function remoteGit(path: string, args: string[], options: {
  timeout?: number
  onAttempt?: (attempt: number, totalAttempts: number, transport: GitTransport) => void
} = {}): Promise<GitNetworkResult> {
  const config = await readGitNetworkConfig()
  const academicEnvironment = await turboEnvironment()
  const plan = transportPlan(config.mode, Boolean(academicEnvironment), Boolean(config.customProxy))
  const startedAt = Date.now()
  let result: CommandResult = { stdout: '', stderr: '所选网络模式当前不可用', code: 1, timedOut: false }
  let transport: GitTransport | undefined
  let attempts = 0
  for (let index = 0; index < plan.length; index++) {
    attempts = index + 1
    transport = plan[index]
    options.onAttempt?.(index + 1, plan.length, transport)
    const environment = transport === 'autodl' ? academicEnvironment : await transportEnvironment(transport, config)
    if (!environment) {
      result = { stdout: '', stderr: `${transport} 网络配置不可用`, code: 1, timedOut: false }
      continue
    }
    const requestedTimeout = options.timeout || 20_000
    const timeout = config.mode === 'auto' && transport === 'direct' ? Math.min(5_000, requestedTimeout) : requestedTimeout
    result = await run('/usr/bin/git', ['-C', path, '-c', 'http.version=HTTP/1.1', ...args], timeout, { ...environment, GIT_TERMINAL_PROMPT: '0' })
    if (result.code === 0) break
  }
  const elapsedMs = Date.now() - startedAt
  const final = { ...result, attempts, elapsedMs, transport }
  await writeNetworkStatus({ checkedAt: new Date().toISOString(), ok: final.code === 0, transport, elapsedMs, message: final.code === 0 ? undefined : safeMessage(final) })
  return final
}

export async function gitNetworkState() {
  const config = await readGitNetworkConfig()
  let status: NetworkStatus | undefined
  try { status = JSON.parse(await readFile(statusPath, 'utf8')) as NetworkStatus } catch { /* 尚未测试。 */ }
  return {
    config: {
      mode: config.mode,
      customProxyConfigured: Boolean(config.customProxy),
      customProxyDisplay: redactProxy(config.customProxy),
    },
    autodlAvailable: Boolean(await turboEnvironment()),
    lastResult: status,
  }
}

export async function testGitNetwork() {
  const result = await remoteGit('/root/xiaozhi-autodl', ['ls-remote', '--heads', 'origin', 'refs/heads/main'], { timeout: 20_000 })
  return {
    ...(await gitNetworkState()),
    test: {
      ok: result.code === 0,
      transport: result.transport,
      elapsedMs: result.elapsedMs,
      message: result.code === 0 ? 'GitHub 连接成功' : safeMessage(result) || 'GitHub 连接失败',
    },
  }
}
