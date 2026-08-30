import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { run } from './process.js'

type CpuSample = { usageUsec: number; periods: number; throttledPeriods: number; sampledAtUsec: number }

let previousCpu: CpuSample | undefined

async function readNumber(path: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(path, 'utf8')).trim())
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

async function allocatedCores(): Promise<number> {
  try {
    const [quota, period] = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(/\s+/)
    if (quota !== 'max') {
      const cores = Number(quota) / Number(period)
      if (Number.isFinite(cores) && cores > 0) return Math.round(cores * 100) / 100
    }
  } catch {}
  return os.availableParallelism()
}

async function cpuSample(): Promise<CpuSample> {
  const content = await readFile('/sys/fs/cgroup/cpu.stat', 'utf8')
  const values = new Map(content.trim().split('\n').map((line) => {
    const [key, value] = line.trim().split(/\s+/)
    return [key, Number(value)]
  }))
  return {
    usageUsec: values.get('usage_usec') || 0,
    periods: values.get('nr_periods') || 0,
    throttledPeriods: values.get('nr_throttled') || 0,
    sampledAtUsec: Number(process.hrtime.bigint() / 1_000n),
  }
}

async function cpuUsage(cores: number): Promise<{ usage: number; throttled: number }> {
  try {
    let current = await cpuSample()
    if (!previousCpu) {
      previousCpu = current
      await new Promise((resolve) => setTimeout(resolve, 120))
      current = await cpuSample()
    }
    const elapsed = current.sampledAtUsec - previousCpu.sampledAtUsec
    const capacity = elapsed * cores
    const usage = capacity > 0 ? (current.usageUsec - previousCpu.usageUsec) / capacity * 100 : 0
    const periodDelta = current.periods - previousCpu.periods
    const throttled = periodDelta > 0 ? (current.throttledPeriods - previousCpu.throttledPeriods) / periodDelta * 100 : 0
    previousCpu = current
    return {
      usage: Math.round(Math.max(0, Math.min(usage, 100)) * 10) / 10,
      throttled: Math.round(Math.max(0, Math.min(throttled, 100)) * 10) / 10,
    }
  } catch {
    return { usage: 0, throttled: 0 }
  }
}

async function memory() {
  const current = await readNumber('/sys/fs/cgroup/memory.current')
  let total = os.totalmem()
  try {
    const raw = (await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim()
    const limit = raw === 'max' ? undefined : Number(raw)
    if (Number.isFinite(limit) && (limit as number) > 0) total = limit as number
  } catch {}
  const used = Number.isFinite(current) ? current as number : total - os.freemem()
  const free = Math.max(0, total - used)
  return {
    total,
    used,
    free,
    percent: Math.round(Math.max(0, Math.min(used / total * 100, 100)) * 10) / 10,
  }
}

async function containerUptime(): Promise<number> {
  const result = await run('/usr/bin/ps', ['-p', '1', '-o', 'etimes='])
  const seconds = Number(result.stdout.trim())
  return result.code === 0 && Number.isFinite(seconds) ? seconds : os.uptime()
}

async function disks() {
  const result = await run('/usr/bin/df', ['-B1', '--output=size,used,avail,pcent,target', '/', '/root/autodl-tmp'])
  if (result.code !== 0) return []
  const byMount = new Map<string, { total: number; used: number; free: number; percent: number; mount: string }>()
  for (const line of result.stdout.trim().split('\n').slice(1)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/)
    if (!match) continue
    byMount.set(match[5], {
      total: Number(match[1]),
      used: Number(match[2]),
      free: Number(match[3]),
      percent: Number(match[4]),
      mount: match[5],
    })
  }
  return [...byMount.values()]
}

async function gpu() {
  const result = await run('/usr/bin/nvidia-smi', [
    '--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total',
    '--format=csv,noheader,nounits',
  ], 5_000)
  if (result.code !== 0) return []
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [name, temperature, utilization, memoryUsed, memoryTotal] = line.split(',').map((item) => item.trim())
    return { name, temperature: Number(temperature), utilization: Number(utilization), memoryUsed: Number(memoryUsed), memoryTotal: Number(memoryTotal) }
  })
}

export async function systemMetrics() {
  const cores = await allocatedCores()
  const [cpu, memoryStats, uptime, diskStats, gpuStats] = await Promise.all([
    cpuUsage(cores),
    memory(),
    containerUptime(),
    disks(),
    gpu(),
  ])
  return {
    scope: 'container-cgroup-v2',
    cpu: { ...cpu, cores },
    memory: memoryStats,
    uptime,
    disks: diskStats,
    gpu: gpuStats,
  }
}
