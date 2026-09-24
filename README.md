# solo-6600021: 盲文翻译与触觉学习器

## 技术栈
- Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS + SVG + Vibration API

## 核心特性
1. **中英文→盲文实时翻译**：Braille Grade 1 编码，Unicode 盲文字符输出
2. **6 点阵 SVG 大尺寸渲染**：可交互点击选择盲文点阵
3. **Vibration API 触觉模拟**：答对/答错不同振动模式
4. **训练模式**：看字符选盲文，正确率统计，历史记录
5. **速查表**：26 字母 + 数字完整盲文对照
6. **可打印 PDF 导出**：翻译结果导出为文本文件

## 启动
```bash
cd frontend && npm run setup && npm run dev
```

## 依赖安装
- 依赖版本由 `frontend/package-lock.json` 锁定并提交，每台机器装到的版本一致
- `npm run setup` 安装前会校验现有 `node_modules` 与清单是否一致：一致则直接复用，不一致则清场后干净重装（`npm ci`），不残留半成品
- 安装失败会说明是哪个包、卡在哪一步（下载 / 校验 / 安装脚本），完整日志见 `frontend/install-error.log`，修好后重跑 `npm run setup` 即可
- 装完把本次版本清单写入 `frontend/.install-manifest.json`（本地文件，不提交）；`npm run dev` / `npm run build` 前会自动校验该清单，一致则直接复用
- 强制重装：`npm run setup -- --force`
