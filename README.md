# FrameTrail

FrameTrail 是一個在瀏覽器內錄製操作並產生逐步圖片教學的擴充功能。每個步驟包含原始截圖、紅框標註與可編輯說明；可在本機作品庫管理多份教學，並發佈成 Markdown、HTML、列印用 HTML／PDF、富文字剪貼簿或圖片 ZIP。所有資料都留在本機，不需要帳號、雲端服務或後端伺服器。

完整架構與技術決策見 [PLAN.md](./PLAN.md)。

## 專案結構

- `extension/`：以 WXT、React、Tailwind CSS 與 shadcn/ui 建立的瀏覽器擴充功能。
- `README.md`：使用方式、開發流程、驗證項目與已知限制。
- `PLAN.md`：資料流、模組邊界、演算法與平台決策。

## 主要功能

### 錄製模式

- **操作流程**（內部值 `steps`）：游標滑過任意可見元素時先顯示預覽框，每次選取都建立一張截圖與一個標註。content script 會在 `pointerdown` 同步攔截原始 gesture 並隱藏預覽，等待兩個 paint frame 後才截圖，避免把 hover 樣式烤進底圖；互動控制項優先於內層文字或圖示。截圖尚未真正完成前，預覽不會重新出現，重播的 `element.click()` 也一定排在截圖之後，因此不會拍到點擊後或帶預覽框的畫面；截圖期間會鎖住捲動位置，讓儲存的座標與截圖像素一致。原始滑鼠 gesture 只是被延後重播，捲動、拖曳與瀏覽器捲軸都維持可用；落在捲軸溝槽的 `pointerdown` 會被忽略，不攔截也不記錄。背景截圖若異常卡住，failsafe 會在時限後照常重播點擊以維持頁面可用，但該步驟會被捨棄。
- **單頁標註**（內部值 `snapshot`）：錄製啟動時只建立一張底圖，游標滑過任意可見元素時先顯示預覽框，之後的選取只在同一張圖新增座標；上下方向鍵可在游標下的父子層級間切換。成功選取後紅框會持續顯示；同一 DOM 節點、穩定元素路徑或視覺框不會重複加入。
- 同一個 session 可以混用兩種模式；每次重新啟動快照錄製都會建立新的快照群組，不會沿用上一輪底圖。只有「重置」會清除整個 session。
- Popup 只負責選擇模式、是否顯示順序編號與跨頁權限。開始後由頁面右下控制器顯示本輪計數；操作流程可暫停／繼續，兩種模式都可復原上一筆、在 5 秒內還原並完成錄製。
- 完成後會開啟或聚焦單一 Editor tab，並自動選中本輪最新步驟或快照群組。錄製控制器、hover preview 與 shield UI 都會在截圖前隱藏，不會出現在成品中。

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
- 完全相同的幾何先以雜湊合併；其餘候選使用自適應掃描軸與 union-find 找出高度重疊群組。靠近的框只縮減朝向鄰居那一側的 padding；若相鄰控制項的原始 hit area 已部分重疊，則沿交集中央分隔並把相向框線收進 hit area，其餘方向仍維持完整外框。
- 重疊群組改畫定位點，並依目標分布選擇水平或垂直的單側編號 lane。徽章沿 lane 保持目標順序，以最短距離配置並用直線連回定位點；一般情況不會交叉，也會透過空間索引避開框、定位點與其他徽章。
- 單一 lane 容量不足時才改用確定性的多欄網格；即使 1,000 個分散或完全重疊的元素，仍保證輸出有限數值、徽章位於 viewport 內且流程可完成。viewport 的物理空間不足時不承諾完全無重疊。

### 編輯、儲存與匯出

