import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { MANAGER_WEB_PUBLIC_URL, RUNTIME_ROOT } from './config.js'
import { run } from './process.js'

export type EndpointMode = 'autodl' | 'lan' | 'custom'

export interface EndpointConfig {
  mode: EndpointMode
  baseUrl?: string
  sshHost?: string
  sshPort?: number
  localPort?: number
}

const configPath = resolve(RUNTIME_ROOT, 'config/endpoints.json')
const defaultConfig: EndpointConfig = { mode: 'autodl', sshPort: 22, localPort: 16008 }

let lastSync: { state: 'synced' | 'pending' | 'failed'; message: string; at: string } | undefined

function normalizeBase(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('基础地址格式无效') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('基础地址仅支持 http:// 或 https://')
  if (url.username || url.password) throw new Error('基础地址不能包含账号或密码')
  if (url.search || url.hash) throw new Error('基础地址不能包含查询参数或片段')
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('基础地址只填写域名或主机与端口，不要附加路径')
  return url.origin
}

export function validateEndpointConfig(input: Partial<EndpointConfig>): EndpointConfig {
  if (!['autodl', 'lan', 'custom'].includes(input.mode || '')) throw new Error('不支持的接入模式')
  const config: EndpointConfig = { mode: input.mode as EndpointMode }
  if (config.mode !== 'autodl') {
    if (!input.baseUrl) throw new Error('请填写客户端可访问的基础地址')
    config.baseUrl = normalizeBase(input.baseUrl)
  }
  if (config.mode === 'lan') {
    config.sshHost = (input.sshHost || '').trim().slice(0, 180) || undefined
    const sshPort = Number(input.sshPort || 22)
    const localPort = Number(input.localPort || 16008)
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('SSH 端口无效')
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('本地映射端口无效')
    config.sshPort = sshPort
    config.localPort = localPort
  }
  return config
}

export async function readEndpointConfig(): Promise<EndpointConfig> {
  try {
    return validateEndpointConfig(JSON.parse(await readFile(configPath, 'utf8')) as EndpointConfig)
  } catch {
    return defaultConfig
  }
}

export async function saveEndpointConfig(input: Partial<EndpointConfig>): Promise<EndpointConfig> {
  const config = validateEndpointConfig(input)
  await mkdir(resolve(RUNTIME_ROOT, 'config'), { recursive: true })
  const temp = `${configPath}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, configPath)
  return config
}

function resolvedBase(config: EndpointConfig): { baseUrl?: string; source: string; sourceDetail?: string } {
  if (config.mode === 'autodl') {
    const value = process.env.AutoDLService6008URL || MANAGER_WEB_PUBLIC_URL
    return { baseUrl: value ? normalizeBase(value) : undefined, source: '6008 公网代理', sourceDetail: '来源：AutoDLService6008URL' }
  }
  return { baseUrl: config.baseUrl, source: config.mode === 'lan' ? '局域网 / SSH 隧道' : '自定义域名', sourceDetail: config.baseUrl }
}

function derive(baseUrl?: string) {
  if (!baseUrl) return { managerUrl: undefined, otaUrl: undefined, websocketUrl: undefined }
  const base = normalizeBase(baseUrl)
  return {
    managerUrl: `${base}/`,
    otaUrl: `${base}/xiaozhi/ota/`,
    websocketUrl: `${base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/xiaozhi/v1/`,
  }
}

async function configuredValues(): Promise<{ ota?: string; websocket?: string }> {
  const result = await run('/usr/bin/mysql', [
    '--batch', '--skip-column-names', '-h', '127.0.0.1', '-u', process.env.XIAOZHI_MYSQL_USER || 'root',
    'xiaozhi_esp32_server', '-e', "SELECT param_code,param_value FROM sys_params WHERE param_code IN ('server.ota','server.websocket') ORDER BY param_code;",
  ], 8_000, { MYSQL_PWD: process.env.XIAOZHI_MYSQL_PASSWORD || '123456' })
  if (result.code !== 0) return {}
  const values: { ota?: string; websocket?: string } = {}
  for (const line of result.stdout.trim().split('\n')) {
    const [key, ...parts] = line.split('\t')
    if (key === 'server.ota') values.ota = parts.join('\t')
    if (key === 'server.websocket') values.websocket = parts.join('\t')
  }
  return values
}

async function routeReachable(path: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:6008${path}`, { signal: AbortSignal.timeout(1_500) })
    return response.status < 500
  } catch {
    return false
  }
}

export async function endpointState() {
  const config = await readEndpointConfig()
  const resolved = resolvedBase(config)
  const urls = derive(resolved.baseUrl)
  const [configured, managerWeb, ota, websocket] = await Promise.all([
    configuredValues(),
    routeReachable('/'),
    routeReachable('/xiaozhi/ota/'),
    routeReachable('/xiaozhi/v1/'),
  ])
  const inSync = Boolean(urls.otaUrl && urls.websocketUrl && configured.ota === urls.otaUrl && configured.websocket === urls.websocketUrl)
  const tunnelCommand = config.mode === 'lan' && config.sshHost
    ? `ssh -N -p ${config.sshPort || 22} -L 0.0.0.0:${config.localPort || 16008}:127.0.0.1:6008 root@${config.sshHost}`
    : undefined
  return {
    config,
    source: resolved.source,
    sourceDetail: resolved.sourceDetail,
    ...urls,
    configured,
    inSync,
    readiness: { managerWeb, ota, websocket },
    gatewayReachable: managerWeb && ota,
    sync: lastSync,
    tunnelCommand,
  }
}

export async function syncClientEndpoints(): Promise<Awaited<ReturnType<typeof endpointState>>> {
  const config = await readEndpointConfig()
  const { baseUrl } = resolvedBase(config)
  const urls = derive(baseUrl)
  if (!urls.otaUrl || !urls.websocketUrl) {
    lastSync = { state: 'pending', message: '尚未获得 AutoDL 6008 公网地址', at: new Date().toISOString() }
    return endpointState()
  }
  const current = await configuredValues()
  if (current.ota !== urls.otaUrl || current.websocket !== urls.websocketUrl) {
    const sql = `UPDATE sys_params SET param_value = CASE param_code WHEN 'server.ota' THEN '${urls.otaUrl}' WHEN 'server.websocket' THEN '${urls.websocketUrl}' END WHERE param_code IN ('server.ota','server.websocket');`
    const updated = await run('/usr/bin/mysql', [
      '-h', '127.0.0.1', '-u', process.env.XIAOZHI_MYSQL_USER || 'root', 'xiaozhi_esp32_server', '-e', sql,
    ], 8_000, { MYSQL_PWD: process.env.XIAOZHI_MYSQL_PASSWORD || '123456' })
    if (updated.code !== 0) {
      lastSync = { state: 'failed', message: (updated.stderr || '数据库暂未就绪').trim().slice(0, 180), at: new Date().toISOString() }
      return endpointState()
    }
    await run('/usr/bin/redis-cli', ['HDEL', 'sys:params', 'server.ota', 'server.websocket'], 5_000)
  }
  lastSync = { state: 'synced', message: 'OTA 与 WebSocket 广播地址已同步', at: new Date().toISOString() }
  return endpointState()
}
