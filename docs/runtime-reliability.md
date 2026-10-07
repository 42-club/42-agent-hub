# 第一批运行可靠性改造

本批保留组织/成员身份、应用独立登录、现有 UI、游戏规则及真人轮流行动。Hub 与 Service 已于 2026-09-29 配套发布到 Vercel production。本次没有修改既有线上房间。

## 执行与提交

- 启动不再扫描并暂停所有 `running` 房间。本地恢复只读取数据库已过期租约，匹配持久化 attempt 的 owner，再次原子取得租约后暂停结果不确定的执行。缺少所有权证据的旧记录不自动接管。
- 60 秒执行租约按秒续租并检查权威状态；数据库时间决定过期。续租不能复活已过期租约，释放不能释放其他 owner 的租约。释放保留过期记录，供恢复核对。
- 模型调用前先提交 attempt（owner、执行代次、phaseVersion、席位）。持有的是可过期执行租约，数据库事务不跨模型调用。
- 暂停/结束只做短状态提交，增加执行代次，不取得模型租约。工作进程收到本地 abort 或轮询发现远端状态变化后尽力取消请求。上游是否停止生成/计费不能保证。
- 行动写回检查执行代次、phaseVersion、owner 和数据库租约有效期，并使用记录版本 CAS。模型并行席位的提交在进程内按房间串行，跨进程由 CAS 与租约约束。已确认行动始终保留。
- 不确定的模型调用不会自动重试。过期 attempt 恢复为暂停；房主显式继续时仅重试未完成席位，这种重试仍可能再次计费。
- Workflow 携带执行代次，重复启动必须竞争同一房间租约，且从已提交状态寻找未完成行动。旧代次不能推进新一轮。步骤保留 `maxRetries = 0`。

## 存储与请求

- SharedHubStore 按记录维护写入队列和失败状态；房间 A 的失败不阻断 B。SSE 仅发布确认过的快照。
- 区分网络失败、权限/环境拒绝、版本冲突与其他存储失败。后续请求重新读取权威状态，放弃失败的乐观状态。
- 存储重试复用 writeId；服务保存最后一次 writeId，丢失 HTTP 回执时可以确认原提交。冲突只重新读取并重放纯状态变更，绝不重新调用模型。
- 行动 ID 在游戏状态内校验 actor、phase、工具和参数；重放已确认行动可在暂停后得到当前快照。席位按成员唯一，控制与席位的幂等键绑定成员和操作，收据与业务状态在同一 CAS 提交中保存。数据库仍使用现有房间主键和租约 scope 主键，没有拆分业务数据表。
- 前端用同步 ref 拦住同一事件周期的双击，并在失败后保留请求 ID。控制请求携带预期执行代次；共享模式拒绝无幂等键/代次的旧控制客户端，要求刷新页面。
- Next 代理仍验证登录、当前组织和成员角色，Coordinator 再检查组织、只读角色、房主和真人席位。规则引擎继续校验当前行动权限和轮次。

## 发布顺序与环境保护

1. 先在独立的开发/预发布库应用 Service 迁移 `20260929092326_hub_runtime_safety.sql`，然后应用 `20260929153210_hub_runtime_environment_readonly.sql`。前者添加 `hub_records.lastWriteId` 和受 RLS 保护的 `hub_runtime_environment` 单行表；后者显式撤销数据库默认权限可能授予 runtime 角色的写入和 TRUNCATE 权限，再授予 SELECT。已有库默认标记为 `production`。Runtime 账号只能读取标签，不能修改。
2. **仅对确认独立的非生产数据库**，由数据库管理员执行：
   ```sql
   UPDATE agent_service.hub_runtime_environment SET environment='development' WHERE singleton=true;
   ```
   不要为了让本地开发工作而把共享生产库改成 development。
3. 开发端无须设置 `HUB_DEPLOYMENT_ENV`；`npm run dev` 明确给 Coordinator 和 Next 设置 `NODE_ENV=development`。生产 Hub 与 Service 都需要 `NODE_ENV=production`、`HUB_DEPLOYMENT_ENV=production`；Vercel 上还必须处于 production 环境。Preview 归为 development，不能连接生产写入。
4. 确认旧执行器已由运维安排停止/排空后，先发布新 Service，再发布新 Hub。新 Service 拒绝缺少 `x-hub-protocol: 2` 或环境标签不匹配的写入/租约请求，防止旧代码继续绕过 fencing。期间旧 Hub 写入将被拒绝，应安排维护窗口。此任务没有停止任何用户服务。
5. SQL.js 的兼容迁移为 `1725063600000-hub-runtime-safety.ts`，只用于遗留隔离测试；共享执行要求现有 PostgreSQL 租约表。无需新增付费设施。
6. 发布后使用专用测试组织/新测试房间做冒烟验证，不能使用生产中的既有房间做破坏性测试。

## 回退

优先保留新增列和环境表并回退到修复版应用；它们不改变原业务数据。回退到旧执行器会重新引入长锁、启动批量暂停和失去 fencing 的问题，不适合让新旧执行器同时写入。

若必须撤销数据库变更，先停止/排空本次 Hub 执行器与所有其他 Hub 写入者，保留房间数据备份，再在维护窗口回退 Service/Hub，并执行：

```sql
BEGIN;
DROP TABLE agent_service.hub_runtime_environment;
ALTER TABLE agent_service.hub_records DROP COLUMN "lastWriteId";
COMMIT;
```

不要删除房间数据、现有租约表或已确认行动。SQL.js 可用 `migration:revert` 撤销最后一条兼容迁移。PostgreSQL 回退/重放已在临时本机数据库测试。

