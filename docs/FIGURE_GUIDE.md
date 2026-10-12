# Paper Studio · 绘图模块说明

独立、可组合的论文写作工作台：Idea spark / 材料 → 分模块候选 → 人工确认 → 可编辑主稿。每个模块可以选择自己的方法和模型，局部替换不重写其他章节。选择性复用 PaperOrchestra 的规划、写作和修订提示词，现有原生矢量画板作为绘图模块接入；不使用其演示界面或全仓库程序。

安装依赖后运行 `npm run build`、`npm start`，打开 http://localhost:8787/ 。完整安装与使用手册见 [README.md](../README.md)，操作概要见 [WORKBENCH.md](WORKBENCH.md)，合作开发接口见 [MODULE_CONTRACT.md](MODULE_CONTRACT.md)。

这是第一版模块化底座，不是已经找到各章最优方法的系统。支持 Markdown / 公式 / 表格、真实引用检索适配、候选差异与确认、锁定/历史/依赖提示、JSON 交接、全文预览和英文 PDF。没有实验时明确留下证据 TODO；当前检索服务可能限流，生成内容和图形质量都需人工审核。尚无实时多人协作。

## 绘图模块

绘图是论文工作台的一部分，也可独立使用。当前默认流程先根据材料生成视觉方案，再重建可编辑对象；旧的自由矢量设计流程仍可选择。本文介绍画板操作，不替代论文候选、模板预览与导出的说明。

生成质量随材料、模型、构图和修订轮数变化。应分别检查图片提案与实际矢量重建的科学关系、文字、连线和印刷可读性；流程完成或模型审查通过都不保证达到投稿标准。历史私人质量验收不随源码包发布。

## 使用

```powershell
npm ci
npm run build
npm start
```

独立画板打开 http://localhost:8787/figure 。也可从论文工作台“图表与画板”进入，编辑后提交到论文。通过工作台“API 设置”或画板工具栏的钥匙图标管理连接。在“方法与模型”中，各文本阶段与图片设计可选择不同连接和模型。原有 `.env.local` OpenRouter 配置继续兼容；key 不写入图表项目。详见 [API 连接说明](API_CONNECTIONS.md)。

1. 在“材料”导入自己的 Markdown / TXT / JSON / CSV，或载入合成演示材料。从论文内嵌画板进入时，项目材料自动传入，无需重新上传。
2. 点击顶部“生成图表”，在“图形与参考”中选择图类型、填写要求并选择 0–3 张参考图。参考图只用于构图与视觉语言。
3. 在同一窗口的“方法与模型”中选择生成流程、图片连接/模型、各文本阶段连接/模型和审查轮数。图片模型负责视觉提案，文本/视觉模型拆解并创建原生对象。代码提供的模型 ID 是预设，不保证供应商或账户当前可用；使用所选接口的真实模型名。视觉审查需要能读图的模型，图片生成需要能输出图片的模型。
4. 在设置窗口中点击“开始生成”或“重新生成整图”才会执行；打开窗口、调整配置或关闭窗口不会调用生成模型。模块真实并行生成；阶段和错误显示在可收起的“运行记录”。生成可能需要数分钟，并产生 API 费用。模块失败时可以“继续未完成模块”，保留已经生成的部分和模型草稿；规划失败时可从已保存规划继续。材料或图意发生变化则必须重新规划。刷新页面会重新连接仍在运行的任务；已结束任务保存在服务器检查点中。
5. 单击模块可整体移动/缩放；双击进入内部编辑。文字可双击修改，形状和路径可拖动/缩放；右侧可改文本、字号、颜色、位置与大小。“图层”可以准确选择小对象。删除模块会同时删除其跨模块连接，可以撤销；包含锁定对象的模块不能直接删除。
   放大后，点击画布再按方向键 ↑ ↓ ← → 可移动视角；按住 Shift 加速。可持续按住方向键，点击右下角“适应画板”恢复全图。平移只改变查看位置，不修改对象坐标；文字编辑及输入框内的方向键保持原有用途。
   手动整理图层时，点击“框选图层”，按住鼠标拖出矩形，完整落入矩形的当前层级对象会显示在选区清单中。点击清单对象可在画布高亮定位，“移出选区”只取消选中，不会删除对象。确认至少两个对象后，点击“组合所选图层”；随后可整体拖动、拖动角点等比缩放，或在属性栏“取消组合”。拆分保留当前位置和大小，组合关系随 JSON 保存，并支持撤销/重做。整图状态组合模块与独立标注，进入模块后组合其直接子对象；锁定对象不参与框选，SVG 原生裁剪和透明分组保持完整。
