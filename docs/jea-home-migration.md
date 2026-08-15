# JEA Home 迁移指南

更新日期：2026-08-15

## 根目录契约

JEA 使用三个互不替代的根目录：

- **Source root**：源码、项目 `.env`、`policies/authority/`、`oada.config.mjs` 和 Desktop 构建产物；由 `JEA_PROJECT_ROOT` 定位。
- **JEA Home**：设备级 Subject registry、治理文件、运行数据、备份和 daemon 日志；默认 Linux/macOS 为 `~/.jea`，Windows 为 `%USERPROFILE%\.jea`，可由 `JEA_HOME` 覆盖。
- **Execution root**：Subject lane、repo 或 worktree；继续由 registry 的 `lane` / `resources` 和 action run spec 决定。

Subject 仍是唯一业务与数据边界，磁盘归属仍使用 `data_namespace`；迁移不会增加 Project、Workspace 或 `project_id`。

```text
<JEA_HOME>/
├── subjects/
│   ├── registry.json
│   └── <data_namespace>/
│       ├── SUBJECT.md
│       ├── SOUL.md
│       └── data/
├── backups/subjects/
└── logs/
```

## 迁移前

1. 备份或确认旧 `<sourceRoot>/runtime/subjects/` 可作为回退来源。
2. 停止 cycle 和 Channel daemon：

   ```bash
   jea daemon stop --all
   ```

3. 等待 worker PID、heartbeat 和运行锁退出。
4. 预演：

   ```bash
   jea data migrate-home --dry-run --json
   ```

如果只存在旧数据，其他运行/写命令会以 `migration_required` 失败；这是为了避免在新旧位置同时产生权威状态。

## 执行迁移

```bash
jea data migrate-home --yes --json
```

迁移过程会：

1. 检查 cycle/Channel worker、evolve lock 和队列锁；
2. 遍历 registry、SUBJECT/SOUL、隐藏文件及全部 `data/**`；
3. 拒绝 symlink、特殊文件和无效 JSON；
4. 生成逐文件 SHA-256、文件数和字节数清单；
5. 复制到 JEA Home 同文件系统的 staging 目录；
6. 激活前再次核对旧目录未变化；
7. 用原子 rename 启用 `<JEA_HOME>/subjects` 并写完成 manifest。

旧目录不会被移动、合并或删除。重复执行时，内容与 manifest 一致会返回 `already_migrated`；人工预复制且逐字节一致时只建立完成标记。

## 冲突与恢复

- 旧目录非空、JEA Home 为空：运行 `data migrate-home`。
- 新旧均非空但没有有效完成标记：`dual_authority_conflict`，JEA 不猜测权威来源，也不自动 merge/overwrite。
- 迁移期间源发生变化：`migration_source_changed`，staging 会清理，修复写入来源后重试。
- daemon、worker 或锁仍活跃：`migration_writers_active`，停止进程后重试。
- 遗留 staging：先人工检查提示的目录；确认没有需恢复的内容后移走，再重试。
- 迁移后旧目录又变化：`jea doctor` 报告双写风险；检查旧进程是否仍在运行。

需要临时继续使用旧布局时，显式设置：

```bash
JEA_HOME=<sourceRoot>/runtime jea doctor
```

这会进入 `legacy_compat`；它不是双写模式，也不会自动迁移。

## 验收

```bash
jea doctor
jea subject show --subject <name> --json
jea data status --subject <name> --json
jea run --mock --subject <name>
jea channel status --subject <name> --json
```

确认：

- `source_root` 指向源码 checkout；
- `jea_home` 指向设备级目录；
- `subject_runtime_root` 位于 `<JEA_HOME>/subjects/<data_namespace>`；
- `execution_root` 仍指向 lane/repo/worktree；
- queue、checkpoint、Channel 会话、审批与演化记录连续；
- source checkout 没有新增 `runtime/` 写入。

`jea doctor` 还会检查 `.env`、API key 和其他环境项，因此缺少真实模型配置时仍可能以警告状态退出；这与 JEA Home 迁移结果无关。

## 回退

1. 停止所有 daemon。
2. 保存当前 JEA Home，避免丢失迁移后产生的新状态。
3. 显式设置 `JEA_HOME=<sourceRoot>/runtime` 使用保留的旧目录。
4. 运行 `jea doctor`、`subject show` 和 mock cycle 验证。

不要在 daemon 运行时复制两侧，也不要直接合并两个非空树。确认长期稳定后，旧目录是否删除由操作者人工决定。
