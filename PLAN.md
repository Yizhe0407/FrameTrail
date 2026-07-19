# FrameTrail 架構與技術決策

## 產品範圍

FrameTrail 是完全在瀏覽器與本機執行的操作錄製工具。它提供 Chrome MV3 與 Firefox MV2 build，使用 WXT、React、Tailwind CSS 與 shadcn/ui，將逐步或單圖多標註的結果保存到 IndexedDB，最後匯出圖片 ZIP。專案沒有後端、帳號、雲端同步、分享連結、PDF 或 AI 描述服務。

## 架構總覽

```text
frame-trail/
└── extension/
    ├── entrypoints/
    │   ├── background.ts          # 錄製狀態機、READY gate、截圖與寫入佇列
    │   ├── content.ts             # 頂層錄製器、元素解析、子 frame probe
    │   ├── snapshot-shield/       # extension-origin iframe 與錄影中 overlay
    │   ├── popup/                 # 錄製控制與快速檢視
    │   └── editor/                # StepRail + StepStage 編輯器
    ├── components/                # 共用編輯、預覽、拖曳與 Dialog 元件
    ├── components/ui/             # shadcn button/dialog/textarea 等 primitives
    ├── lib/
    │   ├── annotate.ts            # 多標註純幾何布局與 canvas 合成
    │   ├── db.ts                  # IndexedDB schema、transaction 與 entry model
    │   ├── selector-utils.ts      # 互動元素、可見範圍與穩定 identity
    │   ├── frame-geometry.ts      # iframe/replaced element 仿射座標映射
    │   ├── frame-probe.ts         # frame probe 結果與 timeout fallback 規則
    │   ├── image-geometry.ts      # image-map/object-fit 座標映射
    │   ├── recorder-injection.ts  # top/all-frame 注入與降級
    │   ├── recorder-ready.ts      # run/tab/controlVersion READY gate
    │   ├── snapshot-shield.ts     # shield host、通道與生命週期
    │   ├── recording-guards.ts    # 截圖、導覽與 viewport 不變量
    │   ├── useObjectUrl.ts        # Blob object URL 共享與回收
    │   └── useRecordingSession.ts # popup/editor 狀態協調
    ├── tests/
    │   ├── unit/                  # 純函式、幾何與狀態機
    │   ├── integration/           # IndexedDB、React、DOM 與 API 邊界
    │   └── e2e/                   # production extension 的 Chromium 工作流
    ├── vitest.config.ts           # unit/integration 範圍與 alias
    ├── playwright.config.ts       # E2E server、artifact 與執行隔離
    └── wxt.config.ts              # manifest、權限與跨瀏覽器 build
```

## 錄製資料流

### 步驟模式

1. popup 發送 `START_RECORDING`，background 建立新的 `runId` 與 `controlVersion`。
2. background 只向頂層 frame 注入 content script，並等待該實例回報 `FRAME_TRAIL_READY`。
3. content script 將 `pointermove` 以 rAF 合併，透過 closed shadow overlay 預覽共用的可見目標；在 capture phase 的 `pointerdown` 同步攔截 gesture 並隱藏預覽，等待兩個 paint frame、確認 compositor 不再包含 hover 樣式後才截圖。候選從命中元素與 composed ancestors 解析，語意控制項優先，一般元素則保留最深可見候選。
4. background 將整個 click transaction 排入序列佇列，驗證 run、session、作用中分頁與 URL，再呼叫 `captureVisibleTab`。
5. Blob、實測 screenshot scale、bounds 與描述以一筆 IndexedDB transaction 保存；互動目標描述為「點擊」，其餘描述為「標記」。content script 完成後以 `element.click()` 重播原 gesture 對應的一般 click 行為。
6. 1.5 秒 follow-up timeout 會釋放卡住的 gesture；pointer cancel 會取消 replay。STOP、RESET 或新 START 則使舊 run 的延遲工作失效，不能回寫新的錄製狀態。

### 快照模式

