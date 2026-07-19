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
pnpm test:e2e
pnpm test:all
pnpm compile
pnpm build
pnpm build:firefox
```

- `pnpm test:unit`：執行 15 個 unit 測試檔、89 項測試。
- `pnpm test:integration`：執行 12 個 integration 測試檔、35 項測試。
- `pnpm test`：一次執行上述 27 個 Vitest 測試檔、124 項測試。
- `pnpm test:e2e`：建立 Chrome MV3 production 版本並執行 6 個 Playwright spec、34 項 Chromium E2E。
- `pnpm test:all`：依序執行 124 項 Vitest 與 34 項 E2E。
- `pnpm compile`：執行 TypeScript `tsc --noEmit`。
- `pnpm build`：建立 Chrome MV3 production 版本到 `.output/chrome-mv3`。
- `pnpm build:firefox`：建立 Firefox MV2 production 版本到 `.output/firefox-mv2`。

## 封裝

```bash
pnpm zip
pnpm zip:firefox
```

擴充功能不需要啟動任何後端伺服器；錄製資料、圖片合成與 ZIP 匯出都在本機完成。
E2E 所需的 fixture server 由 Playwright 自動啟停，測試架構詳見 [tests/README.md](./tests/README.md)。
