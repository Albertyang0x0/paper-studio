# 运行工具

在项目根目录执行：

- `npm run test:ui`：通过 `test-ui.mjs` 启动隔离的测试服务，运行 `tests/browser/`，结束后清理本次临时数据。可用 `node scripts/test-ui.mjs --help` 查看环境设置。
- `python scripts/inspect-pdf-preview.py --help`：检查已保存论文的预览并截图。需要提供论文 URL 和截图保存路径，不调用模型或改写论文正文。
- `npm run package:source -- --help`：检查并打包供 GitHub 协作的源码；排除本地凭据、研究材料、私人验收记录和未获许可的参考图。`--stage` 还生成干净源码目录，同名目标不覆盖。

不再维护的单次模型验收和修订脚本保存在 `archives/development-scripts/`。原工作区的 `iterate-visual.ts` 绑定私人研究材料，作为本地付费校准脚本保留，不进入源码包，不由以上工具自动执行。
