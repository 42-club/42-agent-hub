# P0 demo 交付记录

日期：2026-11-02（Asia/Shanghai）。范围：邀请制、优先验收圆桌讨论。资源归属已由用户确认：Vercel、Supabase、OpenRouter、Resend、域名/DNS 均由用户控制。

## 当前状态

| 项目 | 状态与证据 |
| --- | --- |
| 配套源码 | Hub 分支 `codex/p0-demo-readiness`，Service 分支 `codex/p0-hub-contract`；按职责拆分提交并通过配套 PR 审阅，尚未部署；实际提交和内容摘要由 `release:manifest` 输出 |
| 初始版本 | Hub `9c72dcd`，Service `da0a80a`，Agent `ba8b40c`；这些是修改前基线，不代表本次完成后的发布版本 |
| 缺失接口 | 已重新实现 Service 内部协议 2：加密记录、CAS、稳定 writeId、短事务执行租约、数据库环境校验 |
| Agent 来源 | vendor 压缩包 SHA-256 与源码提交见 `vendor/42-agent.provenance.json`；106 个运行时 JS/声明文件经 CRLF/LF 规范化后与干净源码重新编译结果一致 |
| 环境隔离 | 部署不读取同级 `.env`，要求显式 Service 地址；内部读写均检查 Service、Hub、数据库环境；生产禁止本地测试存储 |
| 邀请访问 | 生产默认且要求邀请模式，组织 UUID 白名单必填；服务端限制组织入口，不能仅靠隐藏 UI |
| 认证代理 | 支持来自明确信任入口头的签名访客 IP，Service 验签后用于限流；429 冷却信息传回 UI。未配置受信入口头时保留连接 IP，仍可能共享限流 |
| 本地完整闭环 | 已通过 Next 生产构建 → Nest → 加密存储 → 独立 demo Worker 的两轮真人讨论，覆盖注册、邀请、重复行动、回放、房主权限、暂停/继续/结束、退出和重新登录恢复 |
| PostgreSQL | 已在独立临时 PostgreSQL 17.6 实例验证跨应用 CAS、租约 fencing、回执重放、环境表禁止 UPDATE/TRUNCATE、Data API 角色拒绝读取；实例已停止并清理 |
| 云端验收 | 未执行；当前进程没有云端凭据，尚未获得独立 Preview 连接配置，未修改生产数据或线上环境 |

本次检查：Hub 全量回归 66 项通过；Service 全量 84 项通过、14 项外部数据库测试默认跳过；独立 PostgreSQL 专项另行运行 5 项全部通过。双方类型检查与生产构建通过，最终 Next 生产构建的本地完整冒烟通过。默认跳过项不计入通过数。

## 复现本地验收

在 Service 目录：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test
```

在 Hub 目录：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run test:demo
pnpm run verify:vendor
pnpm run release:manifest
```

`test:demo` 要求同级 Service 已构建，可用 `HUB_SERVICE_SOURCE` 指定源码目录。它自动创建内存数据库、随机测试凭据和临时本地进程，结束后清理；不使用生产账号、不发送邮件、不调用收费模型。`scripts/verify-shared-backend.mjs` 是兼容入口，不再接受远程数据库或写出明文账号文件。

真实 PostgreSQL 检查在 Service 执行 `pnpm run test:hub-runtime-postgres`。先将 `HUB_TEST_PG_BIN` 配置为现有 PostgreSQL `bin` 目录。命令仅创建临时 loopback 集群和一次性 `hub_reliability_test` 数据库，不接受已有库地址。没有二进制时明确失败；默认 `pnpm test` 中这些外部数据库测试跳过，不能把跳过当成通过。

## 环境配置与发布顺序