1. background 嘗試向所有 frame 注入 content script；任何子 frame 拒絕注入時，至少保證頂層 recorder 可用。
2. 頂層 content script 建立 extension-origin iframe shield；子 frame 只安裝 probe listener。
3. shield 的私有通道、輸入攔截與 listener 完成後等待兩個 animation frame，再回報 READY。background 此時建立唯一底圖 anchor，START 才完成。
4. pointer move 經 rAF coalescing 與單一 in-flight request 傳入頂層 recorder。recorder 短暫停用 shield hit testing，從命中元素與 composed ancestors 建立視覺候選鏈，再回傳 hover bounds；上下方向鍵以 `candidateOffset` 切換父子候選。
5. pointerdown 只在成功保存 annotation 後 commit overlay。同一節點由 `WeakSet<Element>` 去重，同一邏輯路徑由跨 remount 的 identity `Set<string>` 去重，相同量化視覺框則由 rect key 去重。
6. STOP 移除 shield、frame probe、freeze listener 與 keep-alive；沒有 annotation 的空 anchor 會被刪除。導覽會 fail closed 並停止快照 run。

## 關鍵技術決策

### 1. READY gate 先於可互動狀態

`RecorderReadyGate` 必須同時匹配 `runId`、`tabId` 與 `controlVersion`。popup 的 START promise 在 recorder listener 和快照 shield 真正就緒前不會完成；5 秒內未就緒則停止錄製並顯示錯誤。這消除「剛開始錄影時前幾次點擊仍進入頁面 JavaScript」的競態。

### 2. 快照模式隔離 input，而不是嘗試停用頁面 JavaScript

content script 的 capture listener 無法保證先於頁面既有的 window listener，因此快照模式使用不同 browsing context 的透明 iframe 接收事件。closed shadow host、popover top layer、modal reparent 與 `!important` inline styles 降低頁面 CSS/DOM 干擾；token 驗證的 `MessageChannel` 取代公開的 window message channel。頁面 timer 或網路更新仍會執行，這是刻意保留的平台邊界。

### 3. 底圖只截一次，overlay 不參與資料來源

快照底圖在 START 階段、任何 annotation 可接受前建立。後續點擊只寫入座標並更新 iframe 內的 SVG overlay，不再逐次截圖、隱藏/顯示整頁或更換 image URL。STOP 一次移除 overlay。這同時解決錄影紅框重疊失真、每次點擊閃白與不必要的截圖成本。

### 4. 目標解析以語意與可見性為優先

兩種模式都從最深命中節點沿 `assignedSlot`、open shadow root 與 host 建立 composed ancestor 候選鏈。native、ARIA role、handler/editable、focusable、cursor 五種互動層級優先於內層 icon 或文字；沒有互動語意時則選最深可見元素。disabled、inert 與 ARIA disabled 仍可標記，但意圖分類為 `mark`；快照模式另外允許使用者切換到不同視覺框的父子候選。

兩種模式都排除 hidden、transparent、`display: contents` 與 zero-area 節點，並將 bounds 裁到 viewport、overflow、scrollport、paint containment 與實際 inline fragment。純裝飾 SVG geometry 會提升到可框選容器；canvas、custom element 與一般文字/圖片本身都可成為目標。

### 5. iframe 與 image map 使用結構化座標映射

快照 recorder 透過每一層 frame 的 `MessageChannel` probe 取得子 frame 目標，再逐層映射回頂層 viewport。`frame-geometry.ts` 優先使用 `getBoxQuads()` 的實際 affine basis，否則使用 DOMMatrix 加 observed bounding box，最後才使用 axis-aligned rect；所有路徑都包含 iframe border，並拒絕退化矩陣。

每層 probe 預留 20 ms 子層 budget，整體 timeout 為 120 ms。回應 `null` 代表該座標沒有目標，不可誤退回 iframe；只有 transport timeout 或注入失敗才退回 iframe 外框，且同一 frame 2 秒內不重試，避免 hover 熱路徑持續耗時。