6. 可锁定对象，或锁定整个模块。选择模块后，在右侧属性栏展开“重新生成此模块”，填写修改要求并“重生成选中模块”，其他模块、布局与连接关系不变。
7. 箭头可选择修改文字、起终点、颜色和转折点；背景分区和标题也是可编辑对象。撤销 Ctrl+Z，重做 Ctrl+Shift+Z。
8. 导出 SVG、完整 JSON 项目或 PNG。JSON 能通过“打开项目”继续编辑；“导入 SVG”直接解析受支持的 SVG 图形为原生对象，无需模型或 API。SVG 导出保留真实文字/路径及项目元数据；导入时以实际图形为准，不依赖元数据。PNG 仅是预览。
9. 点击顶部“关闭项目”，选择“直接关闭”或“导出 JSON 并关闭”。关闭会清空当前画板、材料和撤销记录；刷新后保持空白，不会自动打开最近的历史图。服务器历史和论文中已提交的图表会保留。导入或生成期间需先等待完成或停止任务，才能关闭。

## 直接导入 SVG

点击顶部“导入 SVG”，或空画板中的“导入 SVG 开始编辑”，选择不超过 5 MiB 的文件。基础矩形、圆/椭圆、直线、折线、多边形、路径、文字、分组、常规变换、线性填充渐变和部分箭头标记会转换为现有 JSON 对象。双击模块或从图层选择对象后，可编辑文字、颜色、位置、大小；随后“导出 → JSON 可编辑项目”，即可保存并重新打开。此过程在浏览器中执行，不调用模型。

科研绘图软件常见的 SVG 1.0/1.1 标准 `PUBLIC/SYSTEM` 文件头和简单 `DOCTYPE` 可导入；文件头被移除，不会获取 DTD 或解析其中实体。支持 `pt/mm/cm/in/pc` 等物理单位，类、ID、后代、子元素及简单属性 CSS 选择器，`font` 简写、字体候选列表与 `!important` 优先级。文字中的 `dx/dy` 按当前字号处理 `em`，保留字间距；单行单对象 `textLength` 可转换为字间距或横向字形缩放。缺少字体时仍会使用浏览器替代字体。

Inkscape 的 `shape-inside` 文字仅在文件已有明确定位的 `tspan` 回退时导入，不重新排版流式文本；`line-height` 不用于重新计算这些坐标。填充/描边 `paint-order` 保存为对象属性；受支持的 `marker-start/mid/end` 展开为箭头形状。悬停 `<set>` 的样式切换按默认静态外观导入并显示警告，交互高亮不保留。

本地 `symbol/use` 引用会展开为独立对象，保留分组透明度及 `userSpaceOnUse` 单形状裁剪。内嵌 PNG/JPEG 按内容去重写入 JSON 的 `assets`，实例可分别移动、缩放和旋转。矩形上的整幅单图片 `pattern` 转换为图片与裁剪。支持样本中的偏移着色阴影和扩边扣除阴影；效果存于 JSON 的 `svgShadow`，导出 SVG 仍保留滤镜。画板仅为该局部效果生成显示缓存，原始对象仍保留。链接转换为普通分组，编辑器辅助信息忽略。

SVG 只引用了相对图片路径而未嵌入内容时，导入器不会读取相邻文件或发起请求，会在原位置生成带叉号的占位框并在警告中列出缺失路径。提供资源、在源软件中嵌入 PNG/JPEG 后再导入，才能恢复图片。若原图依赖网页上的 CSS，而保存的 SVG 里只有 class 名称，也无法从名称推回网页样式。此类不完整文件不能视为原网页视觉效果的完整副本。

图片内部像素不会自动转换为文字或路径；已转曲文字也只能作为路径编辑。蒙版、任意滤镜、重复平铺图案、径向渐变、网络资源、没有已定位回退的流式文字，以及带描边的倾斜等变换仍会明确报错。内部实体、未知 DTD、脚本、事件代码和外部样式表会拒绝。整次导入失败时当前画板项目保留。普通路径箭头保留原形；符合端点、形状与图层约束的模块间箭头才转换为可跟随模块移动的连接线。JSON 新增可选图片资源、图片对象、裁剪、阴影、字间距和绘制顺序字段，旧项目仍可打开。SVG 视觉重建 pipeline 不在这个导入流程中；材料生成图表仍使用原有生成流程。完整范围与格式依据见 [科研 SVG 兼容矩阵](SVG_COMPATIBILITY.md)。

浏览器自动保存当前项目；服务器也保存每次成功生成到 `outputs/runs/<run-id>/`。新浏览器首次打开会载入服务器最近一次成功结果；主动关闭过项目的浏览器会保持空白，可重新打开 JSON、导入 SVG 或生成新图。