## 验证与边界

- Hub：`npm run typecheck`、`npm test`、使用独立 `HUB_BUILD_DIR` 的 `next build`。
- Service：`npm run lint:typecheck`、身份/组织权限/迁移回归，以及 `test/hub-runtime-postgres.e2e-spec.ts`。
- 新测试 `tests/runtime-reliability.test.ts` 用真实 Coordinator/HTTP/规则引擎和模拟模型/存储故障验证双工作进程行为；不调用收费模型。
- 推荐在 Service 执行 `npm run test:hub-runtime-postgres`，使用已有 PostgreSQL 二进制自动创建、测试并停止独立的临时实例（不访问既有服务）。不在 PATH 时设置 `HUB_TEST_PG_BIN`。
- 直接运行 PostgreSQL Jest 测试时必须显式提供 `HUB_RELIABILITY_TEST_DATABASE_URL`，且只接受 `127.0.0.1` 上名为 `hub_reliability_test` 的一次性库；默认跳过。测试要求空的 `agent_service` schema 和可创建测试角色的管理员；只清理自己成功创建的 schema。
- 尚未进行真实云端 Workflow 投递或收费上游模型的线上冒烟。Workflow 投递失败仍保留已确认行动，可重试原请求，或由房主暂停后继续重新调度；没有引入额外消息队列/outbox。正在运行但没有已过期 attempt 的旧房间由房主显式暂停/继续处理。
- 最后一个数据库回执与进程崩溃之间存在外部系统无法消除的不确定窗口。本实现选择暂停确认，避免自动重复模型调用；不承诺上游模型调用的端到端 exactly-once 计费。

## 本次验证记录（2026-09-29）

- Hub 最终串行全量：62/62，通过；`npm run typecheck` 通过。
- Hub Next.js 16.3.5 生产构建通过（含 Workflow 编译）。使用独立输出目录；未覆盖用户的 `.next`，验证产物保留在 `/tmp/42-hub-verified-build-20260929`，构建自动添加的临时类型路径已清理。
- Service 类型检查及独立目录 TypeScript 构建通过，未覆盖正在使用的 `dist`。
- Service 身份、账号同步、组织权限、迁移相关回归：14/14，通过。
- 独立 PostgreSQL 实例：5/5，通过；包含真实并发 CAS、过期 owner 拒写、续租不复活、环境/RLS 权限以及迁移回退重放。测试实例已由测试脚本停止。
- 一次并行全量中，原有游戏进程集成测试超过 65 秒超时；单独重跑约 35 秒通过，最终串行全量也通过。没有调大测试超时来隐藏该次失败。
- PostgreSQL 权限测试额外模拟生产库自动给新表授予 runtime 全权限的默认设置；补充权限迁移后再次运行 5/5 通过。

## 本次生产部署记录（2026-09-29）

- 使用 Vercel CLI 61.0.0 上传当前工作目录源码，先构建 production 候选版本，再依次 promote Service、Hub。Hub 目录没有 Git 仓库，本次不是 Git push。没有覆盖或提交 Service 的其他既有改动。
- Service：`dpl_DdbvNqYjnY3vwDUWs2vti2dfbAGY`，Ready，NestJS，构建 36 秒、后处理 18 秒。正式地址 https://42-agent-service.vercel.app ，不可变部署 https://42-agent-service-2drsajtuw-42-club.vercel.app 。
- Hub：`dpl_CPL7gyfvQED4goSuSw5Nh8uh4Znv`，Ready，Next.js 16.3.5，构建 23 秒、后处理 20 秒。正式地址 https://42-agent-hub.vercel.app ，不可变部署 https://42-agent-jt2j6h6wv-42-club.vercel.app 。
- 两个项目 production 配置均已添加 `HUB_DEPLOYMENT_ENV=production`，其他配置保留。
- Supabase 已应用 `hub_runtime_safety`（远端版本 `20260929153149`）和 `hub_runtime_environment_readonly`（远端版本 `20260929153225`）。通过管理接口应用产生的远端版本与本地文件时间不同，应按名称和内容核对，避免重复应用。
- 生产库确认环境标签为 production、RLS 已开启，runtime 可 SELECT、不可 UPDATE/TRUNCATE；Supabase security advisors 返回零告警。
- 发布前只读检查没有 running 房间和有效执行租约，没有对既有房间做破坏性测试。
- 候选 Service 健康检查 200；使用合法服务凭据发送不可能提交业务数据的空请求体，确认缺少协议/开发环境写入均返回 403，正确生产协议通过环境检查后返回预期的参数校验 400。
- 发布后正式 Service `/api/v1/health` 返回 200，数据库 up；Hub 首页返回 200，浏览器显示登录入口，未登录 `/api/dashboard` 返回 401。正式域名已确认对应上述部署 ID。部署保护保持原配置。
- 两个新部署的近 15 分钟 error 日志扫描均为零条。仅代表该次扫描窗口；没有新增日志 Drains 或持续监控设施。
- 当前浏览器没有 Hub 登录会话，未执行登录后的专用房间云端 Workflow/真实上游模型冒烟。并发、慢模型暂停/结束、重复提交、组织权限及恢复行为的结论来自上述本地隔离测试，不能视为真实收费上游已验证。
- 旧版本回退定位：Service `dpl_FzpUm5pDHfGjDALMy8sazzim4V2a`，Hub `dpl_68zawvvWVy48mGgsVESn4zgze2pq`。旧版本不具备本次保护，不应直接单边回退；须遵循上方配套回退与排空要求。
