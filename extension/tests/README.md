# 測試架構

測試依照「實際跨越的系統邊界」分層，而不是依照被測檔案所在目錄分類：

```text
tests/
├── unit/                  # 純函式、幾何、狀態機與資料正規化
├── integration/           # IndexedDB、React、DOM overlay 與 browser API 邊界
└── e2e/
    ├── fixtures/
    │   ├── server.mjs     # 本機 HTTP fixture server
    │   └── site/          # 錄製目標頁、frame 與導覽頁
    ├── setup/
    │   └── global-setup.ts
    ├── specs/             # 使用者工作流
    └── support/           # Playwright fixtures、路徑與共用操作
```

## 分層規則

- `unit/`：不掛載 React、不開 IndexedDB、不啟動瀏覽器；輸入與輸出可完全由函式參數判定。
- `integration/`：驗證同一程序內的多模組合作，例如 fake IndexedDB、jsdom、React hooks、overlay 與 mock browser API。
- `e2e/`：載入未 mock 的 Chrome MV3 production build，驗證 background、content script、storage、真實截圖、popup、editor、Clipboard 與 Downloads API 的完整流程。
- 同一行為若可在較低層可靠證明，就放在較低層；只有跨 extension context、瀏覽器權限或使用者工作流才升到 E2E。

## 指令

```bash
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm test:all
```

`pnpm test` 會一次執行 unit 與 integration。`pnpm test:e2e` 會先建立 production extension，再由 Playwright 啟動 fixture server 與 Chromium。

## E2E 隔離

- 每項測試使用獨立的 Chromium profile，測試前清除 extension storage 與 IndexedDB。
- E2E 專用 extension 複本位於 `.output/e2e-chrome-mv3`；production manifest 不會被修改。
- E2E 複本預先授予 `<all_urls>`，避免權限提示干擾自動化；另只在該複本加入 `clipboardRead`，用來讀回並驗證 production UI 寫入的 PNG。
- 測試固定單 worker 執行，避免 `activeTab`、`captureVisibleTab` quota 與系統剪貼簿互相干擾。
- 失敗時保存 trace、頁面截圖與 console error；成功案例不保留大型 artifact。

目前 5 個 E2E spec 共 20 項：步驟錄製 4、快照錄製 2、frame/lifecycle 5、popup 2、editor 7。
