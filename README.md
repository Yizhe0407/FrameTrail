# FrameTrail

FrameTrail 是一個在瀏覽器內錄製操作並產生逐步圖片教學的擴充功能。每個步驟包含原始截圖、紅框標註與可編輯說明，也可以把結果匯出成 ZIP。所有資料都留在本機，不需要帳號、雲端服務或後端伺服器。

完整架構與技術決策見 [PLAN.md](./PLAN.md)。

## 專案結構

- `extension/`：以 WXT、React、Tailwind CSS 與 shadcn/ui 建立的瀏覽器擴充功能。
- `README.md`：使用方式、開發流程、驗證項目與已知限制。
- `PLAN.md`：資料流、模組邊界、演算法與平台決策。

## 主要功能

### 錄製模式

- **步驟模式**：游標滑過任意可見元素時先顯示預覽框，每次選取都建立一張截圖與一個標註。content script 會在 `pointerdown` 同步攔截原始 gesture 並隱藏預覽，等待兩個 paint frame 後才截圖，避免把 hover 樣式烤進底圖；互動控制項優先於內層文字或圖示。背景程序完成截圖與儲存後，再以 `element.click()` 重播一般按鈕、連結、委派事件與 SPA click handler。
- **快照模式**：錄製啟動時只建立一張底圖，游標滑過任意可見元素時先顯示預覽框，之後的選取只在同一張圖新增座標；上下方向鍵可在游標下的父子層級間切換。成功選取後紅框會持續顯示，停止錄製時一次清除；同一 DOM 節點、穩定元素路徑或視覺框不會重複加入。
- 同一個 session 可以混用兩種模式；每次重新啟動快照錄製都會建立新的快照群組，不會沿用上一輪底圖。只有「重置」會清除整個 session。

### 快照輸入隔離

- 快照模式使用 extension-origin 的全畫面透明 iframe 作為 input shield。滑鼠、觸控、鍵盤、滾輪與拖放事件終止在 iframe 內，不會進入原頁面的 window、document、目標元素或 default action。
- shield 透過 closed shadow root、私有 `MessageChannel` 與隨機 token 隔離通訊；偵測元素時只短暫關閉自身 hit testing，再以座標查詢下層頁面。
- 若頁面已有原生 modal dialog，shield 會掛到作用中的 modal 並進入 top layer，避免被 dialog backdrop 蓋住。
- 啟動流程有 READY gate：shield、事件監聽器與子 frame probe 全部就緒並穩定兩個 animation frame 後，背景程序才擷取快照底圖並完成「開始錄製」。早期點擊不會穿透到頁面 JavaScript。
- hover 探測使用 `requestAnimationFrame` 合併事件，而且同一時間最多只有一個請求在途；過期回應會被丟棄，避免快速移動滑鼠時堆積工作或顯示舊框。

### 元素與框選偵測

- 兩種模式都從座標命中的最深可見元素建立 composed ancestor 候選鏈，並辨識原生控制項、有效 ARIA role、click handler、可聚焦元素、contenteditable 與 `cursor: pointer`；語意控制項會優先於內層圖示或文字，一般文字、圖片與容器也能成為目標。
- 候選只按 DOM 深度處理，不掃描整份文件；相同視覺框會合併，純裝飾 SVG geometry 會提升到可框選的 SVG 容器。快照模式另外允許用上下方向鍵切換不同視覺框的父子候選。
- 支援 open shadow root、語意化 SVG、canvas、custom element 與 HTML image map。image map 支援 `rect`、`circle`、`poly`、`default`，並處理圖片 border、padding、`object-fit`、`object-position` 與 CSS transform。
- 兩種模式都能標記可見的 `disabled`、`inert` 與 `aria-disabled="true"` 元素，但會使用「標記」而不是「點擊」描述。隱藏、透明、`display: contents` 或零面積元素仍會排除；沒有 `href` 的連結與沒有對應控制項的 label 也可被標記。
- 多行 inline 元素會選擇點擊位置所在的 client rect，而不是整個文字 union；標註範圍也會裁切到 viewport、overflow scrollport、paint containment 與可見祖先範圍。
- 快照模式會把 content script 注入所有可存取 frame。巢狀與跨來源 iframe 透過有 timeout 的 `MessageChannel` 遞迴探測；`getBoxQuads()`、DOMMatrix 與 border-box fallback 負責縮放、旋轉、斜切、邊框與祖先 transform 的仿射座標轉換。子 frame 無法注入或 120 ms 內未回應時，會退回標註 iframe 的可見外框，不會阻塞整個錄製流程。

