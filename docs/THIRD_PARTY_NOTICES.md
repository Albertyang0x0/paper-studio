# Sources and dependencies

绘图模块初次重建没有复制第三方代码或 prompt。论文工作台新增了选择性 PaperOrchestra 复用：`vendor/paper-orchestra/` 中保留四个原始 prompt 文件、共享知识隔离 prompt、Apache-2.0 许可证和固定提交的来源记录；由 `server/paper/adapters.ts` 进行独立模块协议适配，不执行上游 Python 应用。不包含其演示界面、完整系统、数据集或模型权重。具体改动边界见 `vendor/paper-orchestra/PROVENANCE.md`。

其他来源用于研究与设计启发，不表示已经集成其代码：

- Google Research PaperOrchestra: https://github.com/google-research/paper-orchestra/blob/main/utils/paper_banana_utils.py
- FigTree: https://github.com/yepengliu/FigTree ; https://arxiv.org/html/2609.01006v1
- AutoFigure-Edit: https://github.com/ResearAI/AutoFigure-Edit
- OpenRouter API / reasoning controls: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens

直接运行依赖由 `package.json` / lockfile 记录；包含 Fabric.js、React、Express、resvg、Lucide 等，许可证以各包附带文件为准。

`shared/assets.ts` 是本项目自己绘制的基础矢量符号，不复制论文参考图中的插画。原工作区 `public/references/` 的三张图片由用户提供，未确认转载许可，源码交接包已排除，Git 默认忽略；原图片仍在本机，不作为公开产品 / 数据集资产发布。用户可以自行上传有权使用的视觉参考。

`examples/demo/` 的 idea、experiment 和 article / style 文件是专门编写的合成示例与测试夹具，不复制用户原论文或 NeurIPS 模板，不包含真实科研结果。

自有代码尚未选择对外开源许可证。保留的 Apache-2.0 许可证及上游版权信息仅说明所复用的 PaperOrchestra 文件来源与许可范围。

旧版代码归档在工作区 `_archive/figure-studio-v04-20261002`；新实现不依赖该归档。
