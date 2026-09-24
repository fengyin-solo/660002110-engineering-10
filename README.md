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
cd frontend
npm run setup   # 安装依赖（受守护：装前校验、失败可安全重试）
npm run dev
```

## 依赖安装（受守护）
`npm run setup` 把安装变成看得见结果的一步：

1. **装前校验**：先比对 `node_modules` 实际装到的版本与 `package-lock.json` 是否一致，一致则直接复用，不重复安装；
2. **隔离安装**：安装在与 `node_modules` 隔离的临时目录中进行，全部装完并再次校验通过后才原子切换生效——中途断网/失败不会留下半成品，修复后重跑 `npm run setup` 即可；
3. **失败定位**：装不上时明确指出卡在哪一步、涉及哪个包，完整日志保存在 `frontend/logs/`；
4. **清单复用**：装完把本次实际装到的版本写入 `package-lock.json`（已纳入版本管理，请提交）和 `node_modules/.install-stamp.json`，下次启动或其他机器直接按清单复现。

常用命令：
- `npm run setup`：校验 →（必要时）安装 → 校验 → 生效
- `npm run setup -- --force`：强制重装
- `npm run setup:update`：按 `package.json` 重新解析版本并更新清单
- `npm run dev` / `npm run build` 前会自动做一次只读校验，不一致会提示先运行 `npm run setup`
