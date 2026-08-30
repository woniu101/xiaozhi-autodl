# 小智 AutoDL 一体化镜像与运维中心 PRD

## 1. 文档信息

- 产品名称：小智 AutoDL 一体化镜像与运维中心
- 项目目录：`/root/xiaozhi-autodl`
- 文档版本：v0.8.0
- 文档日期：2026-08-30
- 文档状态：开发基线
- 目标平台：AutoDL 容器实例与基于该实例发布的应用镜像

## 2. 项目背景

当前 AutoDL 实例已经跑通以下完整链路：

- `xiaozhi-esp32-server` 的 manager-web 管理前端。
- `xiaozhi-esp32-server` 的 manager-api Java 后端。
- `xiaozhi-esp32-server` 的 xiaozhi-server Python 服务端。
- MySQL 与 Redis。
- `index-tts` 的 IndexTTS 2.5 兔娘语音服务。

现有环境主要依赖人工执行命令启动服务，存在以下问题：

1. MySQL 与 Redis 不会随 AutoDL 实例自动启动。
2. xiaozhi-server、manager-api、manager-web 和 IndexTTS 缺少统一的启停与健康监控。
3. IndexTTS 启动环境中曾出现 `OMP_NUM_THREADS=0`，导致 `libgomp: Invalid value` 警告。
4. 用户需要进入终端完成较多操作，不适合作为开箱即用的 AutoDL 应用镜像发布。
5. AutoDL 仅提供有限的公网服务端口，需要统一规划网页、REST、OTA 与 WebSocket 入口。

本项目新增独立运维控制层，将现有环境封装为可自动启动、可观察、可发布的暖镜像。Dashboard 专注运维监控，智能体和模型等业务配置继续由原始智控台负责。

## 3. 产品目标

### 3.1 核心目标

1. AutoDL 实例开机后自动启动整套服务。
2. 提供独立的 6006 运维仪表盘。
3. 保持原始 manager-web 页面和源码不变，通过 6008 对外提供。
4. 在仪表盘内启动、停止、重启和监控各项服务。
5. 在仪表盘内查看 CPU、内存、磁盘、GPU、显存和服务日志。
6. 提供“智能体管理”和“模型配置”快捷入口，不在 Dashboard 中重复实现业务配置。
7. 复用机器上已经搭建完成的两个 Conda 环境，不新增 Dashboard Python 环境。
8. 让 IndexTTS 尽量充分利用分配到的 CPU，同时避免非法 OpenMP 配置。
9. 保留已经调通的模型、音色、依赖和非私人业务配置，降低镜像使用门槛。
10. 支持本地电脑、局域网设备和 ESP32 通过公网地址或 SSH 隧道访问小智服务。

### 3.2 成功标准

新用户从镜像创建实例后，理想操作流程不超过以下步骤：

1. 开机。
2. 打开 WebUI 6006。
3. 首次打开时创建轻量运维口令。
4. 点击“启动全部”。
5. 从快捷入口打开智控台，在智控台中完成智能体和模型配置。

用户不需要手工启动 MySQL、Redis、Java、Python 或 Nginx，也不需要重新下载模型和安装依赖。

## 4. 非目标

第一阶段不包含以下内容：

- 不重写或替换 manager-web。
- 不把运维功能注入 manager-web。
- 不修改 manager-web 的业务组件、API 封装和数据模型；仅允许登录页读取路由守卫已有的 `redirect` 参数。
- 不将 Dashboard 与 manager-web 合并成同一个前端项目。
- 不使用 Docker 或 Docker Compose 重构现有源码部署。
- 不新增第三个 Conda 环境供 Dashboard 使用。
- 不提供任意 Shell 命令执行功能。
- 不直接从 Dashboard 修改小智 MySQL 表。
- 不同时常驻运行 IndexTTS Gradio WebUI 和 IndexTTS companion API。
- 不在第一阶段实现多实例集群或跨机器调度。

## 5. 已确认的环境基线

### 5.1 源码目录

- 小智项目：`/root/xiaozhi-esp32-server`
- IndexTTS 项目：`/root/index-tts`
- 运维控制层：`/root/xiaozhi-autodl`

### 5.2 固定版本

