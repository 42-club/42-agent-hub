# 42 Agent Hub

与真人和 Agent 围桌讨论、玩谁是卧底或狼人杀。界面沿用纸色、鼠尾草绿和圆角风格。

## 线上服务

- Hub：https://42-agent-hub.vercel.app
- Meeting：https://42-meeting.com （另有 https://42-meeting.vercel.app）
- Admin：https://42-admin.vercel.app
- 共享后端：https://42-agent-service.vercel.app/api/v1

四个项目均已关联 42 Club 的 Vercel。数据库统一使用共享后端关联的 Supabase 项目；前端不再连接各自旧的 Auth 或业务数据库。数据库迁移由同级 `42-agent-service/supabase/migrations` 管理。

## 账号、组织与数据

登录、注册、邮箱验证、找回密码、组织、成员和邀请统一使用 `42-agent-service` 原有 API。已有 Meeting / Admin 的已验证账号已按邮箱合并到唯一成员 ID，保留原账号密码的 bcrypt 验证器；修改或重置密码后，旧验证器与旧会话失效。运行时不依赖旧 Supabase Auth。

组织内成员可查看圆桌，开场前加入真人席位。只读成员不能修改或入座；模型连接由组织 Owner / Admin 配置；圆桌由房主控制。Admin 另保留招聘业务权限，加入组织不会自动获得候选人资料权限。

Hub 必须登录后进入：未登录和会话验证期间不挂载大厅、Agent 或圆桌页面；直接访问房间链接同样显示登录页，登录后继续访问原地址，退出后立即回到登录页。业务接口始终在服务器验证身份。

浏览器仅保存 HttpOnly 会话 Cookie，各站使用同一账号登录。每次 API 请求均校验共享账号和当前组织成员关系。共享 PostgreSQL 包含：

- `agent_service`：账号、组织、成员、加密 Hub 记录、执行锁和旧身份映射。
- `club_meeting`：活动、报名、工作进度、分析和设备凭证。
- `club_recruiting`：招聘、附件、标签、审计、队列和搜索。

两个业务 schema 的 profiles 都是共享账号/成员视图，没有第二份成员表。私有附件也已迁往同一 Supabase 项目的 Storage。旧业务库保留为只读备份。

## 本地运行与环境复用

需要 Node.js 22.13+。执行核心以 `vendor/42-agent-0.1.0.tgz` 固定打包，部署无需依赖上级目录。

```sh
npm install
npm run dev
```

`npm run dev` 启动 Next.js 和本机执行器。生产构建为 `npm run build`；本机常驻部署可使用 `npm start`。默认 Web 端口 3000，执行器端口 4317。

Hub 从 `../42-agent-service/.env.local`、`.env` 复用缺失的 `CLUB_SERVICE_URL` / `HUB_SERVICE_TOKEN`。Meeting / Admin 也从同一目录读取共享地址、组织和各自独立的服务凭证。项目自身和进程环境优先；可用 `CLUB_ENV_DIR` 调整目录。

共享后端配置 `CLUB_SUPABASE_URL`、`CLUB_SUPABASE_SECRET_KEY`、`CLUB_ORGANIZATION_ID`、`CLUB_MEETING_TOKEN`、`CLUB_RECRUITING_TOKEN`、`HUB_SERVICE_TOKEN`，以及原有 PostgreSQL、JWT 和加密配置。三个机器凭证独立生成，前端浏览器不可见。Hub 不需要数据库密码或 JWT 签名密钥。

## Vercel 执行

Vercel 部署配置 `HUB_EXECUTION=workflow`、`CLUB_SERVICE_URL`、`HUB_SERVICE_TOKEN`。Workflow 每一步执行一个游戏阶段，通过共享数据库执行锁和版本校验保护状态；轮到真人时结束当前工作流，真人提交后启动后续工作流，因此无需另备常驻服务器。

每个 Agent 使用打包的独立 Node.js 子进程。每次模型调用前记录执行尝试；未知结果或执行中断不会自动重复计费请求。需要房主处理或继续时，界面显示对应状态。默认模型调用期限 180 秒，Vercel 函数上限 300 秒。

房间、消息、秘密状态和连接密钥保存在后端加密记录中；写入确认后才返回成功。临时目录仅存可丢弃的进程工作文件。SSE 会定期重连并重新检查会话；短暂重连不会显示为掉线。

## 真人参与

1. 登录并选择组织；新账号可创建组织或接受邀请。
2. 创建任意玩法时勾选「我要参加」，或在开场前点击「添加我的席位」。每个成员一个席位，最多 12 席。
3. 开场后席位固定，讨论、描述与复盘按席位轮流发言；投票和夜间技能遵守角色权限。
4. 真人必须本人提交行动，Agent 不会代答。私信、身份和词语仅向获授权的参与者展示。
5. 只有当前用户自己的消息靠右，其余真人和 Agent 靠左。

「离线演示」只替代模型输出，仍使用真实共享账号、组织、数据库和云端工作流。

## 验证与维护

```sh
npm run typecheck
npm test
npm run build
```

独立测试库可运行 `scripts/verify-shared-backend.mjs` 和 `scripts/verify-human-games.mjs`。固定验证码仅用于 `NODE_ENV=test`，不能配置到生产。

实际数据迁移、线上验证和回滚边界见 [验证记录](docs/shared-account-verification.md) 与共享后端的 `docs/club-consolidation.md`。原本地 Hub 的 15 场圆桌和 13 个 Agent 已导入现有 42.ai 组织，保留原 ID；源 SQLite 保留备份。
