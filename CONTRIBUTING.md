# 合作开发

## 本地运行

使用 Node.js 24.14 或更高版本；当前回归基线为 Node.js 24 / Windows。

```sh
npm ci
npm run build
npm start
```

打开 http://localhost:8787/，在“API 设置”中添加自己的连接。默认端口只监听本机；代码协作不等于多人同时编辑同一个在线项目，本版没有共享服务器的用户认证或实时协作权限。

## 模块分工

| 范围 | 主要目录 / 接口 |
| --- | --- |
| 写作与论文模块方法 | `server/paper/adapters.ts`、`shared/paper-methods.ts` |
| 图表与矢量重建 | `server/visual/`、`server/paper/figures.ts`、`shared/visual-contract.ts` |
| 工作台与画板界面 | `src/paper/`、`src/figure/` |
| API 连接 | `src/settings/`、`server/provider-*.ts`、`server/providers/` |
| 项目格式与候选事务 | `shared/paper-types.ts`、`shared/paper-project.ts` |

新增方法要注册唯一 ID、版本、适用模块和真正的执行函数，不是只添加下拉框标签。使用平台提供的模型调用函数，沿用用户选择的连接；返回目标模块候选，不直接写入主稿。完整示例见 [模块接口](docs/MODULE_CONTRACT.md)。

修改共享接口前先通过 Issue 或 PR 明确字段和兼容行为。不要改已有方法 ID 来冒充新的比较实验；新方法使用新 ID / 版本，保留旧候选的来源。

## 分支与提交

从主分支创建功能分支，例如 `feat/intro-method` 或 `feat/figure-layout`。每个 PR 尽量限定一个模块，描述变更、验证命令以及是否修改共享协议。不填写未经验证的质量提升结论。

提交前运行：

```sh
npm test
npm run build
npm run package:source -- --check
```

GitHub Actions 对 push 和 pull request 运行以上检查；不配置生产 API key，不调用付费模型。网页测试另需 Python、Playwright；PDF 预览测试还需本机 `pdflatex`。见 [README](README.md)。

## 不要提交的内容

- `.env.local`、`.local/`、账号 token、代理密码和其他凭据。
- `outputs/`、`archives/`、真实论文输入、实验日志、生成图 / PDF、用量账单和私有验收记录。
- `node_modules/`、`dist/`、本地测试截图、缓存和发布 ZIP。
- 尚未获转载许可的论文参考图。

需要协作某篇真实论文时，经参与者确认后单独交接项目 JSON / 论文源文件 ZIP；项目 JSON 可以包含研究材料，不能因它不含 API key 就当作公开数据。

`vendor/paper-orchestra/` 中保留的上游文件、许可证和来源记录不能删掉。自有代码尚未指定对外开源许可证，不要把上游 Apache-2.0 自动解释为整个项目的许可证。