- xiaozhi-esp32-server 分支：`mvp`
- xiaozhi-esp32-server 基线提交：`ed2d2b52731f989d5f36bb250d5e429ae4346f40`
- index-tts 分支：`main`
- index-tts 基线提交：`923bbaeb6d6c3dd7eb4b33d193811748a3eae50b`

发布镜像不得在开机时自动执行 `git pull`。版本升级应通过 Dashboard 显式触发的安全更新和验证完成；`xiaozhi-autodl` 自身也纳入固定 `main` 分支版本管理。

### 5.3 运行环境

- Java：OpenJDK 21
- Node.js：20.20.2
- npm：10.8.2
- Nginx：1.18.0
- Supervisor：4.2.5
- MySQL：8.0.46
- Redis：6.0.16
- GPU 基线：NVIDIA GeForce RTX 4090 24GB
- AutoDL 实例展示 CPU：16 核

开发期间允许临时切换为 1 核、无 GPU 的低配置实例。低配阶段完成 UI、认证、编排和只读接口验证；IndexTTS 模型加载、GPU 指标和完整语音链路留到恢复 GPU 配置后验收。

### 5.4 现有 Conda 环境

- 小智：`/root/miniconda3/envs/xiaozhi-esp32-server`
- IndexTTS：`/root/miniconda3/envs/indextts25`

所有自动启动脚本必须直接调用环境中的绝对 Python 路径，不依赖 `conda activate`。

## 6. 总体架构

```text
AutoDL WebUI 6006
└── Node.js Dashboard
    ├── 服务管理
    ├── 系统与 GPU 监控
    ├── 日志查看
    ├── 批量启停与操作进度
    └── 智控台业务页面快捷入口

AutoDL WebUI 6008
└── Nginx Web Gateway
    ├── /                         manager-web 静态产物
    ├── /xiaozhi/v1/              xiaozhi-server WebSocket :8000
    ├── /xiaozhi/...              manager-api :8002
    └── /mcp/vision/explain       xiaozhi-server HTTP :8003

内部服务
├── MySQL :3306
├── Redis :6379
├── manager-api :8002
├── xiaozhi-server :8000/:8003
└── IndexTTS companion API :8092
```

## 7. 端口规划

| 端口 | 服务 | 暴露范围 | 说明 |
|---|---|---|---|
| 6006 | Node.js Dashboard | AutoDL 公网 | 独立运维控制面 |
| 6008 | Nginx Web Gateway | AutoDL 公网 | manager-web、API、OTA、WSS |
| 8000 | xiaozhi-server WebSocket | 仅本机 | 经 6008 `/xiaozhi/v1/` 代理 |
| 8002 | manager-api | 仅本机 | 经 6008 `/xiaozhi/` 代理 |
| 8003 | OTA/视觉 HTTP | 仅本机 | 经 6008 指定路径代理 |
| 8092 | IndexTTS API | 仅本机 | xiaozhi-server 内部调用 |
| 3306 | MySQL | 仅本机 | 不允许公网暴露 |
| 6379 | Redis | 仅本机 | 不允许公网暴露 |

当前 AutoDL 节点已完成 6008 WebSocket 实测：

- WSS Upgrade 成功。
- 文本帧双向传输成功。
- 4096 字节二进制帧双向传输成功。
- Ping/Pong 成功。

后续仍需在正式 Nginx 配置完成后补做“公网网关 → Nginx → 8000”的完整链路测试。

## 8. manager-web 上游隔离与最小兼容

1. manager-web 业务页面、接口和数据结构保持原样。
2. 唯一兼容修改位于登录页：登录成功后读取路由守卫已有的 `redirect`，使 Dashboard 的“模型配置”深链接能返回原目标页面。
3. 使用原项目 `npm run build` 生成生产产物。
4. 将构建产物复制到：

   ```text
   /root/xiaozhi-autodl/artifacts/manager-web/
   ```

5. Nginx 只将该目录作为静态站点根目录。
6. manager-web 本身没有常驻进程，因此不设置 `start-manager-web`。
7. 负责 manager-web 和反向代理的进程统一命名为 `web-gateway`。
8. 对应启动包装器命名为 `start-web-gateway`。

仪表盘中应显示两个独立状态：

- Web Gateway/Nginx 进程状态。
- manager-web 首页 HTTP 健康状态。

## 9. Java 后端交付方式

manager-api 使用 Maven 构建为 Spring Boot 可执行 JAR：

```text
xiaozhi-esp32-api.jar
```

