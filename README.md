# 小智 AutoDL 运维中心

当前项目同时覆盖日常运行、版本维护和 AutoDL 镜像制作。镜像采用“系统盘种子 + 数据盘实例数据”结构：代码、模型和预置内容进入镜像，口令、音色副本、人物资源、输出与日志保存在 `/root/autodl-tmp`。

## 镜像工作流

首次启动与镜像准备统一使用仓库内脚本：

```bash
# 日常/新实例首次初始化
/root/xiaozhi-autodl/bin/first-boot

# 发布检查：运行态、封镜前、封镜后
/root/xiaozhi-autodl/scripts/validate-release --mode runtime --quick
/root/xiaozhi-autodl/scripts/validate-release --mode pre-image

# 先预演，再在普通 SSH 终端中执行封镜准备
/root/xiaozhi-autodl/scripts/prepare-image --dry-run
/root/xiaozhi-autodl/scripts/prepare-image --apply

# AutoDL 保存完镜像后，恢复当前实例的开发状态
/root/xiaozhi-autodl/scripts/resume-development --dry-run
/root/xiaozhi-autodl/scripts/resume-development --apply
```

`prepare-image --apply` 会先将数据库、运行配置和开发身份备份到数据盘，再定向清除系统盘中的实例凭据。它不会删除智控台 `xiaozhi` 内置账号、兔娘智能体、兔娘音色、模型配置骨架或模型文件。详细边界、目录和恢复步骤见 [`docs/image-workflow.md`](docs/image-workflow.md)。

## 日常更新与构建

Dashboard 运行的是编译产物，不会自动感知 manager-web、manager-api 或 Dashboard 源码变化。更新源码后执行：

```bash
/root/xiaozhi-autodl/scripts/refresh-runtime all
```

该命令会按当前磁盘中的源码重新构建 Dashboard、manager-web、manager-api，并按刷新前状态重启小智服务端和 IndexTTS；刷新前已停止的服务会保持停止。manager-web 与 manager-api 采用原子替换并保留一个上一版本产物，避免构建中断覆盖可运行版本。Dashboard 顶部会显示版本号和最近一次统一刷新时间。

只改了某一端时可缩短更新时间：

```bash
/root/xiaozhi-autodl/scripts/refresh-runtime dashboard
/root/xiaozhi-autodl/scripts/refresh-runtime manager-web
/root/xiaozhi-autodl/scripts/refresh-runtime manager-api
/root/xiaozhi-autodl/scripts/refresh-runtime xiaozhi-server
/root/xiaozhi-autodl/scripts/refresh-runtime index-tts
```

Dashboard 顶部的“代码版本”胶囊进入独立版本管理页，按 GitHub 仓库名展示 `xiaozhi-esp32-server`、`index-tts` 与 `xiaozhi-autodl`。Dashboard 启动 8 秒后会自动检查，此后每 30 分钟检查一次，也可手动检查单个或全部仓库。版本状态只比较实际部署分支：`xiaozhi-esp32-server` 固定使用 `mvp`，另外两个仓库固定使用 `main`，其他远端分支不会参与检查或显示。远端检查只读取部署分支，不会在检查阶段修改工作区。

发现更新后，版本页会预览落后提交、变更文件和受影响组件。“安全更新”要求工作区无受保护改动且部署分支可快进，随后只构建受影响组件，按更新前状态刷新服务并健康检查；原本停止的服务保持停止，构建或验收失败时自动回到旧提交。依赖清单变化会暂停自动更新，避免不可回滚地修改 Conda/npm/Maven 环境。

`xiaozhi-autodl` 自身更新由独立助手执行，操作状态和日志写入数据盘，因此 Dashboard 重启不会中断更新，也不会丢失结果。它会按 `package-lock.json` 确定性恢复 Node.js 依赖、构建新版本、重启并检查 6006 健康状态；失败时恢复旧提交、旧依赖和旧运行版本。Dashboard 重启会使当前运维登录会话失效，重新输入口令后即可查看完整升级结果。

三个仓库共用同一套带项目名的更新步骤、耗时和日志视图。运行中与失败结果保持展开；成功后自动收成一行摘要，最近 10 次结果可从“更新记录”重新打开，因此不会由常驻完成卡片长期占用页面。

版本页可独立设置 GitHub 网络策略，默认“自动选择”：Git 子进程先直接连接 5 秒，失败后才读取 AutoDL 的 `/etc/network_turbo` 回退到学术加速。也可固定直连、固定学术加速或填写自定义 HTTP/SOCKS5 代理。该设置只影响 GitHub 检查和安全更新，不修改全局代理，也不会让 DeepSeek、Java 后端或语音服务经过代理。AutoDL 学术加速适合 GitHub 等学术资源，但不承诺稳定性；页面会显示本次实际使用的线路和耗时。

