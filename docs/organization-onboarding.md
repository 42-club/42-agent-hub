# 默认组织与 Hub 准入

用户完成邮箱验证后，共享账号服务在同一事务中创建默认组织、owner 成员关系和数据库准入记录，并选择该组织签发会话。每人最多一个自动创建的默认组织，Hub 暂不提供手动创建更多组织的入口。

Hub 每次请求从共享账号服务读取组织准入状态。组织切换、成员管理、邀请和业务请求同时检查组织准入与成员身份；缺失准入记录或旧版后端未返回准入字段时拒绝访问。旧的 `HUB_ACCESS_MODE` 和 `HUB_ALLOWED_ORGANIZATION_IDS` 已移除，不能再通过它们开放组织。

## 上线顺序

1. 在后端仓库按现有迁移流程执行 `supabase/migrations/20261104000000_default_organizations.sql`。它是增量迁移，不会自动放行已有组织。
2. 部署新版 `42-agent-service`。
3. 在后端仓库使用正确环境的运行账号预览存量导入与补建，再加 `--apply` 执行：

   ```powershell
   pnpm run hub:onboarding --allow "旧白名单UUID1,旧白名单UUID2" --backfill
   pnpm run hub:onboarding --allow "旧白名单UUID1,旧白名单UUID2" --backfill --apply
   ```

   将占位符替换为实际 UUID；没有旧名单时省略 `--allow`，只用 `--backfill`。工具不会自动执行数据库结构迁移。不存在的组织会导致整个操作失败；重复执行不会创建重复默认组织，也不会重新启用已停用组织。补建仅针对已验证且没有任何组织成员关系的账号，已有组织的账号保持原样。
4. 部署新版 Hub，删除部署平台上的旧策略变量。测试完整注册、邀请、切换组织与跨组织访问隔离。

数据库按项目原有环境隔离机制分别部署；准入记录属于所在数据库，不在开发和生产之间同步。

## 管理准入

准入表为 `agent_service.hub_organization_access`，主键为 `organizationId`。管理员可以在 SQL Editor 停用组织：

```sql
UPDATE agent_service.hub_organization_access
SET enabled = false
WHERE "organizationId" = '实际组织UUID';
```

启用已有记录时将 `enabled` 改为 `true`；新增准入使用后端导入命令。下一次 Hub 请求读取新状态，已开始的房间执行不会因该操作自动取消。默认组织只提供组织和访问资格，模型连接和 API Key 仍需按原流程配置。

回滚时保留新增表与默认组织数据，重新部署旧版本并恢复原环境变量白名单。旧版本不会自动开放新组织；回滚前应明确需继续准入的组织范围。不要在已有新数据后直接回滚结构迁移。