构建产物复制到：

```text
/root/xiaozhi-autodl/artifacts/manager-api/xiaozhi-esp32-api.jar
```

JAR 不得放入 manager-web 静态目录，也不得由 Nginx 直接提供下载。JAR 由 Supervisor 通过 `start-manager-api` 启动。

## 10. Dashboard 技术方案

### 10.1 技术栈

- 后端：Node.js + Fastify
- 前端：Vue 3 + Vite
- 语言：TypeScript
- 生产进程：单个 Node.js 进程

Dashboard 不依赖 Python，不创建新 Conda 环境。

### 10.2 生产形态

```text
dashboard/dist/server/   Node.js 后端
dashboard/dist/public/   Dashboard 前端静态资源
```

启动命令：

```text
node /root/xiaozhi-autodl/dashboard/dist/server/index.js
```

Node.js 同时监听 6006 并提供前端静态页面和 `/api/*` 接口。

## 11. Dashboard 功能需求

### 11.1 登录与安全

- Dashboard 使用独立运维认证。
- 首次打开页面由用户创建 8-32 位轻量运维口令，不要求固定复杂字符组合。
- 运维口令只保存 `scrypt` 摘要与随机盐，不保存明文，也不生成固定默认密码。
- 已存在旧版口令文件的实例保持兼容，修改口令后自动迁移到 v2 格式。
- 右上角支持修改口令，修改成功后使其他会话失效。
- 忘记口令时通过 `bin/reset-dashboard-passcode` 恢复到首次创建状态，旧文件保留为受限权限备份。
- Cookie 必须使用 HttpOnly 与 SameSite。
- 所有写操作必须校验来源并防止 CSRF。
- 登录失败需要限速。
- 不提供任意命令、路径或服务名输入。
- Supervisor 操作仅允许固定动作和固定服务白名单。

### 11.2 系统总览

展示：

- CPU 使用率与分配核数。
- 内存使用率。
- 系统盘和数据盘使用率。
- GPU 型号、温度、利用率。
- 显存总量与使用量。
- 实例运行时间。
- 服务总体健康状态。

CPU、内存与运行时间必须来自当前 AutoDL 容器的 Cgroup v2 和 PID 1，不得展示宿主机的总核数、总内存或开机时间。CPU 卡显示精确 vCPU 配额与限流周期比例；系统盘 `/` 和数据盘 `/root/autodl-tmp` 必须分卡展示。

宽屏页面应使用接近浏览器全宽的内容区，提升核心字号和卡片信息密度，避免左右与底部出现大面积无效空白。六项资源卡均提供语义图标和状态标签。CPU 在 70%/90%、内存在 75%/90%、显存与系统盘/数据盘在 75%/90% 进入偏高/告警；GPU 高利用率视为正常工作负载，改按 70℃/85℃提示偏高/告警。服务进程 CPU 在 60%/85% 增强显示。

服务健康不占资源卡，必须作为页面标题右侧独立的常驻摘要：

- `READY` 绿色：`服务健康 6/6`。
- `STARTING` 蓝色并显示启动中数量。
- `DEGRADED` 橙色并显示异常数量。
- `STOPPED` 灰色并显示停止数量，允许表达用户主动停止。
- `FAILED` 红色并显示失败数量，优先级最高。

点击健康摘要必须滚动定位服务区，突出所有非 READY 卡片并弱化正常卡片；每张异常卡仍可直接查看日志。

### 11.3 服务管理

管理对象：

- `web-gateway`
- `mysql`
- `redis`
- `manager-api`
- `index-tts`
- `xiaozhi-server`

Dashboard 固定展示顺序为：小智服务端、Web Gateway、Manager API、IndexTTS 2.5、MySQL、Redis，使业务入口和核心链路优先显示。

Dashboard 自身不允许从自身页面停止。

每个服务展示：

- Supervisor 状态。
- PID。
- 运行时间。
- CPU 与内存使用量。
- 端口监听状态。
- 应用健康状态。
- 最近错误。
- 健康检查耗时、近 10 分钟重启次数与最近启动时间。
- 启动、停止、重启操作。

每张服务卡增加三项可操作运行信号：