1. 使用独立 Preview 数据库，先应用 Service 初始迁移，再应用 `20261102000000_hub_records.sql`。这是重新补齐的**新建库结构**，不是已确认兼容历史生产表的升级脚本。
2. 由管理员确认库独立后，将该库 `agent_service.hub_runtime_environment` 的唯一行标记为 `development`。运行账号只能 SELECT，不能改标签；绝不修改生产库标签来绕过保护。
3. Service 配置专用运行角色、数据库 TLS、独立 JWT/加密/限流密钥、测试环境机器令牌及真实邮件配置。Hub 显式配置相同环境的 `CLUB_SERVICE_URL`、独立 `HUB_SERVICE_TOKEN`。
4. 管理员在测试组织配置模型连接和预设 Agent。Hub 设置 `HUB_ACCESS_MODE=invite-only`、`HUB_ALLOWED_ORGANIZATION_IDS=<测试组织 UUID>`；生产同样要求组织白名单。
5. 只将经过确认由托管入口覆盖的单一客户端 IP 头配置到 `HUB_TRUSTED_CLIENT_IP_HEADER`。不要信任浏览器自报的 X-Forwarded-For 或逗号链。Hub 与 Service 机器令牌一致后才能验签归因。
6. Preview 使用真实云端 Workflow；生产构建的 `NODE_ENV=production` 不等于可以访问生产数据。生产发布要求双方 `HUB_DEPLOYMENT_ENV=production` 且数据库标签为 production。
7. 先发布匹配 Service，再发布 Hub。用 `pnpm run verify:deployment` 做只读预检；该命令要求已注入运行配置和 `HUB_VERIFY_URL`，不会写入、发邮件或调用模型。
8. 完成下方验收后生成 `release:manifest`，记录三个仓库提交、工作区是否干净、内容摘要和 vendor 摘要。发布应从已审阅且干净的版本生成；不能把修改前 HEAD 当作当前工作区的发布标识。

## 真实云端验收

`pnpm run verify:live-demo` 已提供可执行入口，但本次未运行。它只接受 development 标签、邀请模式和显式 `HUB_VERIFY_TARGET=isolated-preview`。配置 `HUB_VERIFY_URL`、`HUB_VERIFY_EMAIL`、`HUB_VERIFY_PASSWORD`、`HUB_VERIFY_ORGANIZATION_ID`、`HUB_VERIFY_AGENT_ID`，以及对应 Service 地址和机器令牌。密码只通过本机环境或密钥管理器注入，不写入仓库、日志或聊天。

命令在指定测试组织创建一个有 `P0 acceptance` 标题的真实模型房间，使用同一预设 Agent 的两个独立席位与一个真人席位完成两轮讨论。它会产生模型费用，不自动重复未知结果或失败行动；失败时尽力暂停，保留房间供检查。超时无法确认暂停时需房主检查。还需手工完成真实邮件注册、第二账号接受邀请、浏览器刷新重连和界面检查。

| 验收项 | 本次结果 |
| --- | --- |
| 独立 Preview 部署、配套内部协议 | 待云端配置 |
| 真实注册邮件、验证码、多人限流 | 待验收 |
| 云端 Workflow + 真实收费模型完整讨论 | 待验收 |
| 无效 Key、余额不足、超时和调度失败的云端恢复 | 待验收；本地已有模拟故障回归 |
| 既有生产数据库结构和加密格式兼容 | 待只读核对；不允许直接套用新建库迁移 |

## 发布前的资源核对

用户已确认资源控制权；仍需在目标环境核对实际设置。记录各资源负责人、团队/项目名、账单与续费归属、最小权限、密钥保管位置和恢复入口，禁止记录明文密钥。检查 Vercel、数据库、OpenRouter、Resend、域名/DNS。

外部 API Key 和机器令牌应先验证新值再撤销旧值；JWT 变更会使已有会话失效。`APP_ENCRYPTION_KEY` 对应既有 k1 密文，必须保留恢复材料，不能直接替换。资源归属确认不等于本次已更换凭据或验证邮件域名。

## 故障恢复与回退

- 登录失败：核对 Service 可达性、JWT 配置、当前组织；查看脱敏服务日志。
- 验证码 429：读取 Retry-After 和倒计时，核对受信 IP 入口及双方机器令牌；不要直接关闭生产限流。
- 环境拒绝：核对双方标签和数据库，只修正错误连接配置，不能把生产库重标成 development。
- 房间停滞：先读房间状态和已提交行动；房主暂停后再决定是否继续。未知模型结果可能已经计费，不自动重试。
- 行动已保存但调度失败：保留原请求 ID；可重试原请求或由房主暂停/继续重新调度，不能新建重复行动绕过幂等。
- 回退：保留数据及迁移，回退到经过兼容验证的 Hub/Service 配套版本。暂停并排空写入者后才能调整存储协议；不能让新旧执行器同时写入。
- 本次未改变现有生产 schema。若后续只读核对发现旧表，需要单独准备兼容迁移和回退，不能删除旧表后重建。

P0 尚未全部关闭：本地代码与发布准备已完成，真实云端闭环、现有生产兼容性和目标资源配置验证仍是发布前置条件。
