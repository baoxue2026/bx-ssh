# 一期验收进展（2026-09-08）

一期功能实现已进入 M6 联调与验收阶段，尚未达到 M7 RC 发布条件。状态源为
`quality/phase-1-acceptance-status.json`；本文件记录本轮修复、复现步骤和剩余证据。

## 已完成的修复

- 修复 npm 审计发现的 nanoid、deepmerge-ts 和 extract-zip 依赖路径；验证实际
  WebdriverIO 导入和能力合并行为。审计结果为无已知漏洞。
- 重新核对 RustSec 与上游版本，将仍无兼容修复的原有例外限定到 2026-09-22。
  npm 许可证例外同时受到期门禁约束；`pnpm check` 现在也执行例外与许可证检查。
- E2E 使用独立的应用标识、数据库密钥、密码和私钥凭据命名空间；误用正式应用
  配置的 E2E 二进制会拒绝启动。测试会清理自己创建的连接记录。
- 增加真实 OpenSSH 的桌面流程：保存连接、核对指纹、错误密码重试、终端命令
  回显、单文件 SHA-256、同名目标冲突，以及包含空目录的递归传输。
- SFTP 采用最多 32 个在途读取请求，按偏移顺序写入同一临时文件，正确处理短读、
  EOF、异常响应和取消。本地写入使用 1 MiB 缓冲，保留刷盘、复核和原子发布。
  服务端仅允许一个 subsystem 时自动使用原来的顺序读取路径。
- Windows OpenSSH 测试默认使用 Release，支持明确的功能测试和 1 GiB 性能测试。
  基线与产品使用同一个文件并核对 SHA-256，分别记录上传和下载，不再用较慢
  方向替代两个方向。失败也保存 JSON、阶段耗时及对比数据。
- 删除无法构建的 `sftp-read-pipeline-experiment` 参数；修复十会话测试触发服务端
  默认 MaxStartups 随机拒绝的问题；恢复测试修改的环境变量并清理临时用户和服务。
- CI 覆盖开发分支，Windows 矩阵增加 SFTP、取消、十会话及单通道兼容测试；
  Windows 桌面矩阵增加真实 SSH 流程。Linux 容器矩阵也实际执行十会话测试。
- 修正 OpenSSH/PAM 合法空提示轮次的测试断言，同时要求实际出现凭据提示；Linux
  桌面 CI 启动隔离的 Secret Service，并在启动应用前验证凭据写入、读取和删除。
- 清理脱敏测试中的 PEM 头占位符；Gitleaks 只豁免原始提交中的该处历史误报，
  完整历史扫描继续执行并归档脱敏报告。没有私钥正文进入该测试。
- 修复 PR 制品名包含斜杠而无法上传的问题；安装验证正确传递含空格的 MSI 路径，
  超时会终止所启动的进程树。NSIS 卸载等待子进程实际删除文件，MSI 日志保留在
  报告目录；检测到已有安装时拒绝运行，避免影响日常安装。

## 本地验证与性能边界

`pnpm check` 已通过：160 项前端测试、166 项 Rust 测试，以及额外的 IPC 生成检查。
原有 9 项桌面 E2E 与新增 3 项真实 SSH 桌面测试已通过；Windows Release 的
SSH/SFTP、取消清理及单 subsystem 回退测试已通过。
Windows 安装脚本还通过参数边界、非零退出码、真实超时和子进程清理回归；本机
0.1.0 MSI/NSIS 的安装与卸载均通过，未要求 Authenticode，也未验证跨版本升级。

首轮云端 CI（`34221851911`）中三平台 Rust、前端、QA、Windows 三种 SSH 算法、
四档缩放及 macOS 桌面 E2E 已通过。Linux 的两类环境/断言问题已修正，待新一轮
矩阵验证。首轮 Security 的依赖、许可证、SBOM 均通过，历史误报修正后本地
完整 111 个提交扫描通过；Package 的构建及更新签名反例验证通过，制品上传
命名和 Windows 安装进程等待问题已修复，仍须以新提交的完整云端结果为准。