- 小智服务端：活动连接、5 分钟会话、5 分钟错误。
- Web Gateway：当前连接、请求/分钟、4xx/5xx。
- Manager API：请求/分钟、响应时间、JVM 堆内存。
- IndexTTS：推理设备、等待/活动任务、距最近合成时间。
- MySQL：当前连接、连接使用率、慢查询增量。
- Redis：客户端数、内存、缓存命中率。

信号根据正常、关注、警告和严重状态着色；只有能够映射到真实日志记录的信号允许点击，并自动带入日志源、级别、关键词或状态码筛选。纯实时状态指标不伪造日志映射。

近 10 分钟启动/重启次数使用卡片内紧凑胶囊展示；单次为中性提示，两次及以上才进行告警色增强，并说明该计数包含人工启动、人工重启和异常拉起。

### 11.4 批量操作

- “启动全部”按依赖顺序启动服务。
- “重启全部”先按反向依赖停止，再按正向依赖恢复。
- “停止全部”按反向依赖停止六项受管服务，但永远不停止 Dashboard 自身。
- 批量操作异步执行，页面显示当前步骤、总进度和失败原因，并防止重复提交。
- 停止和重启操作必须二次确认。

### 11.5 日志

- 每个服务独立日志；Web Gateway 可切换 Nginx 访问日志、错误日志和 Supervisor 启动日志，Manager API 可切换应用日志和接口访问日志。
- 支持最近 200 行、1000 行。
- 支持实时滚动。
- 支持下载。
- 支持按 INFO、WARN、ERROR 筛选。
- Web Gateway 与 Manager API 支持按 HTTP 4xx/5xx 和接口请求预设筛选；错误级别筛选保留多行堆栈上下文。
- 自动追踪固定显示“每 2 秒自动刷新”，刷新过程不得通过反复替换文本造成抖动；读取失败与“暂无匹配日志”必须分开显示。
- 日志自动轮转，建议单文件 50MB、保留 5 份。
- 自动遮蔽 API Key、Token、Authorization 和密码。

### 11.6 智控台快捷入口

Dashboard 顶部提供：

- 智能体管理：`/#/home`
- 模型配置：`/#/model-config`

外部地址优先读取 `MANAGER_WEB_PUBLIC_URL`，其次使用 AutoDL 提供的 `AutoDLService6008URL`，本地或 SSH 隧道场景再根据浏览器主机推导 6008。

Dashboard 不保存智控台账号、密码、Token 或 DeepSeek Key。未登录访问受保护页面时由 manager-web 原有路由守卫进入登录页；登录成功后读取 `redirect` 返回目标页面。

### 11.7 IndexTTS 管理

展示：

- 进程状态。
- 模型加载中/已就绪/失败。
- `/health/live` 与 `/health/ready` 状态。
- 自动检测的 OMP 线程数。
- 当前 CPU、GPU 与显存占用。
- 距最近一次合成的时间与最近合成耗时。
- 服务队列状态。
- 启动、停止、重启与日志查看。

Dashboard 不提供 IndexTTS 参数编辑、音色管理或试听，避免与业务控制面职责混淆。

### 11.8 客户端接入

Dashboard 在主界面展示智控台、OTA 与 WebSocket 三个客户端地址并提供复制按钮，支持：

- AutoDL 公网：读取 `AutoDLService6008URL`，自动派生 HTTPS OTA 和 WSS。
- 局域网 / SSH 隧道：使用客户端可访问的 HTTP 基础地址，并生成可复制的 SSH 映射命令。
- 自定义域名：使用已有反向代理的 HTTP/HTTPS 基础地址。

接入配置保存到数据盘 `config/endpoints.json`。每次 Dashboard 启动都检查当前 AutoDL 域名，只允许同步 `server.ota` 和 `server.websocket` 两个参数，并清理对应 Redis 缓存键。页面每 5 秒刷新接入就绪状态，并分别探测智控台、OTA 和 WebSocket 代理链路；界面必须区分“地址已同步”和“接口几项就绪”。

### 11.9 代码版本与安全更新

