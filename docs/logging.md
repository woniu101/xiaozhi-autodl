# AutoDL 日志约定

## 日志来源

| 服务 | Dashboard 默认来源 | 可选来源 | 关键事件 |
| --- | --- | --- | --- |
| Web Gateway | 访问日志 | 错误、启动 | 外部请求、4xx/5xx、上游连接失败 |
| MySQL | 错误日志 | 慢查询 | 启停、恢复、连接错误、超过 2 秒的 SQL |
| Redis | 服务日志 | - | 启停、RDB/AOF、内存和连接错误 |
| Manager API | 应用日志 | 接口访问 | 登录、配置操作、应用异常 |
| IndexTTS 2.5 | 业务日志 | 原始日志 | 模型加载、排队、合成、RTF、失败与取消 |
| 小智服务端 | 业务日志 | 原始日志 | 设备连接、ASR、LLM、TTS、降级与重试 |

Dashboard 自身和 Supervisor 的日志同样写入数据盘，但不计入六项业务服务。

## 目录与轮转

```text
/root/autodl-tmp/xiaozhi-autodl/logs/
├── dashboard.log
├── manager-api.log
├── index-tts.log
├── xiaozhi-server.log
├── web-gateway.log
├── nginx-access.log
├── nginx-error.log
├── mysql/
│   ├── error.log
│   └── slow.log
├── redis/
│   └── redis-server.log
└── archive/
```

- Supervisor 应用日志：20MB × 5；Web Gateway 启动日志：10MB × 2。
- Nginx 日志：最大 50MB，保留 3 份并压缩。
- MySQL、Redis：最大 20MB，保留 5 份并压缩。
- logrotate 每 10 分钟检查一次；未达到大小和周期条件时不会轮转。
- 应用不得同时写 Supervisor stdout 和项目目录文件，避免重复占用系统盘。

## 等级与字段

- `INFO`：服务生命周期、业务开始/完成、配置生效。
- `WARN`：降级、重试、慢请求、客户端取消。
- `ERROR`：业务失败、依赖失败和异常堆栈。
- `DEBUG`：仅临时排障启用，镜像默认禁用 SQL 和模型 DEBUG。

跨服务调用应尽量携带同一个 `request_id`。IndexTTS 合成日志至少包含 `request_id`、`voice_id`、模式、排队时间、音频时长、推理时间和 RTF。

## 安全与探针

- API Key、Token、密码和 Authorization 头禁止写入日志。
- Dashboard 返回日志前会再次脱敏，但这不是应用输出秘密的理由。
- 成功的 `/health/live`、`/health/ready` 和 `/internal/metrics` 不进入默认业务视图。
- 探针失败、4xx、5xx 和超时始终保留。
- WebSocket 就绪检查使用 8000 端口探测，不向升级端点发送普通 HTTP GET。
