# 前端文案精簡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除 FrameTrail 產品前端所有使用者可見的「教學」字樣，並依語境改成「作品」、「內容」或精簡動詞。

**Architecture:** 僅調整既有字串常數與 JSX 文案，不新增抽象層，也不改變資料模型或流程。共用預設名稱由 `UNTITLED_GUIDE_BASE` 統一控制；背景程序與共用操作層只修改可能傳回前端的訊息。

**Tech Stack:** React、TypeScript、Vitest、Testing Library、Playwright、WXT

## Global Constraints

- 所有產品前端中使用者可見的「教學」字樣都必須移除。
- 作品庫使用「作品」，編輯器與內容狀態使用「內容」，可省略受詞的操作只保留動詞。
- 不修改使用者既有資料、README、開發文件、程式註解與純測試樣本資料。
- 不變更資料模型、API、流程、版面或元件行為。
- 保留工作區所有既有未提交修改，只做逐字最小差異。

---

### Task 1: 鎖定使用者可見文案契約

**Files:**
- Modify: `extension/tests/integration/LibraryApp.test.tsx`
- Modify: `extension/tests/integration/OnboardingDialog.test.tsx`
- Modify: `extension/tests/integration/PublishGuideDialog.test.tsx`
- Modify: `extension/tests/integration/EditorAppStructure.test.tsx`
- Modify: `extension/tests/integration/record-controls-new-guide.test.tsx`
- Modify: `extension/tests/setup/editor-app-mocks.ts`
- Modify: `extension/tests/e2e/specs/editor-workflows.spec.ts`
- Modify: `extension/tests/e2e/specs/popup-workflows.spec.ts`

**Interfaces:**
- Consumes: 現有 React 元件的可見文字、accessible name 與 `UNTITLED_GUIDE_BASE` 測試 mock。
- Produces: 新文案的測試契約，不新增函式或型別。

- [ ] **Step 1: 更新會直接斷言產品文案的測試**

```tsx
expect(screen.getAllByRole('button', { name: '新增' })[0]).toBeDisabled();
expect(screen.getByRole('heading', { name: '三步完成一份操作說明' })).toBeTruthy();
expect(screen.getByText('「未命名作品」')).toBeTruthy();
expect(await screen.findByRole('heading', { name: '找不到這份內容' })).toBeTruthy();
```

同時將測試 mock 的 `UNTITLED_GUIDE_BASE` 改為 `未命名作品`，並把「每次錄製都會建立新教學」的斷言改為「每次錄製都會建立新作品」。使用者自行命名為「安全教學」等測試資料不修改，因為那代表允許的既有使用者資料。

- [ ] **Step 2: 執行相關測試並確認因舊文案而失敗**

Run: `cd extension && pnpm vitest run tests/integration/LibraryApp.test.tsx tests/integration/OnboardingDialog.test.tsx tests/integration/PublishGuideDialog.test.tsx tests/integration/EditorAppStructure.test.tsx tests/integration/record-controls-new-guide.test.tsx`

Expected: FAIL，差異指向仍存在的「新增教學」、「三步完成一份教學」、「未命名教學」或「找不到這份教學」。

---

### Task 2: 精簡產品前端與回傳訊息

**Files:**
- Modify: `extension/entrypoints/library/App.tsx`
- Modify: `extension/entrypoints/editor/App.tsx`
- Modify: `extension/components/popup/RecordControls.tsx`
- Modify: `extension/components/popup/OnboardingDialog.tsx`
- Modify: `extension/components/editor/StepStage.tsx`
- Modify: `extension/components/editor/TagSelectDialog.tsx`
- Modify: `extension/components/editor/PublishGuideDialog.tsx`
- Modify: `extension/components/editor/use-guide-mutations.ts`
- Modify: `extension/components/shared/ResetButton.tsx`
- Modify: `extension/lib/storage/models.ts`
- Modify: `extension/lib/runtime/actions.ts`
- Modify: `extension/lib/guide/guide-actions.ts`
- Modify: `extension/lib/recording/background/editor-open.ts`
- Modify: `extension/lib/recording/background/source-tab.ts`
- Modify: `extension/entrypoints/background.ts`
- Modify: `extension/public/_locales/zh_TW/messages.json`

**Interfaces:**
- Consumes: `UNTITLED_GUIDE_BASE: string`、現有錯誤結果與 React props。
- Produces: 相同型別與控制流程的新文案；`UNTITLED_GUIDE_BASE` 值為 `未命名作品`。

- [ ] **Step 1: 套用逐字最小替換**

```ts
export const UNTITLED_GUIDE_BASE = '未命名作品';
```

主要替換規則：

```text
新增教學 -> 新增
N 份教學 -> N 份作品
建立第一份教學 -> 建立第一份作品
教學名稱 -> 作品名稱
尚未加入教學說明 -> 尚未加入作品說明
未命名教學 -> 未命名作品
找不到這份教學 -> 找不到這份內容
教學標題 -> 內容標題
教學內容 -> 內容
教學步驟 -> 操作步驟
三步完成一份教學 -> 三步完成一份操作說明
圖解教學 -> 圖解說明
```

「教學」預設標籤改成「說明」。`console.error` 文字也改為「內容匯出失敗」，避免產品執行期輸出殘留。其餘句子依相同語境順句，不直接刪字造成病句。

- [ ] **Step 2: 執行相關測試並確認通過**

Run: `cd extension && pnpm vitest run tests/integration/LibraryApp.test.tsx tests/integration/OnboardingDialog.test.tsx tests/integration/PublishGuideDialog.test.tsx tests/integration/EditorAppStructure.test.tsx tests/integration/record-controls-new-guide.test.tsx`

Expected: PASS。

- [ ] **Step 3: 執行前端殘留掃描**

Run: `rg -n '教學' extension --glob '!tests/**' --glob '!README.md' --glob '!pnpm-lock.yaml'`

Expected: 只允許不會顯示給使用者的程式註解；所有 JSX、訊息常數、locales 與預設名稱均無命中。

- [ ] **Step 4: 執行型別檢查與格式檢查**

Run: `cd extension && pnpm compile && pnpm lint`

Expected: 兩個命令皆成功結束。

- [ ] **Step 5: 檢查差異完整性**

Run: `git diff --check && git diff -- extension/entrypoints extension/components extension/lib extension/public extension/tests`

Expected: 無空白錯誤；差異只包含目標文案與其測試，既有未提交修改保持原樣。
