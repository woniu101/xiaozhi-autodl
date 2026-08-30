// Vue CLI sees the host's CPUs rather than the container quota. Restrict
// build-time workers to the cgroup allocation. This does not modify manager-web.
const os = require('node:os')
const fs = require('node:fs')
const hostCpus = os.cpus()
let quotaCpus = hostCpus.length
try {
  const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/)
  if (quota !== 'max') quotaCpus = Math.max(1, Math.ceil(Number(quota) / Number(period)))
} catch {}
const allocatedCpus = hostCpus.slice(0, Math.min(hostCpus.length, quotaCpus))
os.cpus = () => allocatedCpus
os.availableParallelism = () => allocatedCpus.length