本机是 Windows 10 19045，系统盘为 SATA SSD，不符合性能预算指定的 Windows 11
24H2、4 核/16 GiB/NVMe 参考环境。本地 1 GiB 实测如下，单位为十进制 MB/s：

| 路径             | 上传 | 下载 | OpenSSH 下载基线 | 下载达标比例 |
| ---------------- | ---: | ---: | ---------------: | -----------: |
| 原来的顺序读取   | 32.4 | 34.6 |            139.5 |          24% |
| 预读与合并写入   | 31.3 | 75.7 |            154.5 |          48% |
| 最终干净提交复验 | 31.5 | 98.1 |            160.1 |          61% |

最终复验源提交为 `500ccee42920d79877a8c8033e4fc48860abbf76`，工作区干净。
分段测量显示，传完数据约 5.6 秒，完成持久化约 10.9 秒，连同本地 SHA-256
复核与发布约 15.6 秒。针对传输依赖的编译优化没有改善结果，未保留该改动。
以上说明读取瓶颈已改善，但**包含持久化的原有 80% 门槛仍未通过**；未改用
只计网络传输的口径、减少文件大小或去掉校验来宣称性能达标。

原始本地证据保存在忽略的 `artifacts/test-reports/` 下。JSON 中记录源提交、工作区
是否有未提交改动、构建 profile、文件大小、哈希、双向基线、实测速率与阶段耗时。
这些本地记录不能替代针对发布提交归档的 CI、参考设备或签名证据。

## 复现

以下 Windows OpenSSH 命令需要提升权限，以创建并清理仅监听 127.0.0.1 的临时服务和账号。

```powershell
# 常规代码与安全门禁
pnpm check
pnpm audit --registry=https://registry.npmjs.org --audit-level high
cargo deny check advisories licenses sources
pwsh scripts/test-windows-process.ps1

# Release 功能验证，明确不作为性能验收
pwsh scripts/test-openssh-windows.ps1 -MatrixId local-functional -IncludeSftp -SkipSftpBenchmark -IncludeTenSessions
pwsh scripts/test-openssh-windows.ps1 -MatrixId local-single-subsystem -IncludeSftp -SkipSftpBenchmark -MaxSessionsPerConnection 1

# 使用新测量的双向 OpenSSH 基线，严格执行 1 GiB 与 80% 门槛
pwsh scripts/test-openssh-windows.ps1 -MatrixId local-release-1g -IncludeSftp -RequireOneGiB

# 独立 E2E 程序与真实 SSH 服务器
pnpm --filter @bx-ssh/desktop build:e2e
pnpm test:e2e
pwsh scripts/test-openssh-windows.ps1 -MatrixId local-real-ssh -IncludeDesktopE2e
```

原有 `SftpBaselineBps` 只用于非正式诊断。`RequireOneGiB` 拒绝 Debug、外部提供的
单一基线及跳过基准模式；不允许通过继承的环境变量降低验收比例。

## 剩余工作

1. 在当前发布候选提交上取得完整 GitHub CI、Security 和 Package 结果。
2. 在 Windows 11 24H2 参考设备上复验 1 GiB 的 80% 门槛、启动、十会话内存、
   标签切换和连续 5 分钟终端输出；完成 24 小时真实应用 soak。此前短时 pwsh
   采集结果只是采集器自检。
3. 完成 IME、系统代理、高 DPI、托盘、休眠唤醒、断网恢复，以及安装升级的实机验收。
4. 配置独立 PR 审批者与 main 保护，再完成正式签名环境，见
   `quality/phase-1-release-setup.md`。GitHub 实查：main 未保护，无协作者、release
   环境或 repository/environment secrets。不能生成已签名 RC 通过报告。
5. 按验证后的事实更新六项 blocking 状态。全部通过后才能创建签名、annotated、
   immutable RC 标签并发布；大型 App.tsx 的拆分留在验收稳定后的独立改动中。
