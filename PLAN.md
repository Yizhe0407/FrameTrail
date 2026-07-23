# FrameTrail 架構與技術決策

## 產品範圍

FrameTrail 是完全在瀏覽器與本機執行的操作錄製工具。它提供 Chrome MV3 與 Firefox MV2 build，使用 WXT、React、Tailwind CSS 與 shadcn/ui，將逐步或單圖多標註的結果保存到 IndexedDB，以多份 Guide 管理，並可發佈為 Markdown、HTML、列印用 HTML／PDF、富文字剪貼簿或圖片 ZIP。專案沒有後端、帳號、雲端同步、分享連結或 AI 描述服務。

## 架構總覽

```text
frame-trail/
└── extension/
    ├── entrypoints/
    │   ├── background.ts          # 錄製狀態機、READY gate、截圖與寫入佇列
    │   ├── content.ts             # 頂層錄製器、元素解析、子 frame probe
    │   ├── snapshot-shield/       # extension-origin iframe 與錄影中 overlay
    │   ├── popup/                 # 錄製控制與快速檢視
    │   ├── editor/                # StepRail + StepStage 編輯器
    │   ├── library/               # 本機 Guide 作品庫
    │   └── practice/              # 完全本機的練習頁
    ├── components/
    │   ├── editor/                # Editor 組合元件、預覽、拖曳與發佈 Dialog
    │   ├── popup/                 # Popup 的錄製、匯出與 onboarding 元件
    │   ├── recording/             # 注入頁面／shield 使用的錄製 overlay
    │   ├── shared/                # 跨入口共用的確認、空狀態與重置元件
    │   └── ui/                    # shadcn button/dialog/textarea 等 primitives
    ├── lib/
    │   ├── capture/               # DOM 候選、座標映射、frame probe 與擷取流程
    │   ├── editor/                # autosave、選取、拖曳與視覺編輯狀態
    │   ├── export/                # 公開輸出、下載、entry render 與專案封存
    │   ├── guide/                 # Guide 選取、章節與品質分析
    │   ├── media/                 # annotation layout、圖片標註合成與 screenshot 工具
    │   ├── recording/             # 錄製生命週期、queue、frame targeting、shield 與 session hook
    │   ├── runtime/               # 訊息契約、sender validation 與瀏覽器導覽
    │   ├── shared/                # 無領域狀態的 feature flags 與小型工具
    │   └── storage/               # 本機持久化領域
    │       ├── models.ts          # persisted models、validation 與 entry topology
    │       ├── database.ts        # IndexedDB schema、migration 與 transaction helpers
    │       ├── *-repository.ts    # Guide、Step 與插入錄製的資料操作
    │       ├── guide-structure.ts # timeline／section／annotation 原子結構修改
    │       ├── db.ts              # 舊 storage API 的明確相容 facade
    │       └── storage.ts         # browser extension storage
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

視覺編輯器以非破壞性 `manualBounds` 保存手動框選，提供拖曳、8 向 resize、CSS px 精確輸入、方向鍵與 Undo/Redo；未儲存離開使用同一套可存取的確認 dialog。遮罩以 owner-level `redactions` 保存，快照 annotation 不持有遮罩，避免同一張底圖出現多份隱私真相。

### 9. 截圖 queue 與狀態不變量

`captureVisibleTab` 只能截目前視窗的 active tab，background 因此在每次呼叫和每次 quota retry 前都驗證：controlVersion 未變、run/session 相符、目標 tab 仍 active、URL 未變。呼叫至少間隔 500 ms，quota 錯誤最多重試 5 次。

快照 annotation 另外要求 viewport width/height、scroll position 與 DPR 和 anchor 一致，只容忍 subpixel scroll noise。START、STOP、RESET、state mutation、click transaction 與 capture 各有清楚的序列化 barrier；MV3 service worker 在錄製期間由 20 秒 heartbeat port 維持。

補拍是獨立的一次性 operation：普通步驟可原子替換 capture-owned fields；快照只允許單一 annotation 的 singleton target，避免新底圖讓同群組其他座標失效。來源 tab/window/URL、sender、runId 與 controlVersion 全部驗證，補拍完成以 durable result handoff + ACK 回 editor；worker 中斷時依 persisted phase 恢復或 fail closed。圖片替換遞增 `captureRevision`，視覺編輯與 Undo 對隱私 owner 使用 compare-and-set，避免 stale draft 覆寫新圖片。

### 10. 隱私輸出與 fail-closed 合成

原始 screenshot Blob 保留在本機，遮罩只作為輸出層資料。`compositeRaster()` 固定依序繪製 raw screenshot、annotations，最後繪製完全不透明 redactions，並向外擴 2 CSS px；Preview、Lightbox、Clipboard PNG 與 ZIP/JPEG 都呼叫相同的 render path。若 metadata 不合法或補拍後需要 review，UI 會阻擋預覽／複製／匯出，compositor 再把整張 bitmap 填黑，形成雙層 fail-closed 防線。遮罩只由普通 step 或 snapshot anchor 擁有，且 malformed metadata 不會被靜默當成「沒有遮罩」。

### 11. 本機資料與最小權限

大圖存 IndexedDB；`chrome.storage.local` 只存 `isRecording`、`sessionId`、mode、run 與小型狀態。manifest 必要權限為 `storage`、`unlimitedStorage`、`activeTab`、`scripting`、`downloads`、`clipboardWrite`；`<all_urls>` 保持 optional，只有使用者開始錄製時才請求。WXT manifest hook 會移除誤推導的 required host permission，並為 Firefox MV2 改寫 optional permission。

### 12. Guide identity、selection 與 recording state 分離

Guide identity 由 Editor URL 與 `guides` store 決定；使用者目前選取的 Guide 與 singleton recording operation 分開保存。Editor 傳入明確 `sessionId` 時永遠不追隨全域錄製狀態，缺少或失效的 URL 也不 fallback，避免跨 Guide 洩漏或誤編輯。

### 13. 結構修改使用 fresh-read CAS transaction

完整 entry（普通步驟或不可拆的快照群組）是排序、刪除、移動、複製、編號與章節 boundary 的最小單位。每次結構操作先 flush 說明，再於同一 IndexedDB transaction fresh-read Guide 與 Steps，驗證 `contentRevision`、完整 topology、dense order 與 section boundary 後一次提交；stale 或 malformed 資料 fail-closed。Undo 只在 Guide、operation 與 revision 均未漂移時可用。

### 14. 發佈與可編輯備份是不同信任邊界

公開輸出必須通過 `assertPublicationReady()`，並一律走遮罩 fail-closed 的 `compositeStepEntry`。可編輯 `.frametrail` v2 備份使用 exact-key allowlist、大小／數量上限與 future-version reject，包含原始圖片及安全 metadata（標題、說明、章節），因此 UI 必須明示它不是可直接公開的成品。

## 核心檔案責任

- `extension/entrypoints/background.ts`：錄製狀態機、控制版本、READY gate、導航處理、快照 anchor、IndexedDB 寫入與 keep-alive；queue、capture throttle 與共用背景錯誤位於 `extension/lib/recording/background-queues.ts`。
- `extension/entrypoints/content.ts`：步驟 gesture、預覽排程、錄製生命週期、捲動補救、清理與 READY 回報；快照候選、元素描述、image-map／frame probe 與 keyboard candidates 位於 `extension/lib/recording/snapshot-targeting.ts`。訊息不再保存 CSS selector 或 XPath。
- `extension/lib/capture/step-preview.ts`：步驟模式的 closed shadow、click-through、top-layer hover 預覽與生命週期。
- `extension/entrypoints/snapshot-shield/`：輸入攔截、hover backpressure、pointer/default cursor、即時預覽、正式 SVG overlay 與 resize relayout。
- `extension/lib/recording/snapshot-shield.ts`、`extension/lib/recording/snapshot-shield-protocol.ts`：host/top-layer 管理、ready timeout、tokenized channel、protocol validation 與 committed selection replay。
- `extension/lib/capture/selector-utils.ts`：共用視覺候選、互動語意、open shadow traversal、可見 bounds、stable snapshot identity。
- `extension/lib/capture/frame-geometry.ts`、`extension/lib/capture/frame-probe.ts`、`extension/lib/capture/image-geometry.ts`、`extension/lib/recording/recorder-injection.ts`：極端 frame/replaced-element 幾何、timeout 語意與注入 fallback。
- `extension/lib/media/annotate.ts`：維持公開 annotation API facade。
- `extension/lib/media/annotation-layout.ts`：純布局、空間索引、極端密度 fallback 與 preview/export 共用的 annotation geometry。
- `extension/lib/media/annotation-composite.ts`：單框／多框 OffscreenCanvas 合成；最後階段繪製 opaque redaction 與 privacy block。
- `extension/lib/export/project-archive.ts`：project archive 的序列化／匯入公開 API；archive format、metadata、limits 與 wire schema 位於 `project-archive-contract.ts`。
- `extension/lib/export/entry-render.ts`：統一 Preview、Clipboard 與 ZIP 的 entry-level 合成契約。
- `extension/entrypoints/editor/App.tsx`：Editor controller 與畫面組合；Guide 載入生命週期位於 `lib/editor/use-editor-guide-data.ts`，selection／permission／undo 的純資料契約位於 `lib/editor/editor-app-model.ts`。
- `extension/lib/editor/visual-editing.ts`：手動框選／遮罩的 clamp、move、resize 與幾何純函式。
- `extension/lib/capture/recapture-guards.ts`：補拍來源 sender、URL、tab/window 與操作信任驗證。
- `extension/components/editor/VisualEditDialog.tsx`：手動框選、遮罩、精確輸入、Undo/Redo 與 privacy review gate。
- `extension/lib/storage/models.ts`、`extension/lib/guide/guide-section-model.ts`：Guide／章節、混合 `StepEntry`、visual metadata 與 storage validation；包含 entry topology、`manualBounds`、owner-level `redactions` 與 `captureRevision` 契約。
- `extension/lib/storage/database.ts`：v4 IndexedDB schema、legacy migration／salvage、連線生命週期、容量摘要與共用 transaction helpers。
- `extension/lib/storage/guide-repository.ts`、`extension/lib/storage/step-repository.ts`、`extension/lib/storage/insertion-repository.ts`：Guide／Step CRUD、補拍原子替換、visual conflict guard 與插入錄製 transaction。
- `extension/lib/storage/guide-structure.ts`：timeline、section 與 annotation 的 CAS、完整 topology 驗證及原子結構修改。
- `extension/lib/storage/db.ts`：只以明確 named exports 維持既有 storage API 與測試 mock 的相容邊界；schema、模型或資料操作實作不得放回 facade。
- `extension/lib/recording/useRecordingSession.ts`、`extension/lib/editor/useObjectUrl.ts`：競態保護、資料 reconciliation、輪詢與圖片 URL 生命週期。
- `extension/components/editor/`：StepRail、StepStage、AnnotationList、StepActions、Lightbox、SortableItem 與共用預覽；跨入口元件放在 `extension/components/shared/`。

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

Vitest unit/integration 與 Playwright Chromium E2E 測試套件會隨功能演進調整；請以各指令當次輸出確認實際執行範圍。Firefox build、完整 E2E 與 dependency audit 仍需在具備完整 pnpm／瀏覽器環境時執行，本文件不記錄其通過狀態。Unit/integration 覆蓋：

- run/active-tab/URL/viewport guard、READY gate 與 recorder injection fallback。
- IndexedDB concurrency、stale reorder、原子刪除與快照 Blob 去重。
- 兩模式共用的一般可見元素、父子候選切換、open/slotted shadow、ARIA、disabled/inert、SVG、clipping、穩定 identity。
- iframe affine transform、nested probe timeout 與 image-map object-fit/rotation。
- 1,000 個分散或重疊 annotation、狹小 viewport 與四位數 badge。
- shield protocol、hover/click 隔離、object URL sharing、拖曳與匯出資源清理。
- 視覺編輯器的 manual bounds、opaque redaction、geometry history、dirty-close；補拍的 target guard、singleton restriction、durable recovery、atomic replacement 與 capture revision CAS；輸出路徑 privacy propagation 與 malformed metadata fail-closed。

Chromium E2E 另以 production extension 驗證兩種錄製模式的 preview/commit、一般元素與 disabled/SVG/canvas、互動重播、輸入隔離與去重；跨來源/nested frame、無 probe fallback 與兩模式導覽生命週期；popup 控制，以及 editor 的說明、標注、timeline/annotation 拖曳、Lightbox、Clipboard PNG、ZIP/JPEG、刪除與重置。

## 設計限制

- 僅能擷取可視 viewport；沒有全頁拼接。
- 步驟模式的 replay click 不具 trusted user activation。
- 快照模式不停止頁面自己的 JavaScript、動畫或網路更新。
- closed shadow root 與 canvas 內部沒有可存取的 DOM 目標，只能標註 host/canvas；`pointer-events: none` 與 pseudo-element 不會成為一般 DOM hit-test 目標。
- 不可存取或逾時的 iframe 只能標註可見外框。
- 非矩形目標最後以矩形 bounds 儲存；槽位不足的極端密度無法保證視覺零重疊。
- 瀏覽器內部頁面與商店頁面禁止 script injection/capture。
- 原始截圖仍留在本機 IndexedDB；遮罩保護輸出，不是安全刪除或加密儲存。
- 大量 4K/8K 步驟目前尚未做完整 list virtualization 或低解析 thumbnail，長錄製可能有記憶體與解碼壓力。
- 真實 worker restart、permission prompt、clipboard、4K/8K ZIP、fractional DPR、320px 與輔助科技實機驗收仍待完成。