- popup 提供錄製前設定與錄製中摘要；頁面浮動控制器負責錄製中的復原、暫停與完成。獨立編輯器採左側 `StepRail` 加全尺寸 `StepStage`，可快速切換步驟、編輯說明、刪除、複製圖片與拖曳排序。
- **作品庫與多份 Guide**：作品庫可搜尋、新增、改名、複製、封存、永久刪除、匯出或匯入可編輯備份。Editor URL 的 `sessionId` 是唯一資料來源；網址缺少或 Guide 不存在時會安全顯示錯誤，不會 fallback 到其他正在錄製的內容。
- **多選、批次與章節**：StepRail 提供 checkbox、Ctrl／Cmd 加選、Shift 範圍選取、Ctrl／Cmd+A 與 Escape 收合；可批次刪除、移到開頭／結尾、複製目前項目、切換快照編號，並在完整步驟或快照群組邊界建立、改名、刪除章節。多選期間停用單筆編輯與拖曳，避免操作目標含糊。
- **指定位置補錄與區域擷取**：可在任一步驟或完整快照群組前後補錄，也可在操作流程模式手動拖曳擷取 viewport 內區域；兩者都沿用 token-auth shield、capture queue、run/session guard，且不重播區域擷取手勢。
- 拖曳使用 `@dnd-kit`，只由拖曳把手啟動，支援滑鼠、觸控與鍵盤。UI 先做 optimistic reorder，再以單一 IndexedDB transaction 持久化，失敗時復原；不同高度的列只做 translate，不會被縮放閃動。
- 圖片 Blob 在狀態更新時保留穩定參照，rail、stage 與 lightbox 共用同一個 object URL；最後一個使用者卸載後才 revoke，避免非圖片變更觸發重新解碼與白閃。
- 刪除步驟、刪除快照群組與重置都使用共用的 shadcn `ConfirmationDialog`。專案不使用 `window.alert()` 或 `window.confirm()`；非阻斷錯誤則顯示在既有 shadcn Alert 區域。
- 標注說明區使用一致的細型滾動條樣式；所有可操作按鈕、圖片、切換器與拖曳把手都有對應的 pointer、zoom 或 grab 游標。
- Lightbox 使用 shadcn Dialog，可用按鈕或方向鍵跨步驟模式與快照模式連續瀏覽。
- **手動修正框選／補拍**：Editor 的「修正／遮罩」可用滑鼠、觸控或鍵盤調整框選，支援拖曳、8 個縮放控制點、CSS px 精確輸入、方向鍵、Undo/Redo 與還原自動框選。修改以非破壞性的 `manualBounds` 保存，不會覆寫錄製時的原始 bounds。
- **補拍步驟**：普通步驟可從 Editor 回到原始 URL 重新框選並以原子交易替換圖片；單頁快照只有在恰好一個標註時允許補拍，避免其他標註座標失效。補拍會驗證來源分頁、視窗、URL、runId 與權限，並在 MV3 service worker 重啟後從 durable state 恢復或安全結束。
- **敏感資訊遮罩**：在同一個視覺編輯器新增、移動、縮放或刪除完全不透明的 solid mask。遮罩只保存在圖片 owner（普通步驟或快照 anchor），預覽、Lightbox、剪貼簿 PNG 與 ZIP/JPEG 匯出共用同一條合成管線，並在所有標註與引導線之後繪製，避免下層內容重新露出。
- **隱私 fail-closed**：補拍含有既有遮罩的圖片，或讀到格式錯誤的隱私 metadata 時，會保留可修正的遮罩草稿並標記「需要重新確認」；確認前圖片預覽全黑，複製與匯出被阻擋，compositor 也會再次全黑處理。只有使用者按下「確認並儲存」後才解除封鎖。
- 發佈前會執行品質檢查；未確認遮罩、缺圖或缺少框選時 fail-closed 並導向問題清單。Markdown、HTML、列印用 HTML／PDF、富文字剪貼簿與 ZIP 全部共用 `compositeStepEntry`，依序合成長 Guide、完整 escaping，且會 revoke 暫用 Blob URL。可編輯 `.frametrail` v2 備份另包含標題、說明與章節；因備份保留未遮罩原圖，匯出前會明確警告。

### 狀態與效能

- IndexedDB 保存 Guide metadata、章節、截圖與步驟；`chrome.storage.local` 只保存錄製狀態與獨立的目前 Guide selection。快照 annotation 只引用持有共用 Blob 的 anchor，不重複保存圖片。
- START、STOP、RESET、點擊 transaction、截圖 queue 與 DB 寫入都有序列化邊界。`runId` 與 `controlVersion` 會使舊錄製的延遲工作失效，避免舊資料寫進新 session。
- `captureVisibleTab` 至少間隔 500 ms，quota 錯誤最多重試 5 次並逐步延長等待；每次真正截圖前都重新驗證作用中分頁、URL 與錄製 run。
- 錄製期間以 keep-alive port 維持 MV3 service worker；補拍的 capture replacement、result handoff 與 ACK 也使用 durable state，避免 worker 暫停造成半完成狀態。
- 編輯與補拍使用 `captureRevision` compare-and-set；Guide 結構操作另使用 `contentRevision` CAS 與單一 `guides + steps` transaction。stale reorder／delete／restore／move／duplicate／numbering／section mutation 會整筆 rollback，不會把省略的舊 row 默默 append。React 端會消除過期的非同步讀取、保留未變更物件，並只在錄製期間輪詢 IndexedDB。
- StepRail 縮圖使用 `IntersectionObserver`、320px 預載範圍、`content-visibility` 與 lazy Blob URL mounting；只有 active 或接近 viewport 的圖片才進入解碼管線。首次使用提供版本化 onboarding，並可開啟完全本機、無網路傳輸的練習頁。

## 編輯與隱私工作流程

