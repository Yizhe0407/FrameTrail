# FrameTrail — Chrome Extension (本機, 無後端)

## Context

FrameTrail 錄操作步驟並自動生成教學圖片，免費、個人用、完全在本機執行。需求已確認: Chrome extension (MV3) 形態、個人用/本機儲存 (無帳號/無雲端/無分享連結)、React+Vite 前端。原本有一個Node+Express後端只做PDF排版匯出, 後來決定拿掉PDF匯出這個功能, 現在整個工具純前端/本機, 只匯出標註後的圖片(ZIP)。

## 架構總覽

```
frame-trail/
└── extension/          # Chrome MV3 extension, WXT + React
    └── entrypoints/
        ├── background.ts       # service worker: 錄製狀態、訊息路由、screenshot queue、OffscreenCanvas畫紅框
        ├── content.ts          # inject 進頁面, 抓pointerdown事件+selector+bounding rect
        ├── popup/              # React UI: 開始/停止/模式切換/步驟列表/匯出
        └── editor/              # 獨立編輯分頁: 大縮圖+可編輯文字+拖曳排序
    └── lib/db.ts               # IndexedDB (idb套件) 存step資料
```

## 關鍵技術決策

1. **Screenshot時機**: 在`pointerdown`(capture階段)就截圖, 不是等`click`事件觸發、頁面反應完再截。這樣紅框永遠對應使用者按下當下的畫面, 不用等頁面重繪, 也不會被click後的頁面變化(選單展開、跳頁)污染截圖。`chrome.tabs.captureVisibleTab` 是唯一可行API, 但**只能截可視區域**。點擊元素在畫面外時, content script先 `scrollIntoView({block:'center', behavior:'instant'})` + `requestAnimationFrame` 等一幀、把pointer座標平移對應scroll位移量, 再重新量測bounds後通知background截圖。這是已知限制, README要寫清楚。

2. **標註合成 (紅框畫在截圖上)**: **render-time合成**, 不烤進原始截圖。popup/editor縮圖用CSS overlay即時畫框; 真正輸出檔案時用 **`OffscreenCanvas`** 合成(`lib/annotate.ts`的`compositeHighlight`/`compositeMultiHighlight`)。多框布局(快照模式)用`layoutAnnotations()`——一個純幾何函式, 只吃annotation座標+viewport尺寸, 不吃圖片: 用union-find把重疊比例(intersection/較小框面積)超過0.4的目標合併成「coincident group」, 組內每個目標只畫定位點(marker dot), 編號徽章移到側邊車道, 用避開障礙物(其他框/marker/徽章)+避免互相交叉的路徑連回定位點; 沒有被合併的目標各自保留完整紅框, 但padding是自適應的(`adaptivePadding`)——跟最近的鄰居框留出最小間距, 避免兩個靠很近但沒真的重疊的框視覺上黏在一起。因為整個布局只吃座標不吃像素, preview跟匯出的CSS overlay/canvas繪製保證幾何完全一致, 不需要像素取樣。

3. **儲存**: **IndexedDB (`idb`套件)** 存step本體 (screenshot Blob + description + order + url), 不要用 `chrome.storage.local` 存大圖 (base64膨脹33%+序列化效能差)。`chrome.storage.local` 只存小狀態 (`isRecording`, `sessionId`, 錄製模式等) 給popup/background快速同步用。

4. **建置工具/框架**: **WXT** (Vite底層, file-based entrypoint慣例, HMR最好, 維護活躍) 搭 React — 2026首選。WXT 內建 background/content/popup entrypoint + `browser.*` API 包裝, 省手搓 manifest。圖示統一用`lucide-react`。

5. **兩種錄製模式 + 混合資料模型**: 步驟模式(`'steps'`, 每click一張截圖+一框, `Step.groupId`為undefined)跟快照模式(`'snapshot'`, 一次錄製過程所有click疊標在同一張共用截圖上, 這些step共享同一個`groupId`——即該組錨點step自己的id, 錨點`bounds=null`只負責持有共用screenshotBlob)。快照模式錄製期間content script會攔截click/pointerdown/pointerup/mousedown/mouseup/dblclick/auxclick/submit(`preventDefault`+`stopImmediatePropagation`), 凍結頁面反應, 讓所有框都能安全疊在同一張錄製開始時截的screenshot上——代價是這段期間無法真的操作頁面(選單、跳頁等), 只能點擊產生標註。popup選擇快照模式時會顯示凍結提示。已知殘留限制: 這只擋得住DOM事件鏈, 擋不住跑在我們的listener之前的window層級擷取listener, 或計時器驅動的頁面邏輯。一個session可以自由混用兩種模式——`lib/db.ts`的`buildStepEntries()`把扁平的step清單依`groupId`切回一串可渲染的entry(單一step或整組), `flattenEntries()`負責攤平回DB要的id順序。**每次「開始錄製」都重設`RecordingState.groupAnchorId`為null**, 讓快照模式的下一輪錄製永遠從當下畫面開一張新圖, 不會疊加到前一輪的舊圖。**只有按「重置」才清掉session**——換模式或重新開始錄製都是接著同一個sessionId累加, 不會讓舊資料在編輯器裡消失。

