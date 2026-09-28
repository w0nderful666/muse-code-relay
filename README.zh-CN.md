[English](README.md)

# muse-code-relay

一个邀请码接力站，每一次抽取都由**可验证的公平加权随机算法**决定。没有人工指定，没有偏心，没有隐藏后门——下面的源代码就是全部证明。

任何人都可以领取邀请码、分享自己的码，并实时查看它的接力进度。运营者无法操纵谁领到什么：抽取查询对所有符合条件的码一视同仁，身份信息也从不明文离开数据库。

## 抽取是怎么工作的

一条原子 SQL 语句决定抽中哪个码，没有别的因素：

```sql
INSERT INTO claims (id, invite_id, actor_hash, receipt_hash, created_at, copied_at)
SELECT ?, i.id, ?, ?, ?, ? FROM invites i
WHERE i.platform = ?
  AND i.status = 'ACTIVE'          -- 被暂停或移除的码不参与抽取
  AND i.milestone_at IS NULL       -- 已达标的码不参与抽取
  AND i.copy_count < 30            -- 每个码到 30 次就停止流转
  AND i.claim_count < 60
  AND NOT EXISTS (                 -- 同一个码你永远只能领一次
    SELECT 1 FROM claims c WHERE c.invite_id = i.id AND c.actor_hash = ?)
ORDER BY (i.success_count - i.failure_count) * 0.05 + random()  -- 净好评只给轻微加成，其余完全均匀随机
LIMIT 1;
```

为什么说它是公平的：

- **所有码同一套规则。** 抽取路径里没有白名单、没有优先标记、没有管理员后门。运营者自己提交的码，走的也是这一条查询。
- **口碑只给轻微加成，不决定结果。** 每个净好评（可用 − 不可用）在均匀随机之上加 0.05 的权重——净 +2 的码大约 5 次赢 3 次，而不是次次赢。口碑是挣来的：只有真实领取者点击"复制"并反馈"可用"，`success_count` 才会涨，一次领取最多一票。
- **坏码自己出局。** 3 个不同领取者反馈"不可用"，码自动暂停（`ACTIVE` → `PAUSED`）。暂停可由管理员恢复，不删除数据。
- **原子操作。** 抽取、记账、计数都在单条语句和触发器里完成，并发抽取也不会把第 30 次重复计数。
- **匿名。** IP 先用服务端密钥做 HMAC 摘要再存，运营者只能看到统计数字，看不到人。

## 自己验证

```bash
npm install
npm test   # 7 个测试：分配、并发、配额、过期、反馈门禁
```

测试跑的是真实的生产 SQL（迁移 + 触发器），用内存数据库执行，包括第 30 次的并发争抢和三振自动暂停。

## 接力流程

1. **分享** — 提交 6 位邀请码（每网络每天 5 次）。
2. **领取** — 领走一个码（每网络每天 3 次）。领取即计数，手动复制也不会漏统计。
3. **确认与反馈** — 点击"复制"按钮，再反馈这个码是否可用。必须先点复制才能反馈。
4. **进度** — 只用邀请码就能查实时进度。到 30 次码退役，提交者拿到最终成绩单。

## 项目结构

```
src/index.js          Worker：API、抽取逻辑、限流
public/               静态前端（无需构建）
  index.html          主页面
  admin.html          管理后台（部署前改成随机文件名）
  admin.js / app.js   前端逻辑
migrations/           D1 表结构 + 触发器（0001–0005）
tests/                Node 测试套件，跑的是生产 SQL
wrangler.jsonc        Worker 配置（D1 id 故意留空占位）
```

## 自己部署

```bash
npx wrangler d1 create <db-name>
# 把 database id 填进 wrangler.jsonc
npx wrangler d1 migrations apply <db-name> --remote
npx wrangler secret put HASH_SECRET
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

先把 `public/admin.html` 改成随机长文件名——管理后台只靠令牌保护，加一层隐蔽更稳。可选：配置 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` 防机器人。

## License

MIT —— 随意使用，保留声明即可。
