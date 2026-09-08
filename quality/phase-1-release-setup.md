# 一期 RC 环境准备

2026-09-08 通过 GitHub API 核对：main 返回 `Branch not protected`；仓库只有所有者
一位管理员；尚无 GitHub environment 或 repository secrets。现有发布 workflow 已
定义门禁，但配置与真实签名验收尚未完成。

开发提交 `4de6662` 的 CI、Security 和三平台 Package 已全部通过，Windows
0.1.1 MSI/NSIS 安装与卸载也通过；可复核的 run 链接见
`quality/phase-1-acceptance-progress.md`。这些原型包未要求正式 Authenticode 签名，
跨版本升级与用户数据保留尚未验证。

## main 分支保护

可审阅的 REST 请求内容位于 `quality/phase-1-main-branch-protection.json`。该配置
要求 Release gate、依赖安全、SBOM、Windows 包检查通过，至少 1 人审批，更新提交
后撤销旧审批，限制管理员、强推、分支删除，并要求线性历史和解决讨论。

先确定并添加可独立审批的协作者。GitHub 不允许作者审批自己的 PR；直接对当前
单人仓库启用上述管理员限制将阻止所有者独自合并。协作者就绪后由维护者应用配置，
通过 API 导出实际响应并验证：

```powershell
node scripts/check-main-branch-protection.mjs --input artifacts/test-reports/main-branch-protection.json
```

请求模板本身不是已经开启保护的证据，也不能作为该命令的响应输入。

## release 环境与密钥

创建 GitHub `release` environment，配置部署审批和允许的 main/版本标签规则。
依照 `.github/workflows/release.yml` 将以下值直接存入 GitHub Secrets 或受控离线
发布机，不通过聊天、仓库、日志或 CI artifacts 传递私钥：

| Secret                                  | 用途                                                         |
| --------------------------------------- | ------------------------------------------------------------ |
| `BRANCH_PROTECTION_TOKEN`               | 只读访问本仓库分支保护状态所需的 API 权限                    |
| `WINDOWS_CODESIGN_CERTIFICATE_BASE64`   | 正式 Authenticode PFX 证书；需持有代码签名用途               |
| `WINDOWS_CODESIGN_CERTIFICATE_PASSWORD` | PFX 口令                                                     |
| `TAURI_SIGNING_PRIVATE_KEY`             | 与应用中 updater 公钥配套的正式 Tauri 签名密钥               |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`    | Tauri 密钥口令                                               |
| `RELEASE_TAG_SIGNING_PUBLIC_KEY`        | 用于核验 annotated release tag 的 GPG 公钥                   |
| `RELEASE_METADATA_JSON`                 | 完成各套件后生成的真实验收元数据，亦可通过 workflow 输入提供 |

Windows 证书需由维护者提供有效的正式证书；自签名测试证书不满足发布条件。
Tauri 公钥必须与正式私钥匹配，换钥时通过代码审查更新应用配置并验证错误密钥与
篡改拒绝行为。签 tag 的私钥保留在维护者离线设备，环境仅保存核验公钥。

## 发布前仍需取得的证据

- 最终 RC 提交的全平台检查与发布证据复核，以及上一版本升级和用户数据保留结果。
- Windows 11 24H2 的性能、人工兼容、断网恢复和 24 小时稳定性原始记录。
- 正式 Windows 安装包签名与时间戳、Tauri updater 签名、篡改和降级拒绝报告。
- 针对同一版本/提交生成的 SBOM、符号、SHA-256、发布 manifest 和缺陷处置记录。

本次准备不创建 RC 标签或发布。所有 blocking 套件与外部证据到齐后，再依照
`quality/phase-1-release-gate.json` 执行发布工作流。
