import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { RUNTIME_ROOT, type ServiceName } from './config.js'
import { run } from './process.js'

export type SignalTone = 'normal' | 'info' | 'warning' | 'critical' | 'muted'

export interface ServiceSignal {
  label: string
  value: string
  tone: SignalTone
  logLevel?: 'all' | 'info' | 'warn' | 'error'
  logKeyword?: string
  logSource?: 'service' | 'access' | 'error' | 'raw' | 'slow'
  logPreset?: 'http-errors' | 'manager-requests'
}

type StabilityEntry = {
  lastPid?: number
  wasRunning: boolean
  everSeen: boolean
  lastStartedAt?: string
  restartTimes: string[]
}

type StabilityRecord = Partial<Record<ServiceName, StabilityEntry>>

const stabilityPath = resolve(RUNTIME_ROOT, 'run/service-stability.json')
let stabilityRecord: StabilityRecord | undefined
let previousSlowQueries: number | undefined
let stabilityQueue: Promise<unknown> = Promise.resolve()
const signalCache = new Map<ServiceName, { at: number; value: ServiceSignal[] }>()

async function readTail(path: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const stats = await handle.stat()
    const length = Math.min(stats.size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, stats.size - length))
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

function lineTime(line: string): number | undefined {
  const iso = line.match(/\b(20\d{2})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (iso) return Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6]}+08:00`)
  const compact = line.match(/\b(\d{2})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
  if (compact) return Date.parse(`20${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}+08:00`)
  const nginx = line.match(/\[(\d{2})\/([A-Za-z]{3})\/(20\d{2}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\]/)
  if (nginx) return Date.parse(`${nginx[1]} ${nginx[2]} ${nginx[3]} ${nginx[4]}:${nginx[5]}:${nginx[6]} ${nginx[7]}`)
  return undefined
}

async function recentLines(path: string, seconds: number): Promise<string[]> {
  try {
    const threshold = Date.now() - seconds * 1000
    return (await readTail(path)).split('\n').filter((line) => {
      const timestamp = lineTime(line)
      return timestamp !== undefined && timestamp >= threshold
    })
  } catch {
    return []
  }
}

function errorCount(lines: string[]) {
  return lines.filter((line) => /(?:ERROR|FATAL|CRITICAL|Traceback|\[error\])/i.test(line)).length
}

async function establishedConnections(port: number): Promise<number | undefined> {
  const result = await run('/usr/bin/ss', ['-Htn', 'state', 'established', `( sport = :${port} )`])
  if (result.code !== 0) return undefined
  return result.stdout.split('\n').filter(Boolean).length
}

async function nginxSignals(kind: 'gateway' | 'manager'): Promise<ServiceSignal[]> {
  const lines = await recentLines(resolve(RUNTIME_ROOT, 'logs/nginx-access.log'), 60)
  const selected = kind === 'manager'
    ? lines.filter((line) => /"(?:GET|POST|PUT|DELETE|PATCH) \/xiaozhi\/(?!v1\/)/.test(line))
    : lines.filter((line) => !/"(?:node|undici)"\s*$/i.test(line))
  const failures = selected.filter((line) => /"\s[45]\d\d\s/.test(line)).length
  const connections = await establishedConnections(kind === 'gateway' ? 6008 : 8002)
  if (kind === 'manager') return [
    { label: '请求/分钟', value: String(selected.length), tone: 'info', logSource: 'access', logPreset: 'manager-requests' },
    { label: '接口连接', value: connections === undefined ? '--' : String(connections), tone: connections === undefined ? 'muted' : 'normal' },
    { label: '4xx / 5xx', value: String(failures), tone: failures ? 'critical' : 'normal', logSource: 'access', logPreset: 'http-errors' },
  ]
  return [
    { label: '当前连接', value: connections === undefined ? '--' : String(connections), tone: connections === undefined ? 'muted' : 'normal' },
    { label: '请求/分钟', value: String(selected.length), tone: 'info', logSource: 'access' },
    { label: '4xx / 5xx', value: String(failures), tone: failures ? 'critical' : 'normal', logSource: 'access', logPreset: 'http-errors' },
  ]
}

async function jvmHeap(pid?: number): Promise<string> {
  if (!pid) return '--'
  const result = await run('/usr/bin/jcmd', [String(pid), 'GC.heap_info'], 4_000)
  if (result.code !== 0) return '--'
  let used = 0
  let total = 0
  for (const match of result.stdout.matchAll(/generation\s+total\s+(\d+)K,\s+used\s+(\d+)K/g)) {
    total += Number(match[1])
    used += Number(match[2])
  }
  return total ? `${Math.round(used / 1024)} / ${Math.round(total / 1024)} MB` : '--'
}

async function managerSignals(pid?: number, latencyMs?: number): Promise<ServiceSignal[]> {
  const base = await nginxSignals('manager')
  return [
    base[0],
    { label: '响应时间', value: latencyMs === undefined ? '--' : `${latencyMs} ms`, tone: latencyMs === undefined ? 'muted' : latencyMs >= 1_200 ? 'critical' : latencyMs >= 500 ? 'warning' : 'normal' },
    { label: 'JVM 堆内存', value: await jvmHeap(pid), tone: 'info' },
  ]
}

async function xiaozhiSignals(): Promise<ServiceSignal[]> {
  const recent = await recentLines(resolve(RUNTIME_ROOT, 'logs/xiaozhi-server.log'), 5 * 60)
  const sessions = recent.filter((line) => /\[core\.connection\].* conn - Headers:/.test(line)).length
  const errors = errorCount(recent)
  const connections = await establishedConnections(8000)
  return [
    { label: '活动连接', value: connections === undefined ? '--' : String(connections), tone: connections === undefined ? 'muted' : 'info' },
    { label: '5分钟会话', value: String(sessions), tone: 'normal', logSource: 'service', logKeyword: 'conn - Headers' },
    { label: '5分钟错误', value: String(errors), tone: errors ? 'critical' : 'normal', logSource: 'service', logLevel: 'error' },
  ]
}

async function indexSignals(): Promise<ServiceSignal[]> {
  try {
    const response = await fetch('http://127.0.0.1:8092/internal/metrics', { signal: AbortSignal.timeout(1_200) })
    if (!response.ok) throw new Error('metrics unavailable')
    const data = await response.json() as { device?: string; queued?: number; active?: number; lastInferenceAgoSeconds?: number | null; errors5m?: number }
    const waiting = data.queued ?? 0
    const last = data.lastInferenceAgoSeconds ?? undefined
    return [
      { label: '推理设备', value: data.device?.startsWith('cuda') ? 'GPU' : data.device === 'cpu' ? 'CPU' : '--', tone: data.device ? 'info' : 'muted' },
      { label: '等待 / 活动', value: `${waiting} / ${data.active ?? 0}`, tone: waiting >= 2 ? 'warning' : 'normal' },
      { label: '最近合成', value: last === undefined ? '--' : last < 60 ? `${last.toFixed(0)} 秒前` : `${Math.floor(last / 60)} 分前`, tone: (data.errors5m || 0) > 0 ? 'critical' : last === undefined ? 'muted' : 'normal', logSource: 'service', logLevel: (data.errors5m || 0) > 0 ? 'error' : 'all' },
    ]
  } catch {
    return [
      { label: '推理设备', value: '--', tone: 'muted' },
      { label: '等待 / 活动', value: '--', tone: 'muted' },
      { label: '最近合成', value: '--', tone: 'muted', logSource: 'service' },
    ]
  }
}

function parseKeyValues(content: string) {
  return new Map(content.split('\n').map((line) => line.trim().split(/\s+|:/, 2) as [string, string]).filter(([key, value]) => key && value !== undefined))
}

async function mysqlSignals(): Promise<ServiceSignal[]> {
  const result = await run('/usr/bin/mysql', [
    '--batch', '--skip-column-names', '-h', '127.0.0.1', '-u', process.env.XIAOZHI_MYSQL_USER || 'root',
    '-e', "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Slow_queries'); SHOW VARIABLES LIKE 'max_connections';",
  ], 5_000, { MYSQL_PWD: process.env.XIAOZHI_MYSQL_PASSWORD || '123456' })
  if (result.code !== 0) return ['当前连接', '连接使用率', '慢查询增量'].map((label) => ({ label, value: '--', tone: 'muted' as const }))
  const values = parseKeyValues(result.stdout)
  const connected = Number(values.get('Threads_connected'))
  const max = Number(values.get('max_connections'))
  const slow = Number(values.get('Slow_queries'))
  const slowDelta = Number.isFinite(previousSlowQueries) && Number.isFinite(slow) ? Math.max(0, slow - (previousSlowQueries as number)) : 0
  previousSlowQueries = Number.isFinite(slow) ? slow : previousSlowQueries
  const percent = max > 0 ? connected / max * 100 : undefined
  return [
    { label: '当前连接', value: Number.isFinite(connected) ? String(connected) : '--', tone: 'info' },
    { label: '连接使用率', value: percent === undefined ? '--' : `${percent.toFixed(1)}%`, tone: percent === undefined ? 'muted' : percent >= 85 ? 'critical' : percent >= 70 ? 'warning' : 'normal' },
    { label: '慢查询增量', value: `+${slowDelta}`, tone: slowDelta ? 'warning' : 'normal' },
  ]
}

async function redisSignals(): Promise<ServiceSignal[]> {
  const result = await run('/usr/bin/redis-cli', ['INFO'], 4_000)
  if (result.code !== 0) return ['客户端数', 'Redis 内存', '缓存命中率'].map((label) => ({ label, value: '--', tone: 'muted' as const }))
  const values = new Map(result.stdout.split('\n').map((line) => line.trim().split(':', 2) as [string, string]))
  const clients = Number(values.get('connected_clients'))
  const memory = Number(values.get('used_memory'))
  const hits = Number(values.get('keyspace_hits'))
  const misses = Number(values.get('keyspace_misses'))
  const attempts = hits + misses
  const rate = attempts > 0 ? hits / attempts * 100 : undefined
  return [
    { label: '客户端数', value: Number.isFinite(clients) ? String(clients) : '--', tone: 'info' },
    { label: 'Redis 内存', value: Number.isFinite(memory) ? `${Math.round(memory / 1024 / 1024)} MB` : '--', tone: Number.isFinite(memory) ? 'normal' : 'muted' },
    { label: '缓存命中率', value: rate === undefined ? '--' : `${rate.toFixed(1)}%`, tone: rate === undefined ? 'muted' : rate < 60 ? 'warning' : 'normal' },
  ]
}

async function loadStabilityRecord(): Promise<StabilityRecord> {
  if (stabilityRecord) return stabilityRecord
  try { stabilityRecord = JSON.parse(await readFile(stabilityPath, 'utf8')) as StabilityRecord }
  catch { stabilityRecord = {} }
  return stabilityRecord
}

async function persistStabilityRecord(record: StabilityRecord) {
  await mkdir(resolve(RUNTIME_ROOT, 'run'), { recursive: true })
  const temporary = `${stabilityPath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, stabilityPath)
}