- 仓库统一使用 GitHub 名称 `xiaozhi-esp32-server`、`index-tts` 与 `xiaozhi-autodl`；运行服务仍使用“小智服务端”和“IndexTTS 2.5”。
- 运行总览不再保留整行版本卡片；页面标题右侧以胶囊显示“未检查/检查中/已同步/可更新/受阻/失败/更新中”，并作为版本管理入口。
- 独立 `/versions` 页面展示提交说明、部署分支、上游分支、远端地址、本地修改文件、更新步骤和实时日志。
- 每个仓库都提供“检查该仓库”，页面同时提供“检查全部仓库”。检查只获取配置的部署分支，不修改工作区；单仓检查使用独立 loading 和后端任务锁，不得让另一仓库按钮同步进入检查状态。
- GitHub 远端探测首次超时为 15 秒，失败后间隔 1 秒重试一次，第二次超时为 20 秒；普通网络故障不得让用户无反馈等待 90 秒。需要获取新提交时允许单独执行最长 60 秒的部署分支 fetch。
- 检查中显示当前连接/重试/获取更新阶段、尝试次数和已等待时间；失败时区分超时、DNS、TLS、连接与 HTTP 错误，保留具体原因并提供“重新检查”。
- Dashboard 启动 8 秒后检查一次，此后每 30 分钟检查部署分支；自动检查只 fetch，不自动更新或重启。
- 检查时间持久化到数据盘；未检查时必须显示“尚未检查远端”，不得用“可安全检查”代替远端版本结论。
- 部署分支固定为：`xiaozhi-esp32-server` 使用 `mvp`，`index-tts` 与 `xiaozhi-autodl` 使用 `main`；不得展示或比较其他分支。
- 工作区状态与远端状态分开：本地修改仍允许检查远端，但锁定自动更新并说明具体阻塞文件。
- 安全更新目标只能是仓库配置的远端部署分支。
- 有受保护的本地改动或无法快进时拒绝自动更新；业务仓库的 Conda/Maven/npm 依赖变化继续人工确认，`xiaozhi-autodl` 的 Node.js 锁文件则允许按锁文件确定性安装并随失败回滚。
- 发现更新时预览落后数、最近提交、变更文件、依赖变化和受影响组件。
- 更新流程为：安全预检、获取远端、快进源码、仅构建和原子替换受影响组件、按更新前状态重启、健康验收。
- 构建或验收失败时回到旧提交并重新构建旧版本；Dashboard 展示步骤、结果和回滚状态。
- `xiaozhi-autodl` 自更新由独立进程执行，状态和日志持久化到数据盘，确保 Dashboard 重启期间任务不中断；重启后必须通过 6006 健康检查。
- IndexTTS 的 checkpoints、reference、voices、outputs 作为持久化内容，不因仅有这些未跟踪文件而阻止代码更新。

## 12. IndexTTS CPU 策略

历史问题：父环境曾将 `OMP_NUM_THREADS` 设置为 `0`，导致 libgomp 警告。

IndexTTS 启动包装器必须覆盖相关变量，不依赖父 Shell：

```text
INDEXTTS_CPU_THREADS=16
OMP_NUM_THREADS=16
MKL_NUM_THREADS=16
OPENBLAS_NUM_THREADS=16
NUMEXPR_NUM_THREADS=16
OMP_DYNAMIC=FALSE
OMP_PROC_BIND=spread
OMP_PLACES=cores
TOKENIZERS_PARALLELISM=false
```

每次启动时自动读取 `nproc` 和 Cgroup CPU quota，取两者中实际可用的较小值，且结果最低为 1。启动器无条件覆盖父 Shell 中的 OMP/MKL/OpenBLAS/NumExpr 变量，不再读取 Dashboard 手工设置，也不设置固定 32 线程上限。

IndexTTS 仍以 `nice -n 5` 启动，使其在系统空闲时充分使用 CPU，在 Java 或实时 WebSocket 服务繁忙时适当让出调度优先级。Dashboard 仅只读展示自动检测结果。

正式服务只常驻 IndexTTS companion API 8092。不得同时常驻 `webui.py:7860`，避免同一 GPU 重复加载模型。试听功能调用同一个 8092 API。

## 13. Supervisor 编排

Supervisor 管理：

```text
dashboard
web-gateway
mysql
redis
manager-api
index-tts
xiaozhi-server
```

启动顺序：

```text
Dashboard + Web Gateway
          ↓
      MySQL + Redis
          ↓
       manager-api
          ↓
        IndexTTS
          ↓
     xiaozhi-server
```

实际依赖不能只依靠 Supervisor priority，启动包装器还需要等待对应端口或健康接口就绪。

