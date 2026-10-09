# GitHub 源码交接

## 本次交接范围

源码包包含前后端、共享类型、依赖锁文件、测试、独立合成示例、协作说明和选择性复用的上游提示词 / 许可证。不含依赖安装目录、构建目录、API key、论文项目、实验材料、生成结果、私人验收记录或用户提供的参考图。

解压后以里面的 `paper-studio/` 作为仓库根目录。上传的是这些源码文件，不是把 ZIP 文件本身当作仓库源码。`.github/`、`.gitignore`、`.gitattributes` 和 `.env.example` 也应保留。

尚未创建 GitHub 仓库、设置 remote 或推送。自有代码也尚未选择对外开源许可证；原有上游 Apache-2.0 文件和出处保留。

## 用 GitHub Desktop

1. 解压源码包，选择内层 `paper-studio/`。
2. 在 GitHub Desktop 中以此目录创建本地仓库，检查 Changes 列表不含凭据或论文数据，再提交。
3. Publish repository，选择合适的公开性；未公开的研究协作可以使用 Private。
4. 在 GitHub 仓库设置中邀请合作者。不要用聊天或仓库共享一把生产 API key。

也可以通过 Git CLI 初始化、提交，并按新仓库页面给出的地址设置 remote。本文不预设你的 GitHub 用户名或仓库地址。

## 合作者启动

在仓库根目录执行：

```sh
npm ci
npm run build
npm start
```

打开 http://localhost:8787/，自行配置 API。`examples/demo/` 是明确标注的合成输入和自编测试模板，不是你的原论文，不代表任何真实实验结果。正式使用时上传自己的 Idea、Experiment 和完整会议模板。PDF 预览需要可用的 `pdflatex`；主稿编辑、方法配置和画板不要求先编译 PDF。

## 以后重新打包

```sh
npm run package:source -- --check
npm run package:source -- --name paper-studio-team-v2 --stage
```

包和干净源码目录写入 `releases/`，已有同名目标不会被覆盖。`PACKAGE_MANIFEST.json` 记录每个源码文件的 SHA-256；外部清单记录 ZIP 的 SHA-256。打包器检查常见凭据格式和当前本机已配置 key 是否误入源码，但不能代替对未知秘密、研究隐私和第三方权利的人工审查。

没有合并或删除原工作区数据。本机的原论文、原参考图和历史测试记录仍留在原位置，只是不进入交接包。