6. **匯出**: 只有**匯出圖片(ZIP)**, 純前端合成(`lib/export-images.ts`)+打包(`fflate`), 不需要任何server。步驟模式一個entry一張圖, 快照模式每組合成一張(所有框+可選的順序編號疊在一起)。

9. **統一的放大檢視(Lightbox)**: 編輯分頁中`Lightbox.tsx`接收`StepEntry[]`資料, 使用者放大任何截圖後(單張步驟或快照合成圖皆可), 上一張/下一張按鈕與方向鍵可在所有entry間連續導覽——步驟模式的`HighlightThumbnail`與快照模式的`MultiHighlightThumbnail`共用同一個導覽序列。計數器顯示「N / 總數」。舊設計(快照組合圖獨立Dialog、Lightbox只限步驟)已移除。

7. **排序UI**: 用`@dnd-kit`(`core`+`sortable`+`utilities`)實作拖曳排序, 每列一個拖曳把手(`SortableItem`裡的`GripVertical`), 滑鼠拖曳跟鍵盤(`KeyboardSensor`)都支援, 沒有額外的上下移動按鈕。

8. **Service worker存活**: MV3的background在~30秒沒活動會被回收, 冷啟動會拖慢下一次截圖。錄製期間content script跟background之間開一條`runtime.connect`的keep-alive port, 每20秒送一次心跳訊息維持存活, 停止錄製時background會通知content script關閉這條port跟其監聽器。

## 核心檔案

- `extension/entrypoints/background.ts` — 錄製狀態機、承接content點擊訊息、呼叫`captureVisibleTab`(佇列序列化+節流, 至少間隔500ms, quota錯誤自動重試)、快照模式的錨點截圖/共用邏輯、寫入IndexedDB、keep-alive port監聽、截圖前確認分頁仍是作用中分頁(active-tab guard)
- `extension/entrypoints/content.ts` — capture階段`pointerdown`監聽(不是click), 抓CSS selector/XPath/rect/文字(innerText/aria-label/title/alt), 畫面外元素的scroll補救, 快照模式的事件凍結, keep-alive port連線, sendMessage給background。錄製開始時才用`browser.scripting.executeScript`注入(不要全站常駐)
- `extension/lib/db.ts` — idb wrapper: getSteps/addStep/updateStep/deleteStep/reorder + `buildStepEntries`/`flattenEntries`/`countSteps`(混合資料模型的核心)
- `extension/lib/annotate.ts` — `layoutAnnotations`(純幾何布局演算法, coincident group偵測+自適應padding+防交叉引導線) + `compositeHighlight`(單框)/`compositeMultiHighlight`(多框+可選編號徽章), 兩種匯出路徑共用同一份標註邏輯
- `extension/entrypoints/popup/App.tsx` + `entrypoints/editor/App.tsx` + `components/{RecordControls,StepList,StepItem,StepGroupBlock,Lightbox,SortableItem,HighlightThumbnail,MultiHighlightThumbnail,ExportImagesButton}.tsx` — 純React state, 讀IndexedDB, 縮圖+可編輯文字+刪除+`@dnd-kit`拖曳排序；`components/ui/{switch,separator,alert}.tsx` — shadcn/ui primitives (radix-ui既有依賴)
- `extension/wxt.config.ts` — manifest permissions: `storage, unlimitedStorage, activeTab, scripting, downloads`

## Scope 邊界 (MVP不做)

無帳號/登入、無雲端資料庫、無分享連結、無多人協作、無全頁截圖拼接、無AI生成描述(用簡單樣板 `點擊 ${text||tagName}` 就好)、無PDF匯出(只匯出圖片)。

## 驗證方式 (end-to-end手動測試)

1. `cd extension && pnpm dev`, chrome://extensions 載入unpacked
2. 開測試頁, popup選步驟模式點「開始錄製」
3. 點3-4個元素(混合畫面內+故意一個畫面外的, 驗證scrollIntoView補救)
4. 「停止錄製」(不會自動開編輯器, 手動點popup的「編輯器」按鈕), 檢視step列表: 縮圖紅框位置對不對、自動描述合理、手動編輯一則、刪除一則、拖曳把手排序兩則
5. 回popup選快照模式 → 確認出現凍結提示(Info圖示+文字) → 「開始錄製」, 點幾個元素, 確認頁面互動被凍結(例如點連結不會真的跳頁)。「停止錄製」。編輯器裡確認所有框疊在同一張圖上、編號正確、可個別編輯/刪除/拖曳排序、可即時切換「標記順序編號」
6. 再選快照模式重新開始錄製一次, 確認是以當下畫面開新圖, 沒有疊加到上一輪舊圖
7. 編輯器中點放大任一截圖(步驟或快照合成圖) → Lightbox開啟 → 用上一張/下一張按鈕或方向鍵確認可在所有entry間連續導覽 → 計數器顯示正確
8. 點「匯出圖片」→ 確認下載ZIP、解壓後每張圖(含快照模式合成的那張)標註都正確
