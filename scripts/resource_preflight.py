#!/usr/bin/env python3
"""Lightweight cgroup/GPU/dependency checks for heavyweight services."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULTS_PATH = Path("/root/xiaozhi-autodl/config/defaults.env")


def load_defaults(path: Path = DEFAULTS_PATH) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return None


def cpu_limit(cgroup_root: Path) -> float:
    value = read_text(cgroup_root / "cpu.max")
    if value:
        parts = value.split()
        if len(parts) == 2 and parts[0] != "max":
            try:
                quota, period = float(parts[0]), float(parts[1])
                if quota > 0 and period > 0:
                    return max(0.01, quota / period)
            except ValueError:
                pass
    return float(os.cpu_count() or 1)


def memory_limit_mb(cgroup_root: Path) -> float:
    value = read_text(cgroup_root / "memory.max")
    if value and value != "max":
        try:
            return int(value) / 1024 / 1024
        except ValueError:
            pass
    meminfo = read_text(Path("/proc/meminfo")) or ""
    for line in meminfo.splitlines():
        if line.startswith("MemTotal:"):
            try:
                return int(line.split()[1]) / 1024
            except (IndexError, ValueError):
                break
    return 0


def gpu_memory_mb(command: str) -> tuple[bool, float]:
    try:
        result = subprocess.run(
            [command, "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, 0
    values: list[float] = []
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            try:
                values.append(float(line.strip()))
            except ValueError:
                continue
    return bool(values), max(values, default=0)


def url_ready(url: str) -> bool:
    request = urllib.request.Request(url, headers={"x-xiaozhi-health-probe": "1"})
    try:
        with urllib.request.urlopen(request, timeout=1.5) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


@dataclass
class Check:
    key: str
    label: str
    ok: bool
    actual: Any
    required: Any
    unit: str = ""


def display_number(value: float) -> str:
    if math.isclose(value, round(value), abs_tol=0.01):
        return str(int(round(value)))
    return f"{value:.1f}"


def evaluate(service: str, resources_only: bool = False) -> dict[str, Any]:
    cgroup_root = Path(os.environ.get("XIAOZHI_CGROUP_ROOT", "/sys/fs/cgroup"))
    cpu = cpu_limit(cgroup_root)
    memory_mb = memory_limit_mb(cgroup_root)
    checks: list[Check] = []

    if service == "index-tts":
        min_cpu = env_float("INDEXTTS_MIN_CPU_CORES", 2)
        min_memory = env_float("INDEXTTS_MIN_MEMORY_MB", 8192)
        min_vram = env_float("INDEXTTS_MIN_GPU_MEMORY_MB", 8192)
        gpu_found, vram = gpu_memory_mb(os.environ.get("XIAOZHI_NVIDIA_SMI", "/usr/bin/nvidia-smi"))
        checks.extend([
            Check("cpu", "CPU", cpu >= min_cpu, round(cpu, 2), min_cpu, "核"),
            Check("memory", "内存", memory_mb >= min_memory, round(memory_mb), min_memory, "MB"),
            Check("gpu", "NVIDIA GPU", gpu_found, gpu_found, True),
            Check("vram", "显存", gpu_found and vram >= min_vram, round(vram), min_vram, "MB"),
        ])
    elif service == "xiaozhi-server":
        min_cpu = env_float("XIAOZHI_MIN_CPU_CORES", 1)
        min_memory = env_float("XIAOZHI_MIN_MEMORY_MB", 4096)
        checks.extend([
            Check("cpu", "CPU", cpu >= min_cpu, round(cpu, 2), min_cpu, "核"),
            Check("memory", "内存", memory_mb >= min_memory, round(memory_mb), min_memory, "MB"),
        ])
    else:
        raise ValueError(f"不支持的服务：{service}")

    failed_resources = [check for check in checks if not check.ok]
    kind: str | None = "resource" if failed_resources else None
    reason = ""
    if failed_resources:
        details = []
        for check in failed_resources:
            if check.key == "gpu":
                details.append("未检测到 NVIDIA GPU")
            elif check.key == "vram" and not next(item for item in checks if item.key == "gpu").ok:
                continue
            else:
                details.append(
                    f"{check.label}需要至少 {display_number(float(check.required))}{check.unit}，"
                    f"当前 {display_number(float(check.actual))}{check.unit}"
                )
        reason = f"资源不足，未启动：{'；'.join(details)}"

    if service == "xiaozhi-server" and not failed_resources and not resources_only:
        dependencies = [
            ("manager-api", "Manager API", "http://127.0.0.1:8002/xiaozhi/user/pub-config"),
            ("index-tts", "IndexTTS 2.5", "http://127.0.0.1:8092/health/ready"),
        ]
        for key, label, url in dependencies:
            ready = url_ready(url)
            checks.append(Check(key, label, ready, "就绪" if ready else "未就绪", "就绪"))
        missing = [check.label for check in checks if check.key in {"manager-api", "index-tts"} and not check.ok]
        if missing:
            kind = "dependency"
            reason = f"依赖未就绪，未启动：{'、'.join(missing)}"

    ok = all(check.ok for check in checks)
    return {
        "service": service,
        "ok": ok,
        "kind": kind,
        "reason": reason or "启动条件已满足",
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "checks": [asdict(check) for check in checks],
    }


def write_status(result: dict[str, Any]) -> None:
    runtime = Path(os.environ.get("XIAOZHI_AUTODL_RUNTIME", "/root/autodl-tmp/xiaozhi-autodl"))
    state_dir = runtime / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    target = state_dir / f"preflight-{result['service']}.json"
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("service", choices=["index-tts", "xiaozhi-server"])
    parser.add_argument("--resources-only", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    load_defaults()
    result = evaluate(args.service, args.resources_only)
    write_status(result)
    print(json.dumps(result, ensure_ascii=False) if args.json else result["reason"])
    return 0 if result["ok"] else 75


if __name__ == "__main__":
    sys.exit(main())