### 修正框選

1. 在 Editor 選取步驟或快照群組，按「修正／遮罩」。
2. 選取「調整框選」，直接拖曳框、拖曳 8 個控制點，或在右側輸入 X、Y、寬、高（CSS px）。
3. 可使用方向鍵每次移動 1 px，`Shift` 加速為 10 px；`Ctrl/Cmd+Z`、`Ctrl/Cmd+Y` 可 Undo/Redo。
4. 「還原自動框選」會移除手動覆寫，恢復錄製時偵測到的 bounds。
5. 按「儲存修改」後才寫入 IndexedDB；離開有未儲存變更的編輯器會先顯示可存取的確認對話框。

### 補拍

1. 在普通步驟按「補拍」，FrameTrail 會回到來源頁面並顯示一次性補拍控制。
2. 在來源頁面選取目標後，系統先截圖、驗證來源與版本，再以單一 IndexedDB transaction 替換圖片與 bounds。
3. 原有說明、排序、步驟 ID 與錄製 provenance 會保留；原有手動框選會清除，原有遮罩則保留為待確認草稿。
4. 多標註快照不直接補拍，請重新製作整張快照；這是避免新底圖與其他座標錯配的安全限制。

### 敏感資訊遮罩

1. 在「修正／遮罩」選擇「加入遮罩」，框住帳號、姓名、Token、地址或其他不應出現在輸出的區域。
2. 遮罩使用完全不透明色塊，且會向外擴 2 CSS px，降低抗鋸齒或邊界像素殘留風險。
3. 只有確認遮罩後才可預覽、複製或匯出；補拍後若圖片曾有遮罩，必須重新檢查遮罩是否仍對準敏感內容。
4. 原始截圖仍以本機 IndexedDB 保存；遮罩保護的是所有對外輸出的 render path，不代表原始資料已被刪除。

## 權限