画板页以画布为中心：已有图默认显示左侧图层，材料可切换查看；右侧属性栏默认固定展开，切换对象、取消选择或打开图表只更新内容，不会自动开关或挤动画布。可用顶部“属性”按钮或栏内关闭按钮手动收起、展开。嵌入论文时，顶部只保留论文视图导航和一排绘图工具；“章节编辑”可返回主稿，“提交到论文”会提交图表候选，不会直接覆盖已接受的图。

## 新底层与边界

当前默认：科学内容分析 → 三张 AI 视觉提案 → 拆解选定方案 → 并行生成原生节点与插画 → 组装 → 实际渲染对照 → 定点修订。详见 [视觉重建说明](visual-reconstruction.md)。原来的自由矢量设计流程仍可在生成窗口选择。

在“生成图表”中选择“AI 视觉方案 → 保真矢量重建”，图类型选择“方法总览图”，导入材料并说明图意。“视觉方案”按钮显示选定的位图提案，点击“返回矢量图”回到可编辑对象；两者不会混为同一张可编辑图。可以从右侧改渐变、连接线宽和曲线控制点。独立实测的 `project.json` 可以通过画板“打开”导入，而不是作为论文项目 JSON 导入。

- 模块边界、局部坐标、命名端口、共享风格形成约定；父级拥有跨模块连接。
- 图不是一张位图包在 SVG 中：原生文字、路径、形状、分组组成同一份对象文档，画板与 SVG 使用同一个数据源。
- 子模型可自由画几何图形；小型可复用矢量符号（数据库/张量/文档等）是素材，不是整图模板。
- 渲染器实际测量字体和路径范围，用真实字体度量换行；轻微整体越界可等比适配（不裁切、不改内容），严重越界要求重新设计。模块内文字碰撞会反馈实际渲染给生成模型，最多修订一次；仍存在的问题继续标记，不假装自动修好。审查包含父级缩放后的实际印刷字号。
- 审查器看真实渲染与源材料，报告具体对象问题，不输出凭空的“顶会质量分”。AI 审查不保证达到发表标准。
- 这一版三种绘图方法是我们自主实现的生成策略，**没有接入 FigTree、AutoFigure-Edit 或 PaperOrchestra 的绘图代码/模型权重**。没有宣称原创其已有思路。论文工作台另有选择性 prompt 复用与文献检索适配，见上方说明；SVG 导入限于上面列出的子集，自由路径节点编辑、原生 PPTX 导出、递归任意深度分解仍未实现。
- 统计模块只能画材料里的真实数据或明确标注的示意；当前没有通用数据表编辑器/统计分析后端。

## 验证

```powershell
npm run check
npm test
npm run build
```

当前网页回归入口是 `npm run test:ui`，使用安装了 Playwright 的 Python；Windows 优先已安装 Edge，其他情况使用 Playwright Chromium。测试数据放在本次运行专属临时目录。归档脚本不作为当前运行入口，也不随公开源码发布。测试不替代对论文图科学正确性的人工检查。

SVG 导入可单独运行 `npm run test:ui -- --svg-only`。该套件使用 Node Playwright；若不在项目依赖中，用 `PAPER_TEST_NODE_MODULES` 指向已安装 Playwright 的 `node_modules` 目录。先运行 `npm run build`；测试使用隔离的 8788 服务，覆盖导入、文字/颜色/位置编辑、JSON 往返、原图像素对照和失败保留项目，并验证导入编辑期间没有 API 或外部网络请求。

`npm run test:ui -- --svg-compat-only` 自动遍历 `SVG_TO_JSON_TEST` 顶层的所有 `.svg`。仓库只保留 6 张 diagram：LSTM、GRU、两张反卷积连接图、NicheNet 决策图，以及已知因 `spreadMethod=reflect` 被拒绝的 NicheNet 工作流图；来源清单见 [SVG_SAMPLE_SOURCES.json](SVG_SAMPLE_SOURCES.json)。根据这些文件此前的实测结果，当前精选集应为 **5/6 通过**，完整运行会因保留的失败样本返回非零退出码；该失败不会被计作通过。输出每个样本的 JSON、SVG、原图/导出图/差异 PNG 及 `test-artifacts/svg-compatibility/report.json`。默认完整运行还覆盖图片去重、JSON 往返、对象编辑、透明分组、裁剪，以及关闭项目后迟到的图片加载不会恢复画板。原样本只读，不会为了通过测试而改写文件。

精简前的完整样本目录备份在本机 `D:\Projects\SVG_Sample\SVG_TO_JSON_TEST`，不随仓库上传。历史 20 张编号样本及 8 张论文语料的测试记录仍可查看原 `test-artifacts` 产物；这些历史通过数量不代表当前仓库保留的文件数。

`npm run test:ui -- --svg-scientific-only` 使用有明确预期的科研格式合成夹具，不依赖外部样本目录。它检查标准 DTD、物理单位、CSS 继承与优先级、字体简写、字间距/`textLength`、定位文字、绘制顺序、中间箭头、静态悬停和缺图占位，并检查危险输入失败后原项目保留。报告写入 `test-artifacts/svg-scientific/report.json`。缺图夹具对照的是明确声明的占位效果，不把它计为恢复了缺失图片。

