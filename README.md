# 小智 AutoDL 运维中心

当前阶段目标是在现有 AutoDL 实例上完成基础运行与运维，不涉及镜像制作。

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

Dashboard 顶部的“代码版本”胶囊进入独立版本管理页，按 GitHub 仓库名展示 `xiaozhi-esp32-server` 与 `index-tts`。Dashboard 启动 8 秒后会自动检查，此后每 30 分钟检查一次，也可手动检查单个或全部仓库。版本状态只比较实际部署分支：`xiaozhi-esp32-server` 固定使用 `mvp`，`index-tts` 固定使用 `main`，其他远端分支不会参与检查或显示。远端检查只执行目标分支的 `git fetch`，不会修改工作区。

发现更新后，版本页会预览落后提交、变更文件和受影响组件。“安全更新”要求工作区无受保护改动且部署分支可快进，随后只构建受影响组件，按更新前状态刷新服务并健康检查；原本停止的服务保持停止，构建或验收失败时自动回到旧提交。依赖清单变化会暂停自动更新，避免不可回滚地修改 Conda/npm/Maven 环境。

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

系统总览的 CPU、内存和运行时间均来自当前容器的 Cgroup/PID 1，不使用宿主机总量；磁盘单独展示系统盘 `/` 与数据盘 `/root/autodl-tmp`。服务健康摘要始终位于页面标题右侧，按失败、异常、启动中、停止、正常五种语义着色，点击后会定位并突出所有未就绪服务。

运行总览采用紧凑的一屏布局：代码版本改为标题区胶囊，远端检查、本地修改列表、更新预览、步骤与日志都放在 `/versions` 独立页面。六张服务卡分别展示业务连接/请求、错误、响应延迟、JVM 堆、IndexTTS 队列、MySQL 连接和 Redis 命中率等关键信号；指标可点击打开对应日志筛选。