Supervisor 控制接口必须绑定 Unix Socket，不暴露公网。Dashboard 使用固定参数调用 `supervisorctl`，禁止 Shell 字符串拼接。

## 14. 运行时包装器

`bin/` 只放运行时入口：

```text
bin/
├── suite-start
├── suite-stop
├── first-boot
├── start-dashboard
├── start-web-gateway
├── start-manager-api
├── start-xiaozhi-server
├── start-index-tts
├── reset-dashboard-passcode
└── health-check
```

职责：

| 文件 | 作用 |
|---|---|
| `suite-start` | 幂等启动整套 Supervisor |
| `suite-stop` | 优雅停止整套服务 |
| `first-boot` | 创建目录、生成实例密钥和首次启动状态 |
| `start-dashboard` | 启动 Node.js Dashboard :6006 |
| `start-web-gateway` | 启动 Nginx :6008 |
| `start-manager-api` | 启动 Java JAR :8002 |
| `start-xiaozhi-server` | 使用现有小智 Conda 环境启动 :8000/:8003 |
| `start-index-tts` | 使用现有 IndexTTS Conda 环境和线程参数启动 :8092 |
| `reset-dashboard-passcode` | 备份旧认证文件并恢复首次创建口令状态 |
| `health-check` | 执行全链路健康检查 |

MySQL、Redis 可优先由 Supervisor 直接以前台命令运行；若实测需要初始化或权限处理，再增加专用包装器。

## 15. 构建与维护脚本

非运行时操作放在 `scripts/`：

```text
scripts/
├── build-dashboard
├── build-manager-api
├── build-manager-web
├── refresh-runtime
├── benchmark-index-tts
├── prepare-image
└── validate-release
```

- `build-dashboard`：类型检查并构建 Node.js Dashboard。
- `build-manager-api`：构建 JAR，原子替换运行产物并保留一个上一版本。
- `build-manager-web`：构建原始前端，原子替换静态产物并保留一个上一版本。
- `refresh-runtime`：按当前磁盘源码选择性构建并重启组件，保留刷新前的启停状态，同时记录最近刷新时间。
- `benchmark-index-tts`：测试不同 CPU 线程档位。
- `prepare-image`：发布前执行定向密钥与实例身份清理。
- `validate-release`：验证依赖、目录、端口、产物和敏感信息。

## 16. AutoDL 开机入口

真实启动脚本位于：

```text
/root/autodl.sh
```

为兼容当前 AutoDL 引导机制，创建符号链接：

```text
/etc/autodl.sh -> /root/autodl.sh
```

调用关系：

```text
/root/autodl.sh
  → /root/xiaozhi-autodl/bin/suite-start
  → Supervisor
  → 各项服务
```

所有启动操作必须幂等。重复执行 `/root/autodl.sh` 不得产生重复进程或破坏已有数据。

## 17. 目录结构

```text
/root/xiaozhi-autodl/
├── dashboard/
│   ├── package.json
│   ├── src/
│   │   ├── server/
│   │   └── web/
│   └── dist/
│       ├── server/
│       └── public/
├── bin/
│   ├── suite-start
│   ├── suite-stop
│   ├── first-boot
│   ├── start-dashboard
│   ├── start-web-gateway
│   ├── start-manager-api
│   ├── start-xiaozhi-server
│   ├── start-index-tts
│   └── health-check
├── scripts/
│   ├── build-manager-api
│   ├── build-manager-web
│   ├── build-dashboard
│   ├── refresh-runtime
│   ├── benchmark-index-tts
│   ├── prepare-image
│   └── validate-release
├── config/
│   ├── supervisor/
│   │   ├── supervisord.conf
│   │   └── programs.d/
│   ├── nginx/
│   │   └── nginx.conf
│   └── defaults.env
├── artifacts/
│   ├── manager-api/
│   │   └── xiaozhi-esp32-api.jar
│   └── manager-web/
│       ├── index.html
│       └── assets...
├── seed/
│   ├── database/
│   └── config/
├── docs/
├── manifest.json
├── prd.md
└── VERSION
```

运行时可变数据：

```text
/root/autodl-tmp/xiaozhi-autodl/
├── config/
├── logs/
├── run/
├── secrets/
├── uploads/
├── voices/
└── backups/
```

## 18. 暖镜像数据策略

镜像目标是尽量减少用户操作，因此不执行全量环境清空。

### 18.1 保留内容

