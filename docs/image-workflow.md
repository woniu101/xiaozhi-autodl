# AutoDL 镜像准备与开发恢复

## 数据边界

AutoDL 系统盘进入镜像，`/root/autodl-tmp` 数据盘不进入镜像。因此项目使用两层结构：

| 类型 | 位置 | 用途 |
|---|---|---|
| 可分发种子 | 系统盘 | 三个仓库、Conda 环境、构建产物、IndexTTS 模型、兔娘人物和音色 seed、MySQL 预置账号与智能体 |
| 实例运行数据 | `/root/autodl-tmp/xiaozhi-autodl` | Dashboard 口令、人物资源副本、IndexTTS 音色、合成输出、日志、接入地址和更新状态 |
| 开发恢复备份 | `/root/autodl-tmp/xiaozhi-autodl/dev-state` | 封镜前数据库、实例配置与开发身份，仅用于原开发实例恢复 |

新实例的数据盘为空，`first-boot` 会从系统盘 seed 初始化人物资源和音色。后续修改只发生在数据盘，不污染镜像种子。

人物资源的规范目录是：

```text
/root/autodl-tmp/xiaozhi-autodl/character_styles
```

IndexTTS 的规范实例目录是：

```text
/root/autodl-tmp/xiaozhi-autodl/index-tts/reference
/root/autodl-tmp/xiaozhi-autodl/index-tts/voices
```

ASR/TTS 临时输出统一进入：

```text
/root/autodl-tmp/xiaozhi-autodl/outputs/xiaozhi-server
/root/autodl-tmp/xiaozhi-autodl/outputs/index-tts
```

## 首次启动

`bin/first-boot` 是幂等操作，负责：

1. 确认 `/root/autodl-tmp` 是独立挂载的数据盘；
2. 创建并修正运行目录权限；
3. 只在实例目录为空时复制兔娘人物和音色 seed；
4. 安装仓库管理的 `/root/autodl.sh` 和日志配置；
5. 检查依赖、Conda 环境、构建产物、模型大小、磁盘和资源；
6. 将检查报告写入 `state/first-boot-report.txt`。

Dashboard 不内置运维口令。新数据盘第一次打开 6006 时，用户自行创建 8–32 位口令，不使用一次性初始化码。

小智服务启动前会从 MySQL 读取 Manager API 在当前实例生成的 `server.secret`，并将私有配置写入数据盘。密钥不会写回 Git 工作区。

## 发布检查

```bash
scripts/validate-release --mode runtime --quick
scripts/validate-release --mode pre-image
scripts/validate-release --mode sealed --quick
```

- `runtime`：日常检查；仓库改动、低 CPU、低内存或无 GPU 只给出适当告警。
- `pre-image`：要求三个仓库工作区干净，并执行 IndexTTS 大模型 SHA-256 校验。
- `sealed`：检查开发身份、实例密钥、旧公网地址、Token、设备和聊天数据已经清理，同时确认内置账号与兔娘智能体仍存在。
- `--quick`：跳过耗时的大模型 SHA-256，仍检查文件大小。

模型基线记录在 `manifest.json`。每次合法更换模型文件后，应重新核对大小和 SHA-256，再更新清单。

## 封镜准备

先运行无副作用预演：

```bash
scripts/prepare-image --dry-run
```

确认三个仓库已经提交并推送后，结束 Codex，在普通 SSH 终端执行：

```bash
scripts/prepare-image --apply
```

脚本按以下顺序工作：

1. 完成 `pre-image` 验收；
2. 停止业务服务，保持 MySQL 用于一致性备份；
3. 在 `dev-state/<UTC时间>` 保存 MySQL、运行配置、人物/音色副本和开发身份；
4. 生成 SHA-256 备份校验文件和 `latest` 链接；
5. 清理模型供应商 Key、Manager 实例密钥、旧 OTA/WebSocket 地址、登录 Token、设备和聊天数据；
6. 清理 Codex、GitHub、Git、SSH 私密身份和历史记录；
7. 保留 `xiaozhi` 账号、兔娘智能体、兔娘人物资源、兔娘音色和模型参数骨架；
8. 生成 `/root/xiaozhi-image-manifest.json`，完成 `sealed` 验收并停止 MySQL。

`--apply` 检测到 Codex 仍在运行时会拒绝执行，避免在活动会话中删除 Codex 状态。

## 保存镜像后恢复开发

镜像保存完成后，在原实例普通 SSH 终端执行：

```bash
scripts/resume-development --dry-run
scripts/resume-development --apply
```

恢复脚本先验证备份 SHA-256，然后恢复业务数据库、运行配置和开发身份，重新执行 `first-boot` 并启动服务。也可以显式指定某个备份：

```bash
scripts/resume-development --apply \
  /root/autodl-tmp/xiaozhi-autodl/dev-state/20260901T120000Z
```

恢复是有意覆盖当前业务数据库的操作，因此必须显式提供 `--apply`。备份目录必须位于项目的 `dev-state` 内，防止路径误用。

## 新镜像验收顺序

1. 从镜像创建全新实例，确认数据盘为空；
2. 执行 `/root/autodl.sh`；
3. 查看 `state/first-boot-report.txt`；
4. 首次打开 Dashboard 创建运维口令；
5. 使用内置智控台账号登录，确认兔娘智能体和 IndexTTS 音色存在；
6. 填入 DeepSeek API Key；
7. 绑定客户端设备码；
8. 在 GPU 实例完成 ASR、LLM、IndexTTS 和客户端全链路测试。