必要權限為 `storage`、`unlimitedStorage`、`activeTab`、`scripting`、`downloads` 與 `clipboardWrite`。預設以 `activeTab` 錄製目前頁面；只有使用者主動開啟「跨頁錄製」時才請求 `<all_urls>` optional host permission，用於跨網域導航與子 frame 注入。拒絕時仍可錄製目前頂層頁面，但無法存取的子 frame 只會標註外框。

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
pnpm test:e2e
pnpm test:all
pnpm compile
pnpm build
pnpm build:firefox
pnpm zip
pnpm zip:firefox
```

## 驗證基準

Vitest unit/integration 與 Playwright Chromium E2E 測試套件會隨功能演進調整；請以各指令當次輸出確認實際執行範圍。E2E 與 Firefox build 仍須在具備完整 pnpm／瀏覽器環境時執行，且不應以本文件視為其驗證結果。測試分層與放置規則見 [extension/tests/README.md](./extension/tests/README.md)。

Unit 與 integration 覆蓋：

- 快照啟動 READY gate、事件隔離、十字準星、hover 背壓、父子候選切換、同元素/同框去重與錄影 overlay 清理。
- 一般文字與容器、open/slotted shadow root、disabled/inert、ARIA、SVG、canvas、custom element 與各種 image map。
- 同來源、跨來源、巢狀、旋轉與斜切 iframe，以及不可存取 frame 的 timeout fallback。
- 1,000 個分散標註與 1,000 個重疊標註的有界布局。
- browser API mock 邊界、編輯器資料 transaction、object URL 共用與匯出資源清理。
- 手動框選的幾何 clamp、8 向 resize、Undo/Redo、精確輸入與 dirty-close；補拍來源信任、單例快照限制、durable recovery、原子替換與 capture revision conflict。
- 遮罩的驗證、2 CSS px 外擴、預覽／Clipboard／ZIP render propagation、補拍後 privacy review gate，以及 malformed metadata 的 fail-closed 行為。

Chromium E2E 覆蓋：

- production extension 的步驟/快照預覽、一般元素與控制項選取、原頁事件重播、快照輸入隔離、父子候選與去重。
- 跨來源與巢狀 iframe 座標、無 probe frame 的 timeout fallback、步驟導覽後重新注入、快照導覽停止與空 anchor 清除。
- popup 模式與編號設定、START/STOP、開啟 editor，以及 editor 說明、標注、兩層拖曳、Lightbox、Clipboard PNG、ZIP/JPEG、刪除與重置。

## 手動端到端測試

1. 載入開發版，在一般網站選「操作流程」並開始錄製。
2. 將游標移到按鈕、連結、表單控制、純文字、圖片、一般容器、disabled/inert、open shadow DOM 與多行 inline 元素；確認都先顯示預覽框，選取後產生步驟，互動目標使用「點擊」描述，其餘使用「標記」。
3. 點擊會導覽的連結，確認保存的是導覽前畫面，完成後頁面互動才被重播。
4. 從頁面控制器測試暫停、繼續、復原與還原，再按「完成」；確認 Editor 自動開啟並選中最新步驟。
5. 測試說明 autosave、拖曳、刪除還原、複製、Lightbox 與 ZIP 匯出取消／成功摘要；再以 320px 與 768px 寬度確認底部 StepRail、圖片及標註面板不重疊或水平溢出。
6. 選「單頁標註」並開始錄製；在開始按鈕完成後立刻操作頁面，確認原頁面 handler、導覽、表單、捲動與拖放都不會觸發。
7. 移到按鈕、文字、標題、圖片與一般容器，確認即時預覽與 crosshair 游標；用上下方向鍵切換父子層級，點選後確認正式標註持續顯示，再點同一元素或同框元素確認不會重複新增。
8. 從 shield 內控制器測試復原、還原與「完成快照」，確認 Editor 自動定位到該群組。
9. 測試密集相鄰元素、同位置元素、iframe 內元素、SVG、canvas、custom element 與 image map；完成後確認頁面 overlay 全部消失。
10. 重新開始快照錄製，確認建立新底圖而不是接續舊群組；改變 viewport、捲動位置或導覽時，確認系統拒絕把新座標寫到舊底圖。
11. 測試刪除單一步驟與整個快照群組，確認會直接刪除並可在 5 秒內還原；重置整個 session 才顯示 shadcn Dialog，且不出現瀏覽器原生 alert/confirm。
12. 在 Editor 開啟「修正／遮罩」，測試拖曳、8 個控制點、X/Y/寬/高輸入、方向鍵、Shift 加速、Undo/Redo、還原自動框選與未儲存離開確認。
13. 對普通步驟補拍；再對含多個標註的快照嘗試補拍，確認前者原子替換、後者明確拒絕且不破壞資料。
14. 新增遮罩後檢查 Editor、Lightbox、Clipboard PNG 與 ZIP/JPEG 都覆蓋敏感資訊；補拍含既有遮罩的圖片後，確認預覽全黑且必須重新確認才可複製／匯出。

## 已知限制

- `captureVisibleTab` 只能取得目前可視區域，無法直接取得整頁。步驟模式會把畫面外元素捲入 viewport 後截圖，並在截圖完成、重播點擊前把捲動位置還原到使用者原本所在，因此不再殘留位移。
- 步驟模式重播的 click 不是 trusted event。一般控制項與 SPA handler 可正常運作，但檔案選擇器、部分剪貼簿、全螢幕或其他要求即時 user activation 的 API 可能拒絕執行。
- 快照 shield 隔離的是使用者輸入，不是停用 JavaScript 引擎。頁面的 timer、網路回應、動畫或程式性 DOM 更新仍可能改變畫面；iframe 取得焦點也可能產生 `focus`/`blur`。導覽會停止該次快照錄製，viewport、捲動位置或 DPR 改變則會拒絕新增標註。
- closed shadow root 無法從外部檢查，會退回其可見 host；canvas 內部物件沒有 DOM 語意，因此只能標註整個 canvas。`pointer-events: none` 元素與 pseudo-element 不會成為一般 DOM hit-test 目標；非矩形 clip-path 與圓形/多邊形 image-map 最終以矩形 bounding box 表示。
- 未取得跨來源 frame 權限、子 frame 未載入探測器或探測逾時時，只能標註 iframe 可見外框。
- 極端密度下若 viewport 連一個徽章都放不下，或標註數超過幾何上可用槽位，位置會確定性重用，無法保證完全不重疊；演算法仍保證不產生無限值、不無限搜尋，也不讓工作量失控。
- Chrome Web Store、`chrome://`、`edge://`、`about:` 與其他瀏覽器受限頁面禁止擴充功能注入或截圖。
- 原始截圖會留在本機 IndexedDB；敏感資訊遮罩是輸出保護，不是安全刪除或加密儲存。若裝置或瀏覽器 profile 本身遭到入侵，FrameTrail 無法保護本機原始資料。
- 大量 4K/8K 步驟目前只使用 `loading=lazy`、`decoding=async` 與共享 Blob URL，尚未導入完整 list virtualization 或專用低解析 thumbnail；大量長錄製仍可能有記憶體與解碼壓力。
- 真實 Chrome MV3 worker 重啟、權限提示、clipboard、4K/8K ZIP、fractional DPR、320×480、鍵盤／螢幕閱讀器與高對比模式仍需實機驗收。
- 無帳號、雲端儲存、分享連結、多人協作、全頁拼接、PDF 匯出與 AI 描述；互動步驟使用 `點擊 <元素文字>`，一般元素步驟與快照標記使用 `標記 <元素文字>`。