- 三个源码仓库及固定部署分支。
- 两个现有 Conda 环境。
- Java、Node、Nginx、Supervisor、MySQL、Redis。
- IndexTTS 模型权重。
- 兔娘音色及其合法分发所需文件。
- 小智 ASR/VAD 模型。
- manager-api 与 manager-web 构建产物。
- 已调通的 TTS、ASR、模型供应商和角色配置。
- DeepSeek Base URL、模型名及非敏感参数。

### 18.2 业务配置定向处理

- 清除当前测试用 DeepSeek API Key。
- DeepSeek Key 替换为空值或明确占位符。
- 其他业务 Key 是否保留，以是否属于个人付费/限额凭据为判断标准。
- 公共测试 Key 或允许分发的非私人配置可以保留。

### 18.3 必须重新生成或移除的实例身份

以下内容与开箱即用无关，不得随公开镜像分发：

- Codex 账号与会话数据。
- SSH 私钥。
- Shell 和 MySQL 历史记录。
- Git、npm、浏览器等个人凭据。
- 当前 AutoDL 实例 Token 或身份缓存。
- manager-api 已签发登录 Token。
- Redis Session。
- Dashboard 固定密码和 Session Secret。
- 含敏感信息的旧日志。
- 真实个人设备 Token、聊天记录和私人录音。

清理这些内容不得删除模型、依赖、兔娘公共音色或已调通的非私人业务配置。

## 19. 本地与局域网访问

### 19.1 直接公网访问

- manager-web：`https://<AutoDL-6008地址>/`
- WebSocket：`wss://<AutoDL-6008地址>/xiaozhi/v1/`
- OTA：`https://<AutoDL-6008地址>/xiaozhi/ota/`

浏览器、应用程序和 ESP32 都可以访问 6008；6008 并非仅限网页。

是否已经制作镜像不影响公网访问。只要 AutoDL 实例运行且 6008 WebUI 映射有效，客户端即可直接使用 HTTPS OTA 和 WSS。`server.ota` 与 `server.websocket` 必须广播同一个实例的 6008 公网域名；未来镜像首次启动时根据 `AutoDLService6008URL` 动态设置，禁止固化开发实例域名。

### 19.2 SSH 隧道

局域网需要本地地址时，可将远端 6008 整体映射到本地主机：

```bash
ssh -NT -g \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 0.0.0.0:16008:127.0.0.1:6008 \
  root@AutoDL主机 -p SSH端口
```

局域网使用：

- 智控台：`http://<本地电脑IP>:16008/`
- WebSocket：`ws://<本地电脑IP>:16008/xiaozhi/v1/`
- OTA：`http://<本地电脑IP>:16008/xiaozhi/ota/`

## 20. 健康检查标准

| 服务 | 健康检查 |
|---|---|
| Dashboard | `GET /api/health` 返回 200 |
| Web Gateway | 6008 监听且首页返回 200 |
| MySQL | `mysqladmin ping` 成功 |
| Redis | `redis-cli ping` 返回 PONG |
| manager-api | `/xiaozhi/user/pub-config` 或等价接口成功 |
| IndexTTS | `/health/live` 与 `/health/ready` 成功 |
| xiaozhi-server | 8000 WebSocket 握手及 8003 HTTP 成功 |

服务状态必须区分：

- `stopped`：进程未运行。
- `starting`：进程已启动但健康检查未通过。
- `stopping`：已提交停止操作，正在等待进程和监听端口退出。
- `healthy`：进程和业务检查均通过。
- `degraded`：进程运行但依赖或部分检查失败。
- `failed`：进程异常退出或持续检查失败。

## 21. 可靠性要求

- 单服务异常退出后由 Supervisor 自动拉起。
- 服务停止时使用 TERM，并给出合理停止超时。
- 避免使用 `kill -9` 作为正常停止方式。
- 日志不能无限增长。
- MySQL、Redis 和运行数据在实例正常关机后保持。
- Dashboard 即使在 manager-api、IndexTTS 或 xiaozhi-server 故障时仍可访问。
- “停止业务”不得关闭 Dashboard 本身。
- 启动脚本必须支持重复执行。
- 单项操作与批量操作必须互斥；相同服务不得并发执行两个生命周期动作。
- 批量停止单项失败后继续清理其余服务；批量启动的依赖失败时跳过下游并显示原因。
- MySQL 使用 `mysqladmin ping`、Redis 使用 `redis-cli ping` 判定业务健康，不能仅根据端口或 SysV 返回码判定成功。

