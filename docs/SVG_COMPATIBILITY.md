# 科研 SVG 导入兼容说明

Paper Studio 的“导入 SVG”在浏览器中把受支持的 SVG 图形转换为 `paper-atelier/1` 原生对象，不调用模型，不通过截图识别文字，不下载外部资源。导入后可编辑、导出 JSON，再通过“打开项目”继续编辑。这个入口处理明确的 SVG 子集，不是完整的浏览器 SVG 渲染器。

“可导入”表示结构在下表支持范围内；仍须检查具体文件的警告、字体和视觉结果。静态悬停转换与缺图占位会明确提示，不能当作交互或缺失内容的完整恢复。遇到不支持的结构时，整次导入失败，当前项目保持不变。下文的通过数量对应注明日期的样本和运行记录，当前回归结果以本次生成的报告为准。

## 常见科研 SVG 来源

| 来源 | 常见形式与官方格式依据 | 在工作台中的处理 |
| --- | --- | --- |
| Matplotlib | `svg.fonttype='path'` 将字形写成路径，`'none'` 保留文字和字体声明；默认路径模式不依赖接收端字体。[Matplotlib 字体说明](https://matplotlib.org/stable/users/explain/text/fonts.html#fonts-in-svg) | `defs/use` 字形展开后仍是路径，不能直接改字；需要文字编辑时，在源绘图脚本选择 `'none'` 并准备对应字体。普通路径、裁剪、定位文字按支持范围导入。 |
| R / svglite（含使用它导出的 ggplot2） | `fix_text_size=TRUE` 会给文字记录 `textLength` 和 `lengthAdjust='spacingAndGlyphs'`，以固定输出宽度；也可声明 web fonts。[svglite 参数说明](https://svglite.r-lib.org/reference/svglite.html) | 支持常见 `.svglite line` 等静态样式、单行 `textLength` 和字体候选列表。web font 的 `@import/@font-face` 仍拒绝；请使用本地可用字体。 |
| Graphviz | `dot -Tsvg` 输出 XML/SVG；官方示例含 SVG 1.1 `PUBLIC` 文件头、`pt` 尺寸、节点和边的 ID。[SVG 输出](https://graphviz.org/docs/outputs/svg/)、[属性与 SVG 示例](https://graphviz.org/doc/info/attrs.html#d:comment) | 接受标准文件头和物理单位，读取实际图形、文字与坐标。边本身可能是普通路径，不保证每条边都提升为工作台连接线。 |
| Inkscape | SVG 2 流式文字可带 SVG 1.1 定位回退；也可能只有流式布局数据。官方说明将流式文字回退作为导出选项。[Inkscape 1.0 文字兼容说明](https://wiki.inkscape.org/wiki/Release_notes/1.0) | 使用已有定位 `tspan`，保留源字号、字间距和坐标；不重新计算流式换行。常见编辑器字体描述字段被忽略。无坐标回退的流式文字需先在源软件中转换。 |
| 网页论文插图 / 交互图 | SVG 可能与宿主页共享 CSS、相对图片、悬停样式和脚本，并不一定是独立完整文件。 | 只使用文件自带的静态图形和样式。受支持的悬停切换转默认外观；缺失相对图片用占位框。网页 CSS 不在文件中时无法恢复，脚本不会执行。 |

上述格式依据解释不同导出工具为何生成不同结构，不表示这些工具的所有 SVG 都能导入。

## 结构兼容矩阵

| 结构或属性 | 当前处理 | 边界与编辑结果 |
| --- | --- | --- |
| SVG 1.0/1.1 标准 `PUBLIC/SYSTEM`、简单 `<!DOCTYPE svg>` | 接受并移除文件头 | 不下载 DTD、不展开实体。内部子集、实体声明、未知 DTD 和 `xml-stylesheet` 拒绝。 |
| `viewBox`、`px/pt/pc/mm/cm/in`、受支持位置的百分比 | 换算为用户坐标与画布尺寸 | 保留非零 `viewBox` 原点及受支持的视口变换；不表示支持所有嵌套视口或 CSS 长度表达式。绝对单位以 `96px = 1in` 换算。[W3C 长度单位](https://www.w3.org/TR/css-values-3/#absolute-lengths) |
| `rect/circle/ellipse/line/polyline/polygon/path` | 转为原生形状或路径 | 变换后的复杂图形仍可整体移动、缩放、旋转和改色；当前没有通用路径节点编辑器。 |
| `g`、本地 `defs/symbol/use` | 展开本地引用，实例可独立编辑 | 按现有导入规则整理模块；普通 `g` 不保证逐层对应图层树。保留透明度、裁剪和受支持滤镜所需的组合边界，不把整张 SVG 强制合成一个模块。 |
| 静态 CSS | 在引用展开前计算并写回元素样式 | 支持标签、类、ID、后代、子元素和简单属性选择器；保留声明顺序、选择器优先级及 `!important`。动态/伪类选择器、复杂 CSS 指令仍拒绝。 |
| `font` 简写、`font-family` 候选列表 | 展开为字号、字重、斜体等属性，保留完整候选列表 | 依赖本机字体；不获取外部字体。不支持的系统字体简写、特殊字体变体等会拒绝。 |
| OmniGraffle 的本地 `font-face-name` 声明 | 读取文字自身的 `font-family`，移除仅用于描述本地字体的旧声明并提示 | 不加载外部字体或嵌入式 SVG 字体；缺少本机字体时仍使用浏览器回退。 |
| `text/tspan`、`x/y/dx/dy`、水平对齐 | 转为可编辑文字，必要时拆成定位文字段 | `em` 位移按当前文字字号换算；多值逐字定位、逐字旋转、竖排及倾斜/镜像文字等复杂排版仍拒绝。已转曲的“字”只能作为路径编辑。 |
| 不含字符的 `text/tspan` | 跳过无绘制影响的空节点，提示数量 | 空节点上的残留下标、坐标不再阻止整图导入，也不移动后续文字；包含空格的节点仍保留排版语义。检查主动内容后才跳过空节点。真正含字符的 `baseline-shift` 仍不支持。 |
| `text-decoration="underline"` / CSS 下划线 | 保存为原生文字的 JSON `underline`，编辑文字后跟随文字长度 | 画板按本机字体校准位置和线宽；保留祖先下划线传播，子节点 `none` 不取消祖先装饰；支持保留空格的下划线。带描边或继承下划线中混合不同字体/颜色等复杂装饰仍拒绝。[SVG 文字装饰](https://www.w3.org/TR/SVG11/text.html#TextDecorationProperty) |
| `letter-spacing` | 保存为 JSON `letterSpacing` | 画板和 SVG 导出使用同一字间距字段。 |
| 单行单对象 `textLength` | `spacing` 转字间距；`spacingAndGlyphs` 转横向缩放 | 多段独立样式或多行的长度约束、单个 `tspan` 的 `textLength` 仍拒绝；编辑文字后不保留动态重新适配原宽度的约束。[W3C 文字长度与排版](https://www.w3.org/TR/SVG2/text.html) |
| `shape-inside` 与已定位 `tspan` | 使用源文件已有的定位回退，并显示提示 | 不用 `line-height` 重新排版，不实现自动换行；没有定位回退的流式文字仍拒绝。 |
| `paint-order` | 保留填充/描边先后关系为 JSON `paintOrder` | marker 仍在主体后绘制；要求 marker 先于填充或描边的情况拒绝。[W3C 绘制顺序](https://www.w3.org/TR/SVG2/painting.html#PaintOrderProperty) |
| `marker-start/mid/end` | 在受支持的端点和路径顶点展开标记形状 | 包括中间顶点箭头及自动方向；带箭头路径的整体透明度会在路径和箭头合成后统一应用。不是每种 marker 视口或嵌套组合都支持，marker 定义自身的整体透明度仍受限制。可明确识别且满足图层约束的模块间箭头才会转换为原生连接线。 |
| 实色、虚线、线性填充渐变 | 保留颜色与受支持的绘制属性 | 渐变文字、渐变描边、径向渐变不在当前范围内。 |
| `linearGradient` 的本地 `href/xlink:href` | 递归展开引用链，保留当前渐变覆盖的属性和色标 | 继承未指定的坐标、坐标单位、变换等；只有缺少自有色标才继承完整色标列表，并保留模板色标颜色上下文。循环、缺失目标、错误引用类型及外部资源明确拒绝，仍受展开数量与深度限制。 |
| 分组 `opacity`、`clipPath` | 保存组合透明度和 JSON `clip` | 裁剪限 `userSpaceOnUse` 中的单形状；`mask` 和任意多形状裁剪仍拒绝。 |
| 内嵌 PNG/JPEG | 按内容去重写入 `assets`，实例保存资源 ID 与变换 | 像素保持图片，不自动变成文字/矢量；受支持的整体移动、缩放、旋转与裁切不修改原始图片数据。 |
| 相对图片路径 | 缺资源时在原位置建立带叉号的占位框，提示路径 | 不读取旁边文件、不请求网页、不猜测图片内容；受其余图形变换限制。提供图片并在源软件中嵌入 PNG/JPEG 后可重新导入。网络 URL 与绝对文件路径仍拒绝。 |
| `filter` | 支持样本中的偏移着色阴影、扩边扣除阴影 | 保存为 `svgShadow`；任意滤镜图、模糊等未支持效果仍拒绝。画板的局部显示缓存不替代原生对象。 |
| `pattern` | 矩形上的整幅单图片图案转为图片与裁剪 | 任意矢量图案、重复平铺及其它坐标/变换组合仍拒绝。 |
| 悬停 `<set>` | 受支持的鼠标/焦点样式切换移除，导入默认静态外观并提示 | 不保存交互高亮；其它动画不执行，超出允许范围的动画拒绝。动态 CSS 伪类不在此转换范围内。 |
| 项目元数据、编辑器辅助字段 | 不用于替代实际绘图；忽略非绘图说明 | 以 SVG 当前文字、路径和坐标为准，不从过期 JSON 恢复旧图。元数据中的普通来源 URI 不作为渲染资源获取。 |
| 带描边的非等比缩放 | 部分可分解的变换保留在对象缩放字段 | 带描边的倾斜（shear）、无法分解的旋转后非等比变换仍拒绝；可先在源软件中将描边转为轮廓。 |

SVG 定义的能力大于此导入子集。文件头依据见 [W3C SVG 1.1 文档定义](https://www.w3.org/TR/SVG11/intro.html)，文字与绘制属性依据见上表所链接的 SVG 规范；是否接受某个组合仍由导入器明确检查。

## 不完整文件与失败处理

单独拿到一个 SVG，不一定同时拿到了原图的字体、网页样式和相对图片。缺图占位会保留位置及支持的变换，但不会补造缺失内容；边框和叉号使用填充轮廓，可随倾斜变换显示。若文件只含 `.figure-text` 等类名，没有对应 `<style>` 或元素样式，从类名无法推断原网页的颜色、线宽或字号。未声明字体的文字采用浏览器 `sans-serif` 回退；源文件缺少字体声明或本机字体时，不同平台可能显示不同字形。

需要完整恢复时，应从源软件导出独立文件，保留可编辑文字或明确接受转曲文字，并嵌入图片。包含特殊蒙版、径向渐变、任意滤镜、重复图案、无定位回退的流式排版或带描边倾斜时，可在源软件中展开对应效果后再导入。展开效果会改变原来的编辑结构，应另存副本。

脚本、事件处理代码、外部样式或字体加载、未知 DTD、XML 实体不会作为兼容回退执行。拒绝时不会用半张图替换当前项目；成功导入后仍应查看“SVG 导入结果”中的警告，再导出 JSON 保存。

资源上限：文件 5 MiB；引用展开后 12000 个 XML 元素；单张图片单边 8192 像素；去重后的总解码像素 6400 万；单个场景最多校准 256 种下划线字体组合。对象数量、嵌套深度和画布尺寸也有检查，超限文件应先拆分。

## 当前仓库保留的 6 张 diagram

`SVG_TO_JSON_TEST` 顶层仅保留以下 6 个原文件，来源、许可及 SHA-256 记录在 [SVG_SAMPLE_SOURCES.json](SVG_SAMPLE_SOURCES.json)。这些图从此前已实测的论文语料中选取，保留 5 个成功案例和 1 个失败案例，便于手动检查导入、编辑与错误提示。

| 文件 | 内容 | 此前实测结果 |
| --- | --- | --- |
| `ml01_rnn_lstm.svg` | LSTM 结构图 | 通过 |
| `ml02_rnn_gru.svg` | GRU 结构图 | 通过 |
| `ml04_deconv_uneven.svg` | 非均匀反卷积连接图 | 通过 |
| `ml05_deconv_even.svg` | 均匀反卷积连接图 | 通过 |
| `nichenet_input_decision_tree.svg` | NicheNet 输入选择决策图 | 通过 |
| `nichenet_workflow.svg` | NicheNet 工作流图 | 拒绝：`spreadMethod=reflect` 尚不支持 |

默认兼容测试读取此目录顶层全部 `.svg`，不要求 01–15 编号。按此前逐文件实测，当前精选集应为 **5/6 通过**；保留的失败样本仍按失败记录，因此完整命令返回非零退出码，不把它改记为通过。

精简前完整目录的 33 个文件已备份到本机 `D:\Projects\SVG_Sample\SVG_TO_JSON_TEST`，包括原始 20 张编号 SVG、8 张论文 SVG 及相关清单、许可和报告。该备份不随仓库上传。下文保留原测试的历史结果；相应 8 张论文语料现在位于备份的 `PAPER_CORPUS_20261012` 子目录，完整测试产物仍在本机 `test-artifacts` 下。

## 历史公开论文样本 16–20

这些样本补充常见网页论文插图结构；来源、原始 URL、SHA-256、许可与缺失资源说明记录在本地 `test-artifacts/paper-svg-corpus/provenance.json`。下面的编号和数量仅表示样本集合，不是测试通过数量，也不是论文引用次数。

| 样本 | 论文及原图 | 关注结构 / 完整性 |
| --- | --- | --- |
| `16_activation_atlas_model.svg` | [Activation Atlas（2019）](https://distill.pub/2019/activation-atlas/)，[model2.svg 原文件](https://raw.githubusercontent.com/distillpub/post--activation-atlas/master/public/assets/images/model2.svg) | CSS 类、`hsla` 颜色、字体候选列表、嵌套变换。 |
| `17_interpretability_cube_groups.svg` | [The Building Blocks of Interpretability（2018）](https://distill.pub/2018/building-blocks/)，[cube_groups.svg 原文件](https://raw.githubusercontent.com/distillpub/post--building-blocks/master/public/images/cube_groups.svg) | 嵌套透明度、图像仿射变换、路径与文字；4 个图像元素引用同一个缺失相对 PNG `../examples/input_images/dog_cat.png`，不能把占位效果当作原图片。 |
| `18_interpretability_design_space.svg` | [The Building Blocks of Interpretability（2018）](https://distill.pub/2018/building-blocks/)，[teaser.svg 原文件](https://raw.githubusercontent.com/distillpub/post--building-blocks/master/public/images/design_space/teaser.svg) | SVG 1.1 文件头、`pt`、非零 `viewBox` 原点、marker、定位 `tspan` 和字体元数据。 |
| `19_double_q_learning.svg` | [The Paths Perspective on Value Learning（2019）](https://distill.pub/2019/paths-perspective-on-value-learning/)，[double-q-learning.svg 原文件](https://distill.pub/2019/paths-perspective-on-value-learning/figures/double-q-learning.svg) | CSS 类、多边形和路径。 |
| `20_function_approximation_comparison.svg` | [The Paths Perspective on Value Learning（2019）](https://distill.pub/2019/paths-perspective-on-value-learning/)，[compare-function-approx.svg 原文件](https://distill.pub/2019/paths-perspective-on-value-learning/figures/compare-function-approx.svg) | CSS 类、多边形、路径及文字。 |

清单标注这些论文原创图文的 CC-BY-4.0 许可及出处；不把另有署名的第三方素材或尚未提供的外部照片一并视为已授权、已下载或已还原。

## 2026-10-12 新增公开论文首次测试（修复前）

本轮新增 8 张未修改的 SVG，与原有 01–20 的 SHA-256 均不同；完整原语料现保存在本机 `D:\Projects\SVG_Sample\SVG_TO_JSON_TEST\PAPER_CORPUS_20261012\`。其中 `provenance.json` 保存论文、原图 URL、哈希、许可依据及图与论文的关联说明；`report.before-three-fixes.json` 保存首次测试结果，`report.json` 保存三项兼容修复后的逐图结果。此目录包含已知失败的探索语料，当前仓库精选集不等于完整历史语料。

后续选样优先使用 diagram：方法流程图、网络结构图、模块连接图和决策图。统计曲线等图表用于补充导出工具的格式回归，不作为主要选样方向。

| 论文 / 作者配套资源 | OpenAlex 引用次数 | 样本数 | 本轮结果 |
| --- | ---: | ---: | --- |
| [Feature Visualization](https://distill.pub/2017/feature-visualization/) | [859](https://openalex.org/W4229494842) | 1 | 通过 |
| [Deconvolution and Checkerboard Artifacts](https://distill.pub/2016/deconv-checkerboard/) | [1638](https://openalex.org/W2535388113) | 2 | 均拒绝：本地渐变引用尚未支持 |
| [NicheNet](https://www.nature.com/articles/s41592-019-0667-5) 作者当前配套示意图 | [2147](https://openalex.org/W2992151131) | 2 | 均拒绝：分别遇到下划线和反射渐变 |
| [Visualizing memorization in RNNs](https://distill.pub/2019/memorization-in-rnns/) | [26](https://openalex.org/W2924992615) | 2 | LSTM 通过，GRU 拒绝 |
| [veloVI](https://www.nature.com/articles/s41592-023-01994-w) 官方论文复现仓库图 | [142](https://openalex.org/W4386923465) | 1 | 通过 |

引用数为 2026-10-12 查询 OpenAlex 的结果，各数据库口径不同。RNN 和 veloVI 用于补充经过同行评审的结构样本，不称为高引用论文。两张 NicheNet 图来自作者当前软件仓库，包含后续协议工作流更新，不能当作 2020 年出版排版版原图；veloVI 图的出版面板编号未核实。

逐文件结果如下；拒绝项只列首先遇到的阻断，解除后仍需完整重测。

| 文件 | 实测结果 / 已确认原因 |
| --- | --- |
| `ml01_rnn_lstm.svg` | 通过导入、SVG 导出像素比较、实际 Canvas 比较和 JSON 重开；24 个 `use` 展开为原生对象。公式字形本来是轮廓，无法直接编辑成文字字符串。 |
| `ml02_rnn_gru.svg` | 被 `baseline-shift=sub` 拒绝。3 处均是没有内容的空 `tspan`；应先消除无绘制影响的空节点，而非把该文件当作复杂上下标排版。 |
| `ml03_activation_spectrum.svg` | 通过画面比较与 JSON 重开；另实测图片移动、路径描边改色、文字编辑及编辑后的 JSON 重开。保留 3 个图片资源、14 个文字对象。 |
| `ml04_deconv_uneven.svg` | 拒绝：22 个本地 `linearGradient` 引用。实际没有外部链接、脚本或事件属性，现有主动内容错误提示不准确。 |
| `ml05_deconv_even.svg` | 拒绝：14 个本地 `linearGradient` 引用，同上。 |
| `nichenet_input_decision_tree.svg` | 拒绝：11 个文字片段带 `text-decoration=underline`。 |
| `nichenet_workflow.svg` | 拒绝：3 个渐变带 `spreadMethod=reflect`。静态检查显示这 3 个渐变的起止范围恰好覆盖各自矩形，没有实际越界反射区域，可进一步验证是否能做严格的等价转换；不能全局忽略该属性。 |
| `velovi_retina_runtime.svg` | 通过导入、画面比较和 JSON 重开；140 个 `use` 展开，保留裁剪。坐标文字本来是字形路径。 |

本轮为 **3/8 通过，5/8 拒绝**；没有把失败样本修改成简化版本，也没有放宽像素阈值。通过项均完成实际 Canvas 与导出 SVG 两项视觉检查及 JSON 往返，并不只看“导入成功”提示。完整像素对照与编辑产物在 `test-artifacts/paper-svg-20261012/final-results/`。测试在隔离 8788 服务进行，未操作 8787 项目；测试期间模型/API 请求与外部网络请求均为 0。

首次测试确定了本地渐变继承、不可见空文字节点及下划线三个优先修复项。这些失败不应一概归为罕见 SVG。渐变继承需要解析引用链中的坐标单位和色标，并保留实例自己的坐标，不能只删除 `href` 检查。[SVG 1.1 渐变引用定义](https://www.w3.org/TR/SVG11/pservers.html#LinearGradientElementHrefAttribute) 反射渐变及复杂复合效果可按实际需要排在后面。

复现本轮：

```powershell
$env:PAPER_TEST_SVG_CORPUS_DIR = "D:\Projects\SVG_Sample\SVG_TO_JSON_TEST\PAPER_CORPUS_20261012"
$env:PAPER_TEST_SVG_COMPAT_OUTPUT = "test-artifacts/paper-svg-20261012/recheck"
$env:PAPER_TEST_SVG_EDIT_FILES = "ml03_activation_spectrum"
npm run test:ui -- --svg-compat-only
Remove-Item Env:PAPER_TEST_SVG_CORPUS_DIR
Remove-Item Env:PAPER_TEST_SVG_COMPAT_OUTPUT
Remove-Item Env:PAPER_TEST_SVG_EDIT_FILES
```

首次测试时，上述命令因 5 张不兼容样本返回非零退出码，报告保存了全部 8 张的结果。首次测试只增加公开样本、测试记录及外部语料编辑验证能力；上表是修复前的历史结果，后续修改需重新运行并查看最新报告。

## 2026-10-12 三项兼容修复后复测

已补齐本地线性渐变引用继承、不含字符的空文字节点处理、原生可编辑文字下划线。GRU 图继续暴露的半透明箭头问题也已修复：先合成线身与箭头，再应用元素透明度，避免重叠位置变深。

本轮以 diagram 为主要验证对象，8 张论文及作者配套 SVG 从首次 **3/8 通过提高到 7/8**；源文件 SHA-256 均与下载清单一致。没有修改原图来绕开失败，也没有放宽画面差异阈值。

| 重点 diagram | 修复后结果 |
| --- | --- |
| `ml02_rnn_gru.svg`，GRU 结构图 | 通过；忽略 3 个空 `tspan`，保留半透明路径与箭头的整体绘制效果。 |
| `ml04_deconv_uneven.svg`、`ml05_deconv_even.svg`，反卷积连接图 | 均通过；分别展开 22、14 个本地渐变引用，保留实例坐标和继承色标。 |
| `nichenet_input_decision_tree.svg`，决策图 | 通过；保留 11 个下划线文字片段，另验证移动、改色、文字编辑及编辑后的 JSON 重开。 |
| `nichenet_workflow.svg`，工作流图 | 仍拒绝 `spreadMethod=reflect`；反射渐变不属于本轮三项修复范围。 |

LSTM 结构图及补充图表 `ml03_activation_spectrum.svg`、`velovi_retina_runtime.svg` 仍通过。全部通过项均检查导出 SVG、实际 Canvas 和 JSON 重开；不是仅检查导入提示。本轮逐图结果现保存在 `D:\Projects\SVG_Sample\SVG_TO_JSON_TEST\PAPER_CORPUS_20261012\report.json`，首次结果保留在同目录 `report.before-three-fixes.json`，完整本轮产物位于 `test-artifacts/svg-three-fixes-papers-final/`。探索语料命令仍因已知的反射渐变样本返回非零退出码。

本轮科研格式浏览器套件 **13/13 组通过**（含 19 种拒绝输入及当前项目保留检查）；下划线测试包含祖先传播、CSS、文字编辑和 JSON 往返。原有编号 SVG **20/20 通过**，附加效果、symbol 独立编辑和资源释放测试也通过，记录在 `test-artifacts/svg-three-fixes-baseline-final/`；其中缺失资源仍按报告声明的占位方式处理。完整单元测试 **205/205 通过**，`npm run build` 通过。浏览器测试使用隔离 8788 服务，模型/API 调用和外部资源请求均为 0。

## 运行回归

先执行 `npm run build`，并准备 Node Playwright；需要时用 `PAPER_TEST_NODE_MODULES` 指向已有 Playwright 的 `node_modules`。以下入口启动隔离的 8788 测试服务，不操作 8787 正式项目，不调用付费模型。

```powershell
npm run test:ui -- --svg-only
npm run test:ui -- --svg-compat-only
npm run test:ui -- --svg-scientific-only
```

| 入口 | 范围 | 报告 |
| --- | --- | --- |
| `--svg-only` | 基础导入、编辑、JSON 往返、导出、失败保留项目 | 套件日志与 `test-artifacts` 下的本次产物 |
| `--svg-compat-only` | 自动遍历 `SVG_TO_JSON_TEST` 顶层全部 `.svg`，当前 6 张 diagram 中有 1 张已知失败，完整命令因而返回非零退出码；默认完整运行还包含效果、资源和生命周期夹具 | `test-artifacts/svg-compatibility/report.json` 及各样本 JSON/SVG/像素对照图 |
| `--svg-scientific-only` | 不依赖外部样本目录的合成夹具：标准文件头、单位、CSS 字体与优先级、文字间距与长度、空文字、可编辑下划线、渐变引用继承、定位回退、绘制顺序、marker 与透明度、静态悬停、缺图占位及危险输入拒绝 | `test-artifacts/svg-scientific/report.json` 及对应产物 |

兼容套件支持以下环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `PAPER_TEST_SVG_COMPAT_FILES` | 逗号或空格分隔的完整文件名或不带 `.svg` 的文件名；对历史 `NN_` 文件也可使用编号。未匹配的选择项会报错。 |
| `PAPER_TEST_SVG_EDIT_FILES` | 对选中语料中的指定文件额外执行移动、改色、编辑文字及 JSON 重开；支持同样的文件选择语法。需要原生文字和可改填充或描边的形状；有图片时优先移动图片。原有 04/07 默认编辑检查保留。 |
| `PAPER_TEST_SVG_CORPUS_DIR` | 用指定目录顶层的全部 `.svg` 替换本次默认样本来源；可用来读取仓库外完整备份。不要求编号，不递归扫描、不自动下载，也不修改源文件。可再用文件选择变量筛选。 |
| `PAPER_TEST_SVG_COMPAT_OUTPUT` | 指定兼容测试报告目录，便于保留不同语料或不同轮次的结果。 |
| `PAPER_TEST_SVG_COMPAT_SYNTHETIC=1` | 筛选文件或使用外部目录时，仍启用兼容套件的额外合成用例；它不替代单独的科研格式套件。 |

```powershell
$env:PAPER_TEST_SVG_COMPAT_FILES = "ml01_rnn_lstm,ml02_rnn_gru,ml04_deconv_uneven,ml05_deconv_even,nichenet_input_decision_tree"
npm run test:ui -- --svg-compat-only
Remove-Item Env:PAPER_TEST_SVG_COMPAT_FILES

$env:PAPER_TEST_SVG_CORPUS_DIR = "D:\Projects\SVG_Sample\SVG_TO_JSON_TEST\PAPER_CORPUS_20261012"
$env:PAPER_TEST_SVG_COMPAT_OUTPUT = "test-artifacts/custom-svg-corpus"
npm run test:ui -- --svg-compat-only
Remove-Item Env:PAPER_TEST_SVG_CORPUS_DIR
Remove-Item Env:PAPER_TEST_SVG_COMPAT_OUTPUT
```

报告应分别阅读导入状态、警告、对象语义、JSON 往返和图像差异。字体替代、浏览器抗锯齿及图像重采样可能造成像素差异；缺图占位的比较目标是已声明的占位图，不是不可获得的原图。通过某份文件的回归不等于兼容全部 SVG，也不验证论文内容的科学正确性。
