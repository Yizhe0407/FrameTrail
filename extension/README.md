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

## 本機 UX 與資料安全

- 作品庫可管理多份 Guide；Editor 只讀取 URL 指定 Guide，不會追隨或顯示其他全域錄製內容。
- 多選、批次、章節與 Undo 使用 `contentRevision` CAS；完整 StepEntry／Snapshot group 於單一 IndexedDB transaction 更新。
- 發佈支援 Markdown、HTML、列印/PDF、rich clipboard 與 ZIP，公開圖片統一走遮罩 fail-closed compositor。
- `.frametrail` 是包含原始未遮罩圖的可編輯本機備份，不應當作公開輸出。
- 首次導覽、練習頁、搜尋、品質篩選與縮圖 lazy mounting 均不需要網路或後端。

## 驗證

```bash
pnpm test
pnpm test:e2e
pnpm test:all
pnpm compile
pnpm build
pnpm build:firefox
```

- `pnpm test:unit`：執行目前的 unit 測試檔。
- `pnpm test:integration`：執行目前的 integration 測試檔。
- `pnpm test`：執行目前設定的 Vitest unit/integration 測試套件。
- `pnpm test:e2e`：建立 Chrome MV3 production 版本並執行目前設定的 Playwright Chromium E2E 測試套件。
- `pnpm test:all`：依序執行 Vitest 與 Chromium E2E。
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