## 22. 安全要求

- 6006 必须启用认证。
- 6008 保持 manager-web 原有认证。
- 3306、6379、7000、8000、8002、8003、8092 不直接暴露公网。
- 所有服务操作使用固定白名单。
- 禁止从 HTTP 参数拼接 Shell 命令。
- Dashboard 不读取或保存 DeepSeek Key、manager-api 密码与登录 Token。
- Nginx 禁止访问 manager-api JAR、配置目录和 secrets 目录。
- 发布前执行敏感信息扫描。

## 23. 验收标准

### 23.1 自动启动

- AutoDL 开机后无需 SSH 操作即可访问 6006。
- MySQL 与 Redis 自动启动。
- manager-api 自动启动并连接数据库与 Redis。
- IndexTTS 自动加载模型并最终进入 ready。
- xiaozhi-server 自动启动并可连接 manager-api 与 IndexTTS。
- 6008 可访问原始 manager-web。

### 23.2 运维功能

- Dashboard 能正确显示全部服务状态。
- 可单独启动、停止和重启允许管理的服务。
- 可批量启动和重启业务服务。
- 可查看实时日志。
- 可查看 GPU、显存、CPU、内存和磁盘。
- 非法服务名和非法动作被拒绝。

### 23.3 智控台跳转

- “智能体管理”能打开 `/#/home`。
- “模型配置”能打开 `/#/model-config`。
- 未登录时先进入 manager-web 登录页，登录成功后回到原目标页面。
- AutoDL 公网 URL、本机端口和 SSH 隧道地址均可通过环境变量或自动推导适配。

### 23.4 IndexTTS

- 启动日志中不再出现 `OMP_NUM_THREADS=0` 或 libgomp 非法值警告。
- 自动线程数与容器实际可用 CPU 一致且至少为 1。
- `/health/live` 和 `/health/ready` 正常。
- 小智能够调用 8092 完成普通和流式合成。
- 不重复加载 Gradio 模型实例。

### 23.5 网络

- 6008 manager-web 页面正常。
- 6008 REST API 正常。
- 6008 WSS 文本帧正常。
- 6008 WSS 二进制帧正常。
- SSH 隧道下局域网网页、OTA 和 WebSocket 正常。

## 24. 开发阶段

### 阶段一：基础编排

- 建立目录结构。
- 实现运行包装器。
- 配置 Supervisor。
- 配置 Nginx。
- 实现 `/root/autodl.sh` 与兼容链接。

### 阶段二：构建产物

- 构建 manager-api JAR。
- 构建 manager-web 静态资源。
- 固定提交与产物版本。

### 阶段三：Dashboard MVP

- Node.js/Fastify 后端。
- Vue 3 仪表盘。
- 登录、服务状态、启停、日志与系统监控。

### 阶段四：运维体验优化

- 一屏运维界面与智控台视觉统一。
- 批量操作、进度与日志筛选。
- 智控台业务页面快捷跳转。

### 阶段五：发布验证

- 自动启动测试。
- GPU 冷启动测试。
- 6008 WSS 完整链路测试。
- SSH 隧道与局域网测试。
- 敏感信息扫描。
- 暖镜像准备与发布说明。

## 25. 已知风险与待验证项

1. IndexTTS 自动线程策略仍需在正式 GPU 配置中记录首包延迟、RTF 和峰值资源。
2. MySQL 是否直接由 Supervisor 前台管理需要结合现有 Ubuntu 配置实测。
3. 当前系统盘空间紧张，构建后应清理 Maven/npm 临时缓存，但不得删除运行依赖。
4. IndexTTS 权重随镜像分发必须保留完整许可证，并确认发布页满足下游许可义务。
5. 用户选择不同 CPU/GPU 规格时，需要验证线程数、显存和冷启动时间。

## 26. 最终产品形态

```text
WebUI 6006：小智 AutoDL 运维中心
WebUI 6008：原始小智智控台 + API + OTA + WSS
```

启动入口：

```text
/root/autodl.sh
```

项目原则：

```text
保持上游源码独立
复用现有运行环境
保留已调通业务配置
仅清理必要私人凭据
尽量减少镜像用户操作
```