image map 使用瀏覽器 DOM API 解析 `area`，透過 `image-geometry.ts` 將 intrinsic coordinates 映射到 border、padding、`object-fit`、`object-position` 與 transform 後的實際 painted content；不以 selector/XPath 或字串猜測幾何。

### 6. 同一純幾何布局供所有渲染端使用

`layoutAnnotations()` 只依賴 annotation bounds、order 與 viewport，不讀取圖片像素。錄影 overlay、React 預覽、Clipboard 與 ZIP canvas 使用同一組 layout 結果，因此不會出現「錄影時重疊、編輯器正常」的兩套算法漂移。

布局管線：

1. 以完整 rect key 在 O(n) 時間合併完全相同幾何。
2. 依 X/Y congestion 選較不擁擠的掃描軸，只比較鄰近候選，再用 union-find 合併 intersection/min-area 大於 0.4 的群組。
3. 對非群組框批次計算 `adaptivePaddings()`，維持框間可見間距。
4. 群組改成 marker + side-lane badge；lane 可跨多欄，badge 與 obstacle 使用固定 cell 的空間索引。
5. 100 個以內的群組使用 Liang-Barsky 障礙檢查與 sibling crossing 檢查選擇正交或最少碰撞路徑；更大群組使用直接 leader，將最壞工作量限制在可預測範圍。
6. viewport 實際槽位不足時使用確定性網格 fallback，仍保證 finite、viewport-contained 與終止，不宣稱物理上不可能的零重疊。

### 7. render-time 合成與共享 Blob identity

DB 不保存烤入紅框的圖片。單一步驟與快照 anchor 保存原始 Blob，快照 annotation 只保存 `groupId` 與 bounds。`getOrderedAnnotations()` 是預覽、複製與匯出的共同資料契約，會忽略損壞的 legacy bounds。

IndexedDB 每次讀取可能產生新的 Blob wrapper；`reconcileSteps()` 會在圖片未變時保留原 wrapper，`useObjectUrl()` 再以 WeakMap 讓 rail、stage 和 lightbox 共用 URL。刪除、說明更新、拖曳與輪詢不會讓圖片重新 decode，因此不產生白閃。

### 8. 編輯操作使用 optimistic UI 與原子 transaction

編輯器以 `StepRail` 管理 timeline，以 `StepStage` 顯示目前步驟。拖曳只從 handle 啟動，使用 `CSS.Translate` 避免 dnd-kit scale 壓縮不同高度的列；前端先更新順序，DB 失敗才復原。

`reorderSteps()` 會保留 stale UI 未看見的新步驟，`deleteStepsAndReorder()` 在同一 transaction 中刪除並關閉 order gap，避免半個快照群組被刪除。所有破壞性操作共用 shadcn `ConfirmationDialog`，不允許 `window.alert()` 或 `window.confirm()`。

### 9. 截圖 queue 與狀態不變量

`captureVisibleTab` 只能截目前視窗的 active tab，background 因此在每次呼叫和每次 quota retry 前都驗證：controlVersion 未變、run/session 相符、目標 tab 仍 active、URL 未變。呼叫至少間隔 500 ms，quota 錯誤最多重試 5 次。

快照 annotation 另外要求 viewport width/height、scroll position 與 DPR 和 anchor 一致，只容忍 subpixel scroll noise。START、STOP、RESET、state mutation、click transaction 與 capture 各有清楚的序列化 barrier；MV3 service worker 在錄製期間由 20 秒 heartbeat port 維持。

### 10. 本機資料與最小權限

大圖存 IndexedDB；`chrome.storage.local` 只存 `isRecording`、`sessionId`、mode、run 與小型狀態。manifest 必要權限為 `storage`、`unlimitedStorage`、`activeTab`、`scripting`、`downloads`、`clipboardWrite`；`<all_urls>` 保持 optional，只有使用者開始錄製時才請求。WXT manifest hook 會移除誤推導的 required host permission，並為 Firefox MV2 改寫 optional permission。

## 核心檔案責任

