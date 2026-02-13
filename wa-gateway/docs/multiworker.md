# 多 worker 配置说明（方案 A）

## 目录职责

- `CONFIGDIR`：共享配置根目录（默认 `DATA_DIR/data`）。
  - 共享：`workspaces/<ws>/accounts.json`、`roles.json`、`groups.json`、`history.json`、`scheduled_jobs*.json`。
- `WORKDIR`：运行态根目录（默认等于 `CONFIGDIR`）。
  - 隔离：`workspaces/<ws>/wwebjs_auth`、`scheduled_uploads` 等运行时目录。

当 `CONFIGDIR` 与 `WORKDIR` 不同时：
- 账号/角色/群组等配置由所有 worker 共享。
- WhatsApp LocalAuth 会话目录按 worker 隔离，避免浏览器态互相影响。

## 两个 worker 启动示例

```bash
# worker 1
PORT=3001 CONFIGDIR=./data_shared WORKDIR=./data_w1 node server.js

# worker 2
PORT=3002 CONFIGDIR=./data_shared WORKDIR=./data_w2 node server.js
```

或使用 package scripts（仅示例）：

```bash
npm run start:worker1
npm run start:worker2
```

## 并发一致性

`accounts.json` / `roles.json` / `groups.json` 等共享配置写入使用 `*.lock` 文件锁（`openSync(lock, "wx")`），并在 15s 超时前轮询重试，保证跨进程 `read+modify+write` 原子性，避免并发覆盖写。

## 可观测性

- JSON 自愈：
  - `json_recover_from_bak`
  - `json_recover_restored`
- 自愈重建：
  - `rebuild_start`
  - `rebuild_done`
  - `rebuild_fail`
  - `puppeteer_detached_retry`
- 最近日志接口：`GET /api/system/recentLogs`
