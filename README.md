# Shadowmoon Rename

> 批量改名，先看再改

批量改名最大的风险是不可逆。所以这里永远是先预览、再执行。

属于 **Shadowmoon** 桌面应用家族。每个应用都能单独使用，接入协作总线后可与其它应用联动 ——
散是满天星，聚是一个整体。

## 功能

- 模式命名（前缀、序号、日期等）
- 查找替换，支持正则
- 执行前完整预览，确认无误才落盘
- 排序编号，冲突自动检测

## 技术栈

- **外壳**：Tauri 2（Windows 原生窗口 + WebView2）
- **前端**：React 19 + TypeScript + Vite
- **后端**：Rust

## 开发

```bash
npm install

npm run dev        # 前端开发服务器，默认 http://localhost:1427
npm run tauri dev  # 启动桌面外壳（会自己拉起上面的 dev server）
```

后端测试：

```bash
cd src-tauri
cargo test
```

## 打包

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/` 下（NSIS 安装包）。

## 许可

[MIT](LICENSE)