### 標註布局

- IndexedDB 只保存原始截圖與 CSS pixel 座標。popup、編輯器與錄影中預覽使用 overlay，複製與匯出時才以 canvas 合成，因此刪除、拖曳、複製或編輯文字不會重新載入圖片或造成畫面閃爍。
- `layoutAnnotations()` 是預覽、剪貼簿與匯出共用的純幾何函式，確保三條渲染路徑的框、徽章、定位點與引導線一致。
- 完全相同的幾何先以雜湊合併；其餘候選使用自適應掃描軸與 union-find 找出高度重疊群組。靠近但未重疊的框會個別縮減 padding，不讓紅框互相蓋住。
- 重疊群組改畫定位點，編號徽章配置到可用空間較多的一側。徽章會跨多欄配置，並以空間索引避開框、定位點與其他徽章；可行時使用不交叉的正交引導線。
- 演算法工作量有明確上限：超過 100 個同群標註時改用直接引導線，當 viewport 已沒有足夠的無碰撞槽位時才以確定性網格重用位置。即使 1,000 個分散或完全重疊的元素，仍保證輸出有限數值、徽章位於 viewport 內且流程可完成；物理空間不足時不承諾完全無重疊。

### 編輯、儲存與匯出

- popup 提供錄製控制；獨立編輯器採左側 `StepRail` 加全尺寸 `StepStage`，可快速切換步驟、編輯說明、刪除、複製圖片與拖曳排序。
- 拖曳使用 `@dnd-kit`，只由拖曳把手啟動，支援滑鼠、觸控與鍵盤。UI 先做 optimistic reorder，再以單一 IndexedDB transaction 持久化，失敗時復原；不同高度的列只做 translate，不會被縮放閃動。
- 圖片 Blob 在狀態更新時保留穩定參照，rail、stage 與 lightbox 共用同一個 object URL；最後一個使用者卸載後才 revoke，避免非圖片變更觸發重新解碼與白閃。
- 刪除步驟、刪除快照群組與重置都使用共用的 shadcn `ConfirmationDialog`。專案不使用 `window.alert()` 或 `window.confirm()`；非阻斷錯誤則顯示在既有 shadcn Alert 區域。
- 標注說明區使用一致的細型滾動條樣式；所有可操作按鈕、圖片、切換器與拖曳把手都有對應的 pointer、zoom 或 grab 游標。
- Lightbox 使用 shadcn Dialog，可用按鈕或方向鍵跨步驟模式與快照模式連續瀏覽。
- 匯出使用 `OffscreenCanvas` 合成並由 `fflate` 產生 ZIP；複製圖片走同一份合成邏輯與 Clipboard API。步驟模式一個步驟一張圖，快照模式一個群組一張圖。

### 狀態與效能

- IndexedDB 保存截圖與步驟；`chrome.storage.local` 只保存錄製狀態。快照 annotation 只引用持有共用 Blob 的 anchor，不重複保存圖片。
- START、STOP、RESET、點擊 transaction、截圖 queue 與 DB 寫入都有序列化邊界。`runId` 與 `controlVersion` 會使舊錄製的延遲工作失效，避免舊資料寫進新 session。
- `captureVisibleTab` 至少間隔 500 ms，quota 錯誤最多重試 5 次並逐步延長等待；每次真正截圖前都重新驗證作用中分頁、URL 與錄製 run。
- 錄製期間以 keep-alive port 維持 MV3 service worker。React 端會消除過期的非同步讀取、保留未變更物件，並只在錄製期間輪詢 IndexedDB。

## 權限

必要權限為 `storage`、`unlimitedStorage`、`activeTab`、`scripting`、`downloads` 與 `clipboardWrite`。`<all_urls>` 是按下「開始錄製」時才請求的 optional host permission，用於跨網域導航與子 frame 注入；拒絕時仍可利用 `activeTab` 錄製目前頂層頁面，但無法存取的子 frame 只會標註外框。

## 開發流程

需求：Node.js 與 pnpm。

```bash
cd extension
pnpm install
pnpm dev
```

- Chrome 開發輸出：`extension/.output/chrome-mv3-dev`
- Chrome production 輸出：`extension/.output/chrome-mv3`
- Firefox production 輸出：`extension/.output/firefox-mv2`

在 Chrome 開啟 `chrome://extensions`，啟用「開發人員模式」，選「載入未封裝項目」並載入 `extension/.output/chrome-mv3-dev`。修改 popup 或 editor 時 WXT 會熱重載；修改 content script 或 background 後，需重新載入擴充功能並重新整理測試頁。