- `extension/entrypoints/background.ts`：錄製狀態機、控制版本、READY gate、導航處理、截圖與 click queue、快照 anchor、IndexedDB 寫入、keep-alive。
- `extension/entrypoints/content.ts`：步驟 gesture 與預覽排程、快照 hit testing、元素描述、去重、frame probe、捲動補救、清理與 READY 回報。訊息不再保存 CSS selector 或 XPath。
- `extension/lib/step-preview.ts`：步驟模式的 closed shadow、click-through、top-layer hover 預覽與生命週期。
- `extension/entrypoints/snapshot-shield/`：輸入攔截、hover backpressure、pointer/default cursor、即時預覽、正式 SVG overlay 與 resize relayout。
- `extension/lib/snapshot-shield.ts`、`snapshot-shield-protocol.ts`：host/top-layer 管理、ready timeout、tokenized channel、protocol validation 與 committed selection replay。
- `extension/lib/selector-utils.ts`：共用視覺候選、互動語意、open shadow traversal、可見 bounds、stable snapshot identity。
- `extension/lib/frame-geometry.ts`、`frame-probe.ts`、`image-geometry.ts`、`recorder-injection.ts`：極端 frame/replaced-element 幾何、timeout 語意與注入 fallback。
- `extension/lib/annotate.ts`：純布局、空間索引、極端密度 fallback，以及單框/多框 OffscreenCanvas 合成。
- `extension/lib/db.ts`：v3 schema、混合 `StepEntry` 模型、legacy salvage、原子刪除/排序與 annotation 契約。
- `extension/lib/useRecordingSession.ts`、`useObjectUrl.ts`：競態保護、資料 reconciliation、輪詢與圖片 URL 生命週期。
- `extension/components/`：StepRail、StepStage、AnnotationList、StepActions、Lightbox、SortableItem、ConfirmationDialog 與共用預覽。

## 驗證

```bash
cd extension
pnpm test
pnpm test:e2e
pnpm test:all
pnpm compile
pnpm build
pnpm build:firefox
```

目前基準為 17 個 Vitest 測試檔、64 項 unit/integration，加上 5 個 Playwright spec、18 項 Chromium E2E，TypeScript compile、Chrome MV3 build 與 Firefox MV2 build 皆通過。Unit/integration 覆蓋：

- run/active-tab/URL/viewport guard、READY gate 與 recorder injection fallback。
- IndexedDB concurrency、stale reorder、原子刪除與快照 Blob 去重。
- 兩模式共用的一般可見元素、父子候選切換、open/slotted shadow、ARIA、disabled/inert、SVG、clipping、穩定 identity。
- iframe affine transform、nested probe timeout 與 image-map object-fit/rotation。
- 1,000 個分散或重疊 annotation、狹小 viewport 與四位數 badge。
- shield protocol、hover/click 隔離、object URL sharing、拖曳與匯出資源清理。

Chromium E2E 另以 production extension 驗證兩種錄製模式的 preview/commit、一般元素與 disabled/SVG/canvas、互動重播、輸入隔離與去重；跨來源/nested frame、無 probe fallback 與兩模式導覽生命週期；popup 控制，以及 editor 的說明、標注、timeline/annotation 拖曳、Lightbox、Clipboard PNG、ZIP/JPEG、刪除與重置。

## 設計限制

- 僅能擷取可視 viewport；沒有全頁拼接。
- 步驟模式的 replay click 不具 trusted user activation。
- 快照模式不停止頁面自己的 JavaScript、動畫或網路更新。
- closed shadow root 與 canvas 內部沒有可存取的 DOM 目標，只能標註 host/canvas；`pointer-events: none` 與 pseudo-element 不會成為一般 DOM hit-test 目標。
- 不可存取或逾時的 iframe 只能標註可見外框。
- 非矩形目標最後以矩形 bounds 儲存；槽位不足的極端密度無法保證視覺零重疊。
- 瀏覽器內部頁面與商店頁面禁止 script injection/capture。
