# FrameTrail

錄Chrome裡的點擊, 自動生成step-by-step教學(每步截圖+紅框標註+可編輯文字說明), 匯出圖片。個人用, 全部跑本機 — 無帳號、無雲端、無分享連結、無後端server。

架構跟關鍵技術決策見 [PLAN.md](./PLAN.md)。

## 專案結構

- `extension/` — Chrome MV3 extension (WXT + React + Tailwind + shadcn/ui)，功能完全在前端/本機完成。

## 功能

- **只記互動點擊**：content script會往上找最近「看起來可互動」的元素(button/a/input/role=button/cursor:pointer等), 點空白背景/純文字不會產生step。
- **標記為render-time合成**：DB只存原始截圖+點擊座標+實測截圖倍率, 紅框不烤進圖裡。popup/editor縮圖用CSS overlay即時畫框, 匯出時才用canvas合成——之後想換顏色/樣式不用重錄。
- **兩種錄製模式**（可在popup「開始錄製」前切換, 同一份紀錄裡可自由混用）：
  - **逐步模式**：每次點擊各自一張截圖+一個紅框(預設)。
  - **單張圖模式**：一次錄製過程中的所有點擊都疊標在同一張截圖上, 每個紅框可選擇是否加上順序編號(紅色實心圓圈)。每次重新按「開始錄製」都會以當下畫面開一張新圖, 不會疊加到前一輪的舊圖上。
- **密集標註防碰撞**：相鄰元素會改用緊湊框、外移編號與引導線；實際元素重疊時會以定位點取代互相遮蔽的紅框。預覽與匯出的布局完全相同。
- **兩個UI介面**：popup(快速操作)跟獨立編輯分頁(popup裡點「在分頁中編輯」, 開`chrome-extension://<id>/editor.html`, 大縮圖+大textarea較好編輯)，共用同一套元件跟`useRecordingSession` hook。
- **重置**：清空目前session、停止錄製，重新開始。只有按「重置」才會清掉紀錄——換錄製模式、重新開始錄製都只是接著往同一份紀錄累加。
- **匯出圖片(ZIP)**：純前端合成(`OffscreenCanvas`)+打包(`fflate`), 逐步模式一步一張、單張圖模式每組合成一張, 給你原始素材自己排版。
- **點擊去重+導航攔截**：同元素400ms內重複點擊只記一次；點會導航離開的連結時，先截圖再導航，避免截到下一頁。
- **captureVisibleTab rate limit處理**：background佇列序列化+節流(600ms間隔)，遇到quota錯誤自動重試。

## 開發流程

1. Build/watch extension:

   ```bash
   cd extension && pnpm install && pnpm dev
   ```

   輸出到 `extension/.output/chrome-mv3`。

2. 載入Chrome:
   - 開 `chrome://extensions`
   - 開啟右上角「開發人員模式」
   - 點「載入未封裝項目」→ 選 `extension/.output/chrome-mv3`

3. 邊改邊測:
   - Popup/editor改動會自動熱重載。
   - Content script / background改動: 到 `chrome://extensions` 點該extension卡片的重新整理圖示, 再重新整理測試頁。
   - IndexedDB schema版本有變動時(見`extension/lib/db.ts`的`openDB`版號), 建議先按popup裡的「重置」清掉舊資料再重錄, 避免欄位對不上。

## 手動端到端測試

1. 開任一測試頁 (例如 `https://example.com`, 或有幾個按鈕/連結的頁面)。
2. 點extension圖示 → popup開啟 → 選**逐步模式** → **開始錄製**。
3. 在頁面上點幾個不同元素 — 包含：
   - 至少一個故意選畫面外的, 驗證scroll-into-view補救機制。
   - 點空白背景/純文字區域, 確認不會產生多餘step。
   - 快速連點同一個按鈕兩三下, 確認只記一步(400ms去重)。
   - 一個會導航到別的網址的連結, 確認截圖是導航前的畫面(不是下一頁)。
4. **停止錄製**（逐步模式停止後會自動開編輯器）。
5. 檢查step列表(popup或「編輯器」都可以):
   - 每張縮圖紅框有沒有框到正確元素、圓角/padding對不對。
   - 自動生成的描述文字合不合理。
   - 編輯描述(textarea失焦後)有沒有存住。
   - 刪除一則step會不會正確移除。
   - 拖曳或上下箭頭排序會不會更新順序。
6. 回popup選**單張圖模式**（可切換「標記順序編號」）→ **開始錄製** → 點幾個不同元素 → **停止錄製**（此模式停止後不會自動開編輯器）。回編輯器確認：所有框都疊在同一張圖上、編號正確、可個別編輯/刪除/拖曳排序每個標註、可即時切換「標記順序編號」。
7. 再選**單張圖模式**重新「開始錄製」一次 → 確認是以目前畫面開一張全新的圖, 不會疊加到上一輪的舊圖。
8. 點**匯出圖片** → 確認下載`frame-trail-images-YYYY-MM-DD.zip`, 解壓後每張圖(含單張圖模式合成的那張)都有正確紅框標註。
9. 點**重置** → 確認錄製狀態跟step列表都清空。

## 已知限制 (設計如此, 非bug)

- **截圖只能截可視區域。** `chrome.tabs.captureVisibleTab` 只能截目前可視tab渲染的畫面 — 沒有API能讓一般extension截整頁。點擊元素在畫面外時, content script會先捲動讓它進入畫面再截圖, 所以截到的畫面不會完全等於使用者點擊當下實際看到的畫面。
- **`captureVisibleTab` 有rate limit** (Chrome限制大約每秒2次呼叫)。background用佇列序列化+節流處理, 遇到quota錯誤會自動重試, 但快速連點時仍可能有些微延遲。
- **部分頁面無法錄製。** Chrome原生擋掉任何extension對Chrome線上應用程式商店、`chrome://`等內部頁面的script注入/截圖, 這是平台限制。popup會顯示對應錯誤訊息。
- 無帳號、無雲端儲存、無分享連結、無多人協作、無全頁截圖拼接 — 這些都超出這個個人用clone的範圍。
- 步驟描述用簡單樣板生成 (`Click "<元素文字>"`), 不是LLM — 對核心流程夠用。