可用 `PAPER_TEST_SVG_COMPAT_FILES` 选择编号、完整文件名或不带扩展名的文件名，以逗号或空格分隔；`PAPER_TEST_SVG_CORPUS_DIR` 则将本次兼容测试来源替换为指定目录顶层的所有 `.svg`，不下载资源。例如：

```powershell
$env:PAPER_TEST_SVG_COMPAT_FILES = "ml01_rnn_lstm,ml02_rnn_gru,ml04_deconv_uneven,ml05_deconv_even,nichenet_input_decision_tree"
npm run test:ui -- --svg-compat-only
Remove-Item Env:PAPER_TEST_SVG_COMPAT_FILES

$env:PAPER_TEST_SVG_CORPUS_DIR = "D:\Projects\SVG_Sample\SVG_TO_JSON_TEST\PAPER_CORPUS_20261012"
npm run test:ui -- --svg-compat-only
Remove-Item Env:PAPER_TEST_SVG_CORPUS_DIR
```

筛选文件或指定外部目录时，额外合成兼容用例默认不运行；可单独运行 `--svg-scientific-only`，或用 `PAPER_TEST_SVG_COMPAT_SYNTHETIC=1` 启用兼容套件的额外用例。论文来源及逐项边界见 [兼容矩阵与回归说明](SVG_COMPATIBILITY.md)。测试结果以本次生成的报告为准，这些命令说明不代表全部用例已经通过。

画布与 SVG 的边缘抗锯齿、缓存采样可能略有差别；测试同时记录原始像素差异和一像素平滑后的差异。第 07 个样本的单图片 pattern 展开后存在 JPEG 重采样差异，图片原始数据保持一致。兼容导入不表示每个像素完全相同，也不覆盖所有 SVG 特性。

关闭项目可单独运行 `npm run test:ui -- --close-only`，同样使用 Node Playwright 和隔离服务，覆盖取消、导出后关闭、立即刷新、旧请求隔离、再次打开以及论文内嵌画板。

画布方向键导航可单独运行 `npm run test:ui -- --canvas-navigation-only`，检查放大后的四向平移、Shift 加速、适应画板，以及输入与文字编辑时不拦截方向键。

手动组合可单独运行 `npm run test:ui -- --manual-grouping-only`，检查缩放和平移后的框选、逐项预览/移出、组合移动和等比缩放、嵌套与取消组合、JSON 往返、撤销/重做，以及原始 SVG 裁剪、透明度和绘制顺序保持不变。

全量生成、原生画板编辑和局部重生成是分开的验收项。跑通它们并不代表自动生成图已达到参考论文图的视觉完成度。

设计依据与第三方说明见 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
## GUI regression tests

Run `npm run test:ui` to exercise the workbench, actual template PDF preview, dependency-only template repair, cached compilation, preview updates after editing, and pending-figure editing. These tests start a separate server on port 8788 with a fresh temporary store for papers, drawings, generated assets, and usage. The temporary store is deleted when the run finishes. `PAPER_TEST_PYTHON` can select a Python executable with Playwright installed.

The normal app on port 8787 continues to use `outputs/papers` and `outputs/runs`. QA fixture creation/import is rejected on that live app. The standalone GUI fixture scripts also verify `dataScope: test` before making changes; do not run them against the live server.

## 生成失败与恢复

方法图的文字框根据实际字体度量自动扩容、换行和定位；不删除科学标签、不缩小字号，也不改写保存的原始模型草稿。锁定对象或局部画布确实无法容纳的内容仍会明确报错。

整稿生成中，绘图失败不会中断后续正文。任务显示“正文已生成 · 绘图待重试”，成功章节仍保留为候选，不自动写入主稿。点击“重试未完成模块”复用已保存的章节和绘图检查点；已接受且未再次编辑的章节也可复用。材料或章节发生修改后，旧检查点不能覆盖它们，需开始新任务。独立绘图任务失败、正文生成失败和用户取消仍会停止对应任务。

同一次生成的候选可以分步接受，再接受剩余整批。同批次、内容未改动的上游候选写入主稿不会使其他候选过期，也不会产生错误的同步标记。真正的手动编辑、历史版本恢复、材料更新或其他批次替换仍会触发依赖校验；编辑上游候选后，需要更新依赖它的旧候选。

`tests/unit/paper-generation.test.ts` 使用注入的模拟服务检查失败隔离、候选恢复和取消行为；`tests/browser/figure_failure_browser.py` 拦截所有生成请求，检查部分完成提示与同一任务恢复后的进度更新。均不调用付费模型。
