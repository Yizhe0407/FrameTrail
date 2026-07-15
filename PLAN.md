# FrameTrail — Chrome Extension (本機, 無後端)

## Context

FrameTrail 錄操作步驟並自動生成教學圖片，免費、個人用、完全在本機執行。需求已確認: Chrome extension (MV3) 形態、個人用/本機儲存 (無帳號/無雲端/無分享連結)、React+Vite 前端。原本有一個Node+Express後端只做PDF排版匯出, 後來決定拿掉PDF匯出這個功能, 現在整個工具純前端/本機, 只匯出標註後的圖片(ZIP)。

## 架構總覽

```
frame-trail/
└── extension/          # Chrome MV3 extension, WXT + React
    └── entrypoints/
        ├── background.ts       # service worker: 錄製狀態、訊息路由、screenshot queue、OffscreenCanvas畫紅框
        ├── content.ts          # inject 進頁面, 抓click事件+selector+bounding rect
        ├── popup/              # React UI: 開始/停止/模式切換/步驟列表/匯出
        └── editor/              # 獨立編輯分頁: 大縮圖+可編輯文字+拖曳排序
    └── lib/db.ts               # IndexedDB (idb套件) 存step資料
```

## 關鍵技術決策

1. **Screenshot**: `chrome.tabs.captureVisibleTab` — 唯一可行API, 但**只能截可視區域**。點擊元素在畫面外時, content script先 `scrollIntoView({block:'center'})` + `requestAnimationFrame` 等一幀再通知background截圖。這是已知限制, README要寫清楚。

2. **標註合成 (紅框畫在截圖上)**: **render-time合成**, 不烤進原始截圖。popup/editor縮圖用CSS overlay即時畫框(`HighlightThumbnail`/`MultiHighlightThumbnail`); 真正輸出檔案時用 **`OffscreenCanvas`** 合成(`lib/annotate.ts`的`compositeHighlight`/`compositeMultiHighlight`)。流程: `fetch(screenshotDataUrl) → blob → createImageBitmap(blob) → ctx.drawImage() → ctx.strokeRect()/ctx.arc() (依devicePixelRatio縮放) → canvas.convertToBlob()`。

3. **儲存**: **IndexedDB (`idb`套件)** 存step本體 (screenshot Blob + description + order + url), 不要用 `chrome.storage.local` 存大圖 (base64膨脹33%+序列化效能差)。`chrome.storage.local` 只存小狀態 (`isRecording`, `sessionId`, 錄製模式等) 給popup/background快速同步用。

4. **建置工具/框架**: **WXT** (Vite底層, file-based entrypoint慣例, HMR最好, 維護活躍) 搭 React — 2026首選。WXT 內建 background/content/popup entrypoint + `browser.*` API 包裝, 省手搓 manifest。

5. **兩種錄製模式 + 混合資料模型**: 逐步模式(每click一張截圖+一框, `Step.groupId`為undefined)跟單張圖模式(一次錄製過程所有click疊標在同一張共用截圖上, 這些step共享同一個`groupId`——即該組錨點step自己的id, 錨點`bounds=null`只負責持有共用screenshotBlob)。一個session可以自由混用兩種——`lib/db.ts`的`buildStepEntries()`把扁平的step清單依`groupId`切回一串可渲染的entry(單一step或整組), `flattenEntries()`負責攤平回DB要的id順序。**每次「開始錄製」都重設`RecordingState.groupAnchorId`為null**, 讓單張圖模式的下一輪錄製永遠從當下畫面開一張新圖, 不會疊加到前一輪的舊圖。**只有按「重置」才清掉session**——換模式或重新開始錄製都是接著同一個sessionId累加, 不會讓舊資料在編輯器裡消失。

6. **匯出**: 只有**匯出圖片(ZIP)**, 純前端合成(`lib/export-images.ts`)+打包(`fflate`), 不需要任何server。逐步模式一個entry一張圖, 單張圖模式每組合成一張(所有框+可選的順序編號疊在一起)。

## 核心檔案

- `extension/entrypoints/background.ts` — 錄製狀態機、承接content點擊訊息、呼叫`captureVisibleTab`(注意rate limit,一次一個排隊)、單張圖模式的錨點截圖/共用邏輯、寫入IndexedDB
- `extension/entrypoints/content.ts` — capture-phase click listener, 抓CSS selector/XPath/rect/文字(innerText/aria-label/title/alt), sendMessage給background。錄製開始時才用`browser.scripting.executeScript`注入(不要全站常駐)
- `extension/lib/db.ts` — idb wrapper: getSteps/addStep/updateStep/deleteStep/reorder + `buildStepEntries`/`flattenEntries`/`countSteps`(混合資料模型的核心)
- `extension/lib/annotate.ts` — `compositeHighlight`(單框)/`compositeMultiHighlight`(多框+可選編號徽章), 兩種匯出路徑共用同一份標註邏輯
- `extension/entrypoints/popup/App.tsx` + `entrypoints/editor/App.tsx` + `components/{RecordControls,StepList,StepItem,StepGroupBlock,HighlightThumbnail,MultiHighlightThumbnail,ExportImagesButton}.tsx` — 純React state, 讀IndexedDB, 縮圖+可編輯文字+刪除+拖曳排序(原生HTML5 drag, 不用額外套件)
- `extension/wxt.config.ts` — manifest permissions: `storage, unlimitedStorage, activeTab, scripting, downloads`

## Scope 邊界 (MVP不做)

無帳號/登入、無雲端資料庫、無分享連結、無多人協作、無全頁截圖拼接、無AI生成描述(用簡單樣板 `Click "${text||tagName}"` 就好)、無PDF匯出(只匯出圖片)。

## 驗證方式 (end-to-end手動測試)

1. `cd extension && pnpm dev`, chrome://extensions 載入unpacked
2. 開測試頁, popup選逐步模式點「開始錄製」
3. 點3-4個元素(混合畫面內+故意一個畫面外的, 驗證scrollIntoView補救)
4. 「停止錄製」(逐步模式會自動開編輯器), 檢視step列表: 縮圖紅框位置對不對、自動描述合理、手動編輯一則、刪除一則、拖曳排序兩則
5. 回popup選單張圖模式「開始錄製」, 點幾個元素, 「停止錄製」(不會自動開編輯器)。編輯器裡確認所有框疊在同一張圖上、編號正確、可個別編輯/刪除/拖曳排序、可即時切換「標記順序編號」
6. 再選單張圖模式重新開始錄製一次, 確認是以當下畫面開新圖, 沒有疊加到上一輪舊圖
7. 點「匯出圖片」→ 確認下載ZIP、解壓後每張圖(含單張圖模式合成的那張)標註都正確
