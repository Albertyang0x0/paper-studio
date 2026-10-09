# 论文工作台与矢量图生成契约

目录分组和运行入口见 [Paper Studio 项目说明](../README.md)。本页的代码路径以项目根目录为基准。

新增论文平台层：`paper-workbench/1` 统一项目、章节、引用、图形资产、候选和历史；`paper-module/1` 定义独立方法输入/输出。服务器调度不同方法并保存候选，只有主稿事务可以接受结果。生成器没有主稿写入权限，图表经嵌入画板和版本化候选回传。

论文模块架构与分工见 [MODULE_CONTRACT.md](MODULE_CONTRACT.md)。`server/paper/` 是独立底座，`vendor/paper-orchestra/` 只保留选择性上游提示词与许可证。下文为既有绘图模块的分层契约，不代表所有参考工具已接入。

## 设计依据

[PaperOrchestra 的 paper_banana_utils.py](https://github.com/google-research/paper-orchestra/blob/main/utils/paper_banana_utils.py) 值得借鉴的是参考选择、规划、统一风格和生成后的视觉审查。其 diagram 路径使用图像模型，不等于提供原生可编辑的矢量对象。

[FigTree](https://github.com/yepengliu/FigTree) / [论文](https://arxiv.org/html/2609.01006v1) 与“设计总方案、子图独立生成、父级组装”已经十分接近：递归区域拆分、局部 SVG、边界与端口、父级连接、程序与图像双重审查都应作为已有工作明确承认。本实现目前只有一层模块分解，没有完整实现 FigTree 的递归与验证记忆。

[AutoFigure-Edit](https://github.com/ResearAI/AutoFigure-Edit) 的图形生成/编辑分离提供产品启发；其 SVG 可包含位图图标，不能混称为全部纯矢量。我们选择直接生成可寻址对象，不先生成整图位图再矢量化。

[Fabric.js](https://fabricjs.com/) 是实际使用的画板库。项目没有引入 draw.io、Mermaid、TikZ 或 PptxGenJS，也没有把不存在的适配器显示为已接入。

## 文档格式与调度

`shared/types.ts` 定义 `paper-atelier/1`：

```
FigureScene
├─ semanticPlan：组件、关系、材料引用、科学约束
├─ style：字体、颜色、字号、线宽、插画语言
├─ regions：大分区与背景
├─ modules：位置/大小 + 局部画布 + ports + 元素树
│  └─ elements：text / rect / ellipse / path / polygon / line / group
├─ connectors：跨模块有向关系与布线
├─ annotations：整图标注
└─ review / history：问题与执行记录
```

`server/pipeline.ts` 负责：材料→语义图→设计任务→最多3个并行 worker→组装→视觉审查。角色是独立模型调用，不是固定名称装饰。方法由用户选择，默认不会自动挑选工具。锁定与局部修改由程序约束，不只依赖提示词。

`server/bounds.ts` 用实际 SVG 渲染的 alpha 范围测量模块对象，包括字体范围；校验失败最多重新生成一次。`server/validation.ts` 校验引用、组件覆盖、几何边界、必要文字、路径语法和模块碰撞。约束检查不能证明科学内容没有错误。

`server/typography.ts` 通过真实字体度量检查可见字形碰撞，并纳入父级变换后的字号。子模块生成时也读取视觉参考；若检测到文字碰撞，第二次尝试会获得自己的实际渲染和具体对象 ID，而不是只收到抽象的“请画得更好”。可选视觉修订失败不会抹掉上一个结构有效的草稿，但该草稿仍需修订。

`shared/svg.ts` 编译矢量输出，提供基于障碍物的正交布线。显式转折点由用户或组装器拥有，仍需审查；目前没有全局最优布线、自由曲线节点编辑或完整连接碰撞求解。

`src/figure/CanvasEditor.tsx` 使用原生 Fabric 对象编辑同一份 Scene，而不是操作 SVG 预览的假覆盖层。JSON 是当前可靠的重新打开格式。

## 可扩展的 skill merge

生成任务、方法、模型与输出文档分离，可以增加不同方法的真实适配器；目前三种策略分别强调自由矢量、素材辅助和结构化图解。未来 introduction / method / results 等模块应各自拥有证据输入、方法注册表、输出契约、审查与人工修改机制，不能直接共用“绘图 worker”假装完成整篇论文。

## 目前不成立的宣称

没有新的学术创新得到验证；尚未开展统一基准实验。已有 FigTree 等方案说明“多 agent + 子图 SVG 组装”本身不能当作新贡献。后续可以研究用户方法组合、可编辑性保持、人工修改下的局部重生成、跨模块一致性等，但需比较和消融才能提出实证创新。