async function updateStability(name: ServiceName, pid?: number) {
  const record = await loadStabilityRecord()
  const now = new Date()
  const running = Boolean(pid)
  const entry = record[name] || { wasRunning: false, everSeen: false, restartTimes: [] }
  let changed = false
  if (running && (!entry.wasRunning || (entry.lastPid && entry.lastPid !== pid))) {
    if (entry.everSeen) entry.restartTimes.push(now.toISOString())
    entry.lastStartedAt = now.toISOString()
    entry.everSeen = true
    changed = true
  }
  if (entry.wasRunning !== running || (pid && entry.lastPid !== pid)) changed = true
  entry.wasRunning = running
  if (pid) entry.lastPid = pid
  const cutoff = now.getTime() - 10 * 60 * 1000
  const recent = entry.restartTimes.filter((value) => new Date(value).getTime() >= cutoff)
  if (recent.length !== entry.restartTimes.length) changed = true
  entry.restartTimes = recent
  record[name] = entry
  if (changed) await persistStabilityRecord(record)
  return { restartCount10m: recent.length, lastStartedAt: entry.lastStartedAt }
}

export function observeStability(name: ServiceName, pid?: number) {
  const task = stabilityQueue.then(() => updateStability(name, pid))
  stabilityQueue = task.catch(() => undefined)
  return task
}

export async function serviceSignals(name: ServiceName, pid?: number, healthLatencyMs?: number): Promise<ServiceSignal[]> {
  const cached = signalCache.get(name)
  if (cached && Date.now() - cached.at < 4_000) return cached.value
  const value = name === 'xiaozhi-server' ? await xiaozhiSignals()
    : name === 'web-gateway' ? await nginxSignals('gateway')
      : name === 'manager-api' ? await managerSignals(pid, healthLatencyMs)
        : name === 'index-tts' ? await indexSignals()
          : name === 'mysql' ? await mysqlSignals()
            : await redisSignals()
  signalCache.set(name, { at: Date.now(), value })
  return value
}
