# FrameTrail 擴充功能

這個目錄包含 FrameTrail 的 WXT + React 瀏覽器擴充功能。完整功能、權限、手動測試與已知限制請見 [專案 README](../README.md)，架構與演算法請見 [PLAN.md](../PLAN.md)。

## 環境

- Node.js
- pnpm

## 開發

```bash
pnpm install
pnpm dev
```

Chrome 開發輸出位於 `.output/chrome-mv3-dev`。在 `chrome://extensions` 啟用開發人員模式後，以「載入未封裝項目」載入該目錄。

Firefox 開發模式：

```bash
pnpm dev:firefox
```

## 驗證

```bash
pnpm test
pnpm compile
pnpm build
pnpm build:firefox
```

- `pnpm test`：執行 17 個 Vitest 測試檔、64 項測試。
- `pnpm compile`：執行 TypeScript `tsc --noEmit`。
- `pnpm build`：建立 Chrome MV3 production 版本到 `.output/chrome-mv3`。
- `pnpm build:firefox`：建立 Firefox MV2 production 版本到 `.output/firefox-mv2`。

## 封裝

```bash
pnpm zip
pnpm zip:firefox
```

擴充功能不需要啟動任何後端伺服器；錄製資料、圖片合成與 ZIP 匯出都在本機完成。