常用指令：

```bash
cd extension
pnpm test
pnpm compile
pnpm build
pnpm build:firefox
pnpm zip
pnpm zip:firefox
```

## 驗證基準

目前基準包含 17 個 Vitest 測試檔、64 項測試，並通過 TypeScript 型別檢查、Chrome MV3 與 Firefox MV2 production build。自動測試與建置驗證範圍包括：

- 快照啟動 READY gate、事件隔離、十字準星、hover 背壓、父子候選切換、同元素/同框去重與錄影 overlay 清理。
- 一般文字與容器、open/slotted shadow root、disabled/inert、ARIA、SVG、canvas、custom element 與各種 image map。
- 同來源、跨來源、巢狀、旋轉與斜切 iframe，以及不可存取 frame 的 timeout fallback。
- 1,000 個分散標註與 1,000 個重疊標註的有界布局。
- 編輯器刪除、拖曳、複製、說明編輯與圖片導覽不閃爍；所有破壞性確認使用 shadcn Dialog。

## 手動端到端測試

1. 載入開發版，在一般網站選「步驟模式」並開始錄製。
2. 將游標移到按鈕、連結、表單控制、純文字、圖片、一般容器、disabled/inert、open shadow DOM 與多行 inline 元素；確認都先顯示預覽框，選取後產生步驟，互動目標使用「點擊」描述，其餘使用「標記」。
3. 點擊會導覽的連結，確認保存的是導覽前畫面，完成後頁面互動才被重播。
4. 停止錄製並開啟編輯器；測試說明編輯、拖曳、刪除、複製、Lightbox 與 ZIP 匯出，確認圖片不白閃且標註位置一致。
5. 選「快照模式」並開始錄製；在開始按鈕完成後立刻操作頁面，確認原頁面 handler、導覽、表單、捲動與拖放都不會觸發。
6. 移到按鈕、文字、標題、圖片與一般容器，確認即時預覽與 crosshair 游標；用上下方向鍵切換父子層級，點選後確認正式標註持續顯示，再點同一元素或同框元素確認不會重複新增。
7. 測試密集相鄰元素、同位置元素、iframe 內元素、SVG、canvas、custom element 與 image map；停止後確認頁面 overlay 全部消失。
8. 重新開始快照錄製，確認建立新底圖而不是接續舊群組；改變 viewport、捲動位置或導覽時，確認系統拒絕把新座標寫到舊底圖。
9. 測試刪除單一步驟、整個快照群組與重置，確認文字為「刪除」且只出現 shadcn Dialog，不出現瀏覽器原生 alert/confirm。

## 已知限制

- `captureVisibleTab` 只能取得目前可視區域，無法直接取得整頁。步驟模式可把畫面外元素捲入 viewport 後再截圖，因此結果可能和原本捲動位置不同。
- 步驟模式重播的 click 不是 trusted event。一般控制項與 SPA handler 可正常運作，但檔案選擇器、部分剪貼簿、全螢幕或其他要求即時 user activation 的 API 可能拒絕執行。
- 快照 shield 隔離的是使用者輸入，不是停用 JavaScript 引擎。頁面的 timer、網路回應、動畫或程式性 DOM 更新仍可能改變畫面；iframe 取得焦點也可能產生 `focus`/`blur`。導覽會停止該次快照錄製，viewport、捲動位置或 DPR 改變則會拒絕新增標註。
- closed shadow root 無法從外部檢查，會退回其可見 host；canvas 內部物件沒有 DOM 語意，因此只能標註整個 canvas。`pointer-events: none` 元素與 pseudo-element 不會成為一般 DOM hit-test 目標；非矩形 clip-path 與圓形/多邊形 image-map 最終以矩形 bounding box 表示。
- 未取得跨來源 frame 權限、子 frame 未載入探測器或探測逾時時，只能標註 iframe 可見外框。
- 極端密度下若 viewport 連一個徽章都放不下，或標註數超過幾何上可用槽位，位置會確定性重用，無法保證完全不重疊；演算法仍保證不產生無限值、不無限搜尋，也不讓工作量失控。
- Chrome Web Store、`chrome://`、`edge://`、`about:` 與其他瀏覽器受限頁面禁止擴充功能注入或截圖。
- 無帳號、雲端儲存、分享連結、多人協作、全頁拼接、PDF 匯出與 AI 描述；互動步驟使用 `點擊 <元素文字>`，一般元素步驟與快照標記使用 `標記 <元素文字>`。
