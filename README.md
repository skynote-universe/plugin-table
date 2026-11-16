# SkyNote 内容表格

把计划、说明和对照信息放进画布中的表格，与其他画布元素一起组织内容。

[免费在线体验](https://playground.skynote.top/?example=table-plan) · [功能文档](https://docs.skynote.top/plugins/table)

## 主要能力

- 编辑单元格内容和样式，合并与拆分单元格。
- 选择、增删和重排行列，调整行高和列宽。
- 分别设置主题色和网格框线，支持经典网格、简洁横线和三线表。

## 源码开发

包名为 `@skynote-pro/plugin-table`。当前通过 pnpm 工作区解析 SkyNote 基础 SDK 依赖，公共 npm 暂无安装入口。宿主可以用 `createPlugins()` 装配插件。

在新工作区中装配基础 SDK，再将本插件检出到 `pro/plugin-table`。

```sh
git clone https://github.com/skynote-universe/skynote.git
cd skynote
node scripts/bootstrap.mjs
git clone --branch main https://github.com/skynote-universe/plugin-table.git pro/plugin-table
pnpm install --no-frozen-lockfile
pnpm --filter @skynote-pro/plugin-table typecheck
pnpm --filter @skynote-pro/plugin-table test
```

工作区使用 Node.js 22.12 或更高版本和 pnpm 10.12.4。加入插件后，安装会更新本地锁文件，以记录额外的工作区包。

## 参与贡献

欢迎提交 PR。请阅读[许可证第 7 条](./LICENSE)，并在 PR 模板中勾选确认。直接提交者在开通写权限前书面确认。

## 许可证

[SkyNote 高级插件源码可见许可证 1.0](./LICENSE)
