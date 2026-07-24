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
- 單筆步驟、章節與 Undo 使用 `contentRevision` CAS；完整 StepEntry／Snapshot group 於單一 IndexedDB transaction 更新。
- 發佈支援 Markdown、HTML、列印/PDF、rich clipboard 與 ZIP，公開圖片統一走遮罩 fail-closed compositor。
- `.frametrail` 是包含原始未遮罩圖的可編輯本機備份，不應當作公開輸出。
- 首次導覽、練習頁與縮圖 lazy mounting 均不需要網路或後端。

## 原始碼分類

- `components/editor/`：Editor 畫面與編輯工作流元件。
- `components/popup/`：Popup 專用的錄製、匯出與 onboarding 元件。
- `components/recording/`：注入頁面或 snapshot shield 使用的錄製 UI。
- `components/shared/`：跨入口共用元件；`components/ui/` 保留無領域狀態的 UI primitives。
- `lib/capture/`：DOM 候選、座標、frame probe 與擷取流程。
- `lib/editor/`、`lib/export/`、`lib/guide/`：各功能領域的純邏輯與 hooks。
- `lib/media/`：annotation layout、圖片標註與 screenshot 工具；`annotate.ts` 僅保留公開 facade。
- `lib/recording/`、`lib/runtime/`：錄製生命週期、queue、frame targeting，以及瀏覽器訊息／導覽邊界。
- `lib/storage/`：`models.ts` 定義持久化模型，`database.ts` 管理 schema／migration／transaction 基礎，`*-repository.ts` 與 `guide-structure.ts` 承擔各類讀寫；`storage.ts` 與 `persistence-limits.ts` 分別處理 extension storage 和容量限制。
- `lib/shared/`：僅放真正無領域狀態的工具。

新增檔案時應優先放入最接近的功能領域，內部程式碼也應直接 import 具體模組，以免隱藏依賴方向或形成循環引用。`lib/storage/db.ts` 是刻意保留的例外：它以明確 named exports 提供既有 storage API 的相容 facade，讓入口點、呼叫端與 Vitest mocks 可逐步遷移；新實作不應再放進 facade。

## 驗證

```bash
pnpm test
pnpm test:e2e
pnpm test:all
pnpm compile
pnpm validate:architecture
pnpm build
pnpm build:firefox
```

- `pnpm test:unit`：執行目前的 unit 測試檔。
- `pnpm test:integration`：執行目前的 integration 測試檔。
- `pnpm test`：執行目前設定的 Vitest unit/integration 測試套件。
- `pnpm test:e2e`：建立 Chrome MV3 production 版本並執行目前設定的 Playwright Chromium E2E 測試套件。
- `pnpm test:all`：依序執行 Vitest 與 Chromium E2E。
- `pnpm compile`：執行 TypeScript `tsc --noEmit`。
- `pnpm validate:architecture`：檢查 alias import cycle 與 `shared`、`ui`、storage model 的依賴邊界；CI 在 compile 後也會執行這個檢查。
- `pnpm build`：建立 Chrome MV3 production 版本到 `.output/chrome-mv3`。
- `pnpm build:firefox`：建立 Firefox MV2 production 版本到 `.output/firefox-mv2`。


## 模組結構

- `lib/export/project-archive.ts` 是 archive 的穩定公開入口；contract、validation、serialization 與 import codec 已拆為獨立檔案。
- `lib/media/annotation-layout.ts` 是 annotation layout facade；純幾何、badge/callout collision placement、常數與型別分別位於相鄰的 `annotation-*.ts` 模組。
- `lib/editor/use-editor-entry-workspace.ts` 封裝 Editor 的完整項目列表、單一目前項目與 view state；儲存、permission 與 undo transaction 仍由 `editor/App.tsx` 協調。
- `lib/recording/background/recorder-runtime.ts` 提供 background state machine 使用的瀏覽器 capture/injection adapter，讓 retry 與 image scale 判定可獨立測試與重用。

## 封裝

```bash
pnpm zip
pnpm zip:firefox
```

擴充功能不需要啟動任何後端伺服器；錄製資料、圖片合成與 ZIP 匯出都在本機完成。
E2E 所需的 fixture server 由 Playwright 自動啟停，測試架構詳見 [tests/README.md](./tests/README.md)。
