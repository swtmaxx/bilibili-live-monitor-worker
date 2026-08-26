# Bilibili Live Monitor Worker

Cloudflare Workers + D1 的 Bilibili 直播状态监控器。每分钟由 Cron 唤醒，按设置的实际间隔批量查询 Bilibili 状态，只在开播或下播时通过一个 QQ 官方机器人通知多个私聊/群聊目标。

## 功能

- 监控 Bilibili UID 或直播间号；添加直播间号时自动解析 UID。
- 默认每分钟检查，可在管理页调整为 1-60 分钟。
- Bilibili UID 批量查询，每批最多 50 个 UID。
- 仅通知“未开播 -> 开播”和“开播 -> 未开播”。未知状态、超时、429 和 5xx 不会误判为下播。
- QQ AccessToken 内存缓存，401 自动刷新并重试一次。
- D1 outbox 记录通知，发送失败指数退避，最多 8 次。
- 管理页内置在 Worker 的 `/admin`；首次打开时设置管理员密码，之后使用 D1 会话登录，浏览器只保存短期会话令牌。

## 部署

### GitHub Actions 一键部署

仓库中的 `.github/workflows/deploy.yml` 支持手动部署。第一次需要在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions` 添加以下 Secrets：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_D1_DATABASE_ID
```

其中 API Token 需要有 Workers 部署和 D1 编辑权限。创建 D1 后复制它的 ID，填入 `CLOUDFLARE_D1_DATABASE_ID`。

之后打开仓库的 `Actions -> Deploy Cloudflare Worker -> Run workflow`，点击运行即可自动完成测试、D1 迁移和 Worker 部署。上述三个 Secrets 只用于 GitHub Actions，不是 Worker 运行时环境变量。

需要安装 Wrangler 并登录 Cloudflare：

```bash
npm install -g wrangler
wrangler login
```

创建 D1：

```bash
wrangler d1 create bilibili-live-monitor
```

把命令输出的 `database_id` 填入 `wrangler.toml` 的 `database_id`。

执行迁移：

```bash
wrangler d1 migrations apply bilibili-live-monitor --remote
```

无需设置 Worker Secrets。首次打开 `/admin` 时设置管理员密码，然后在页面的“QQ机器人”面板填写 AppID 和 ClientSecret。

部署：

```bash
npm run check
npm test
wrangler deploy
```

部署后打开：

```text
https://你的Worker域名/admin
```

首次打开页面时输入至少 12 个字符的管理员密码。密码只以 PBKDF2 哈希形式写入 D1，登录后签发 30 天会话令牌。QQ AppID 和 ClientSecret 通过页面写入 D1，ClientSecret 不会回显到页面或 API 响应。

## 管理流程

1. 在“监控对象”中添加 `room` 或 `uid`。
2. 在“通知目标”中添加 QQ 私聊 `user_openid` 或群聊 `group_openid`。
3. 在“设置”中选择检查间隔、开播/下播通知和文本/Markdown 格式。
4. 点击“立即检查”验证查询和状态更新。

API 管理请求均需携带登录后得到的会话令牌：

```text
Authorization: Bearer SESSION_TOKEN
```

示例：

```bash
curl -H "Authorization: Bearer SESSION_TOKEN" https://你的域名/api/status
curl -X POST -H "Authorization: Bearer SESSION_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"room","id":"21686237","label":"央视新闻"}' \
  https://你的域名/api/monitors
```

## Cloudflare Free 预算

Cloudflare Workers Free 单次请求最多约 50 个外部子请求。本项目每批最多查询 50 个 UID，每次 Cron 最多处理 36 个 Bilibili 批次，并限制每次最多 10 次 QQ 发送尝试。超过本次预算的监控会留到后续 Cron 继续处理。

当前 5 个测试直播间只需要一个 Bilibili 批量查询请求：

```text
21686237
1758150976
1829590
10143101
8579849
```

## 重要限制

- Bilibili 接口可能限流或临时返回未知状态；项目不会把未知状态当作下播。
- QQ 机器人必须拥有对应的私聊/群聊发送权限，私聊目标应先与机器人建立关系。
- Cloudflare Cron 使用 UTC 调度；配置变更传播可能需要几分钟。
- ClientSecret 会存入 D1，因此必须保护 Cloudflare 账号、Worker 管理权限和 D1 权限。部署后如曾公开过旧密钥，应在 QQ 开放平台重置。