## 启停

```bash
/root/xiaozhi-autodl/bin/suite-start
/root/xiaozhi-autodl/bin/suite-stop
```

- Dashboard：`http://服务器地址:6006`
- 原始智控台与小智网关：`http://服务器地址:6008`
- Dashboard 首次打开时由用户创建 8-32 位运维口令，不再生成或保存明文初始密码。

忘记运维口令时执行：

```bash
/root/xiaozhi-autodl/bin/reset-dashboard-passcode
```

Dashboard 顶部可以直接打开智控台的“智能体管理”和“模型配置”。AutoDL 公网环境会优先使用平台提供的 6008 WebUI 地址；也可以在 `config/defaults.env` 中设置 `MANAGER_WEB_PUBLIC_URL` 覆盖。

测试客户端不需要等到镜像发布，也不必默认使用 SSH 隧道。只要实例正在运行且 AutoDL 已为 6008 分配公网 WebUI 地址，即可使用：

```text
OTA:       https://<AutoDL-6008域名>/xiaozhi/ota/
WebSocket: wss://<AutoDL-6008域名>/xiaozhi/v1/
```

Dashboard 的“客户端接入”会根据 `AutoDLService6008URL` 自动生成并同步上述地址；也可切换为局域网/SSH 隧道或自定义域名模式。同步操作只修改白名单参数 `server.ota` 与 `server.websocket`，配置保存于 `/root/autodl-tmp/xiaozhi-autodl/config/endpoints.json`，不会把开发实例域名固化到项目文件。

局域网无法直连 AutoDL 容器时，可在本地主机执行：

```bash
ssh -N -L 6006:127.0.0.1:6006 -L 6008:127.0.0.1:6008 root@服务器地址
```

系统总览的 CPU、内存和运行时间均来自当前容器的 Cgroup/PID 1，不使用宿主机总量；磁盘单独展示系统盘 `/` 与数据盘 `/root/autodl-tmp`。服务健康摘要始终位于页面标题右侧，按失败、异常、受限、启动中、停止中、停止、正常七种语义着色，点击后会定位并突出所有未就绪服务。

运行总览采用紧凑的一屏布局：代码版本改为标题区胶囊，远端检查、本地修改列表、更新预览、步骤与日志都放在 `/versions` 独立页面。六张服务卡分别展示业务连接/请求、错误、响应延迟、JVM 堆、IndexTTS 队列、MySQL 连接和 Redis 命中率等关键信号；指标可点击打开对应日志筛选。

服务按钮由后端状态矩阵统一决定：失败或已停止的服务只允许启动（失败态显示“重试启动”），启动中只允许停止，运行或等待就绪时允许停止和重启，停止中禁用全部动作。资源或依赖受限的服务显示具体门禁原因并禁用启动；切换实例配置且条件满足后会自动恢复为可启动。单项操作与批量操作互斥；批量停止会继续处理所有服务，批量启动遇到依赖失败时会明确跳过下游服务。Redis 使用 `SHUTDOWN SAVE` 优雅停止并通过 `PING` 验证，避免 SysV 脚本误报停止成功。

IndexTTS 默认要求容器至少 2 核 CPU、8GB 内存、NVIDIA GPU 和 8GB 显存；小智服务端默认要求至少 1 核 CPU、4GB 内存。阈值可通过 `config/defaults.env` 调整。两项重服务不做无限自动重启：启动前由 `/root/xiaozhi-autodl/bin/service-preflight` 读取 Cgroup 与 GPU 状态，条件不足时只记录一次“资源不足，未启动”；小智还会等待 Manager API 与 IndexTTS 就绪后再加载自身组件。

## 日志

六项服务日志统一保存在数据盘 `/root/autodl-tmp/xiaozhi-autodl/logs`。Dashboard 默认展示业务日志，成功的内部健康探针不会进入 Nginx 访问日志，也不会挤占 IndexTTS 日志窗口；小智与 IndexTTS 可切换“原始日志”查看完整模型和运行输出。MySQL 提供错误日志与超过 2 秒的慢查询日志。

Java、Python 和 Node 服务只向标准输出写一份日志，由 Supervisor 按每份 20MB、5 个备份轮转；Nginx、MySQL、Redis 由每 10 分钟执行的 logrotate 任务管理。日志不得输出 API Key、Token 或密码，Dashboard 读取时还会执行二次脱敏。日志来源、等级和排障方式详见 [`docs/logging.md`](docs/logging.md)。
