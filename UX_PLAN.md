# FrameTrail 2026 UI/UX 優化計畫

> 版本：1.0
>
> 查閱與撰寫日期：2026-07-22
>
> 適用範圍：瀏覽器擴充功能的 Popup、步驟模式、快照模式與 Editor
>
> 視覺方向：日式現代風（Japanese modern）

## 1. 文件目的

本計畫將 FrameTrail 目前的兩種錄製模式，收斂成一條可預期、跨 Chrome 與 Firefox 一致的使用流程：

1. **Popup 只負責錄製前決策**：選擇模式、選用跨頁權限、開始錄製。
2. **頁面內控制器負責錄製中操作**：顯示狀態與數量，提供復原、暫停或下一張，以及完成。
3. **全頁 Editor 負責錄製後整理**：完成後自動開啟最新內容，持續儲存並支援可復原的編輯。

此方案的首要目標不是增加功能數，而是讓使用者在任何時刻都清楚知道：

- 現在是哪一種模式。
- 系統是否正在錄製或阻擋頁面操作。
- 剛才的動作是否成功。
- 如何復原上一個動作。
- 如何安全完成並找到結果。

### 1.1 非目標

- 不在本輪加入帳號、雲端同步、多人協作或分享連結。
- 不改變 IndexedDB 本機優先的產品定位。
- 不將兩種模式合併成相同行為；兩者共用流程骨架，但保留不同的頁面互動規則。
- 不以大型品牌改版取代可用性工作。
- 不把 Side Panel 設為必要條件，以免 Firefox 支援差異與 viewport 改變影響快照底圖。

## 2. 執行摘要

### 2.1 選定方案

採用 **「設定 Popup + 頁面浮動控制器 + 完成後 Editor」** 三段式架構。

| 階段 | 主要介面 | 唯一任務 | 主要動作 |
| --- | --- | --- | --- |
| 錄製前 | Popup | 選模式與範圍 | 開始 |
| 錄製中 | 頁面浮動控制器 | 掌握狀態與控制錄製 | 完成 |
| 錄製後 | Full-page Editor | 整理、預覽與匯出 | 匯出 |

錄製模式改用目的導向名稱：

- **操作流程**（現有 `steps`）：實際操作網站，每次選取建立一張步驟圖。
- **單頁標註**（現有 `snapshot`）：鎖定目前畫面，在同一張底圖加入多個標註。

程式內部資料值維持 `steps` 與 `snapshot`，本輪只調整顯示名稱，避免不必要的資料遷移。

### 2.2 為何這是最適合 FrameTrail 的方案

- FrameTrail 的快照模式依賴固定的 viewport、scroll position 與 DPR。Side Panel 開關或調整寬度會觸發 responsive reflow，可能讓底圖與座標失去一致性。
- 頁面浮動控制器不占文件流，不會主動改變網頁版面。
- 現有 content script、closed shadow root、snapshot shield iframe 與私有通訊協定，已經提供可信任的注入與隔離邊界。
- Chrome 與 Firefox 都能提供相同的核心體驗，不需要為不同瀏覽器維護兩套主流程。
- Popup 不具持續性，開始後關閉是合理行為；問題在於目前關閉後沒有錄製中的替代控制介面。
- 完成後直接進 Editor，能消除「再開 Popup、停止、再點編輯器」的重複往返。
- 本輪已補上 Editor 的視覺修正與隱私閉環：非破壞性手動 bounds、一次性補拍、owner-level opaque redaction、補拍後 review gate，以及 Preview／Clipboard／ZIP 共用且 fail-closed 的合成路徑。

## 3. 現況與主要摩擦

### 3.1 現有優勢

- 兩種模式都有成熟的元素探測、預覽、截圖與標註幾何能力。
- 快照模式已有 READY gate、全畫面 input shield、去重與 viewport 防護。
- 背景錄製工作已有 `runId`、`controlVersion`、queue 與 transaction 邊界。
- Editor 已支援拖曳排序、說明編輯、刪除、複製、Lightbox 與 ZIP 匯出。
- 所有資料留在本機，權限也已有 `activeTab` 降級路徑。

### 3.2 使用者體驗問題

| 問題 | 使用者感受 | 優先度 |
| --- | --- | --- |
| 開始後 Popup 關閉，頁面沒有常駐控制 | 不確定是否仍在錄製，也找不到完成入口 | P0 |
| 快照模式鎖住頁面輸入後仍須重開 Popup 停止 | 感覺被困在畫面中 | P0 |
| 錄製中沒有計數與成功回饋 | 不知道剛才是否有記錄 | P0 |
| 沒有復原上一筆 | 誤選後只能到 Editor 刪除 | P0 |
| 模式名稱描述技術實作，不直接表達使用目的 | 新使用者需先理解產品術語 | P1 |
| 每次開始皆優先詢問 `<all_urls>` | 權限要求早於價值理解 | P1 |
| Editor 說明只在 blur 時儲存 | 使用者無法判斷輸入是否保存 | P1 |
| 多處 11px、低對比文字 | 閱讀負擔高，對低視力使用者不友善 | P1 |
| 鍵盤只能部分操作錄製流程 | 鍵盤與輔助科技使用者無法完整完成任務 | P1 |

## 4. 2026 研究摘要

### 4.1 同類產品的成熟做法

| 產品 | 錄製中介面 | 值得採用 | 不直接照搬的部分 |
| --- | --- | --- | --- |
| Scribe | Sidekick 側欄即時顯示步驟，也可選 classic button 或不顯示控制器 | 錄製狀態持續可見、步驟可即時確認 | 側欄會改變 viewport，不適合作為 FrameTrail 快照模式的共同主介面 |
| Tango | 側欄開始，頁面右下控制器提供完成、暫停、重啟、Live Blur、放棄 | 完成與暫停在工作現場可用，危險動作收在次層 | 功能量較大，本產品不需要把所有控制同層展示 |
| Guidde | 頁面工具列可暫停、模糊、移動、收合與 Done，停止後開啟結果 | 可移動、可收合、完成後直接進結果頁 | FrameTrail 暫無錄影或即時模糊需求，不加入無對應價值的控制 |

共同趨勢很清楚：成熟產品不要求使用者在錄製途中反覆回到 Popup。錄製控制會跟著使用者留在頁面上，完成後直接進入結果介面。

### 4.2 平台與無障礙準則

- Chrome Side Panel 與 Firefox Sidebar 都適合建立持續介面，但兩者 API 與產品整合方式不同；FrameTrail 可在後續將 Side Panel 用於「操作流程」的即時歷史，不應讓它成為兩模式共同依賴。
- Chrome 建議以 optional permission、runtime request 與明確脈絡降低權限警告。跨頁錄製應由使用者主動開啟，而非每次開始前都先要求全站權限。
- WCAG 2.2 要求鍵盤可操作、focus 可見、狀態訊息可由輔助科技取得；指標目標至少應達到 24 × 24 CSS px，產品控制建議採 40 至 44 px 以兼顧觸控。
- 日本數位廳設計系統強調清楚的文字層級、4.5:1 文字對比、3:1 UI 與 focus 對比、有限 spacing scale，以及單一流程中明確的主要動作。

### 4.3 研究後的方案比較

評分為 1 至 5，5 代表最符合本專案。

| 方案 | 跨瀏覽器 | 不改 viewport | 錄製可見性 | 工程相容性 | 總分 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 只使用 Popup | 5 | 5 | 1 | 5 | 16 |
| Side Panel 作為唯一主介面 | 3 | 1 | 5 | 3 | 12 |
| 頁面浮動控制器 | 5 | 5 | 5 | 5 | **20** |
| 同時強制 Side Panel 與頁面控制器 | 2 | 2 | 5 | 2 | 11 |

因此以頁面浮動控制器為主。Side Panel 僅保留為日後可選的操作流程增強，不列入本計畫的必要交付。

## 5. 整體資訊架構

```text
擴充功能圖示
  └─ Popup：選擇工作目的與錄製範圍
      └─ 開始
          ├─ 操作流程：頁面可正常操作 + 錄製控制器
          │   └─ 完成 → Editor 選中新步驟
          └─ 單頁標註：頁面輸入隔離 + 標註控制器
              ├─ 完成 → Editor 選中新快照群組
              └─ 完成並新增快照 → 解除隔離 → 建立下一張
```

全流程只在每個畫面保留一個明確 primary action：

- Popup：`開始`
- 操作流程控制器：`完成`
- 單頁標註控制器：`完成快照`
- 下一張準備狀態：`建立新快照`
- Editor：依情境為 `匯出`，其餘編輯自動儲存

## 6. Popup 詳細規格

### 6.1 待命狀態

Popup 寬度可維持目前 320px，但內容依下列順序排列：

1. FrameTrail 與簡短狀態 `待命`。
2. 兩段式 segmented control：`操作流程`、`單頁標註`。
3. 隨模式切換的一句結果導向說明。
4. 只顯示該模式必要的設定。
5. 全寬 primary button：`開始`。
6. 次要區：`開啟編輯器`；有資料時再顯示匯出與重置。

模式說明文案：

- 操作流程：`實際操作網站；每次選取都會建立一張步驟圖。`
- 單頁標註：`鎖定目前畫面；在同一張圖加入多個標註。`

單頁標註才顯示 `顯示順序編號` switch。這是結果偏好，不應出現在操作流程中。

### 6.2 權限流程

預設使用 `activeTab` 開始目前頁面，不先要求 `<all_urls>`。

在 Popup 提供非強制的 `跨頁錄製` switch：

- 關閉：按 `開始` 後直接啟動目前頁面。
- 開啟：在使用者操作 switch 或開始時，以 runtime permission request 要求 `<all_urls>`，旁邊先用一行說明 `允許導覽後繼續錄製，也能辨識跨網域內嵌內容。`
- 拒絕：switch 回到關閉，顯示一次非阻斷狀態 `仍可錄製目前頁面`，primary 保持可用。
- 已永久拒絕或瀏覽器不支援：提供 `查看設定` 文字動作，不在每次開始時重複提示。

權限說明必須在使用者表達跨頁意圖後出現，並說明額外能力，而不是泛稱「需要權限」。

### 6.3 啟動狀態

按下 `開始` 後：

- 按鈕固定原尺寸，內容改成 spinner + `準備中`，避免 layout shift。
- 模式與設定暫時不可更改。
- Popup 顯示具體階段，例如 `正在連接頁面`、快照模式的 `正在建立乾淨底圖`。
- 只有背景程序回報 controller 或 shield 已 ready 後才關閉 Popup。
- 超過合理時間時顯示可執行錯誤，保留 `重試` 與 `取消`，不可只顯示「發生錯誤」。

受限頁面應在按下開始前檢查。Primary 改為可理解的 disabled 狀態，旁邊顯示 `此瀏覽器頁面不允許錄製`，不要讓使用者等待後才失敗。

### 6.4 已在錄製時重新開啟 Popup

Popup 只顯示摘要，不重複一套完整控制：

- `操作流程 · 4 個步驟` 或 `單頁標註 · 3 個標註`
- `回到錄製分頁` primary
- `開啟編輯器` secondary

完成、暫停與復原仍由頁面控制器負責，避免兩個介面狀態不一致。若原分頁已關閉，Popup 提供 `完成並開啟編輯器`。

## 7. 頁面浮動控制器

### 7.1 共用形式

- 預設固定在 viewport 右下角，與邊緣保持 16px。
- 高度 44px；展開寬度依內容自適應但不超過 `min(360px, viewport - 32px)`。
- 使用 closed shadow root，CSS 與頁面隔離；最高可用 stacking context，但必須正確處理原生 modal top layer。
- 可拖曳到四角，放開後 snap；位置以每個網站 origin 或全域偏好保存。
- 可收合成 44 × 44px 狀態按鈕。收合後仍顯示錄製紅點與數量，不能只剩無意義圖示。
- 控制器移動與收合不改變網頁文件流。
- 所有按鈕使用 Lucide icon；純圖示按鈕提供 tooltip、`aria-label` 與可見 focus ring。
- `完成` 保持文字加圖示，因為它是任務終點，不用只有方形 stop icon 表達。
- `放棄錄製` 收進 overflow menu，選擇後須二次確認；不與完成同層。

控制器的建議結構：

```text
[紅點] 操作流程 · 4    [復原] [暫停] [更多] [完成]
[紅點] 單頁標註 · 3    [復原] [更多]       [完成快照]
```

### 7.2 回饋規則

每次成功寫入後必須同時提供三種回饋，但保持短暫與克制：

- 計數立即 `3 → 4`。
- 狀態區顯示約 800ms 的 check icon，不移動工具列。
- `aria-live="polite"` 宣告 `已建立步驟 4` 或 `已加入標註 4`。

失敗時不增加計數，控制器顯示可恢復訊息：

- 截圖暫時失敗：`未建立步驟，請再選一次`。
- 分頁失去權限：`錄製已暫停` + `重新授權`。
- 目前頁面不可注入：保留已錄內容，提供 `完成`。

不得以顏色作為唯一訊號；紅點需搭配 `錄製中` 的可存取名稱，成功與錯誤要有 icon 和文字。

### 7.3 截圖潔淨度

- 操作流程在 `captureVisibleTab` 前暫時隱藏控制器，待截圖完成後恢復；隱藏期間不改變 layout。
- 單頁標註的第一張乾淨底圖必須先完成，再在 shield iframe 內顯示控制器。
- 匯出的成品不得包含控制器、hover 預覽、toast 或 focus ring。
- 若隱藏控制器失敗，該次截圖應捨棄而不是保存污染底圖。

## 8. 操作流程模式

### 8.1 使用者流程

1. 使用者在 Popup 選擇 `操作流程` 並開始。
2. Popup 顯示準備狀態，頁面注入 hover preview 與錄製控制器。
3. 準備完成後 Popup 關閉；頁面仍可正常點擊、輸入與捲動。
4. 使用者選取元素。系統隱藏預覽與控制器，完成截圖與資料寫入，再重播原互動。
5. 控制器顯示新計數與成功回饋。
6. 誤選時按 `復原上一個`；只移除錄製資料，不宣稱能逆轉網站上已發生的動作。
7. 需要暫時操作網站但不記錄時按 `暫停`；控制器保留並清楚顯示 `已暫停`。
8. 按 `完成` 後，控制器進入 `整理中`，完成序列化寫入並自動開啟 Editor。
9. Editor 自動選中本輪最新步驟，焦點移到頁面標題或最新項目。

### 8.2 控制定義

| 控制 | 可用狀態 | 行為 |
| --- | --- | --- |
| 復原上一個 | 已有至少 1 筆 | 刪除本輪最後一筆，顯示 5 秒 Undo snackbar 可還原 |
| 暫停 | 錄製中 | 停用捕捉與 hover preview，頁面完全正常操作 |
| 繼續 | 已暫停 | 恢復捕捉，保留原 run 與計數 |
| 完成 | 錄製中、已暫停 | flush queue、停止注入、開啟 Editor |
| 放棄錄製 | 更多選單 | 確認後只移除本輪資料，不影響先前 session |

`復原上一個` 的 snackbar 文案須是 `已移除步驟 4` + `還原`，避免把網站本身的點擊結果也描述成已復原。

### 8.3 鍵盤行為

- 控制器可依正常 Tab 順序操作，不搶走網頁目前焦點。
- 暫停、繼續、完成與復原提供瀏覽器 `commands` API 的可設定快捷鍵；不硬攔截網站常用組合鍵。
- 當使用者以 Enter 或 Space 啟動可聚焦控制項時，系統應能建立對應步驟；無法可靠延後的 browser-privileged 動作需顯示未記錄回饋，不能吞掉原操作。
- `Escape` 只關閉控制器選單或 tooltip，不直接放棄錄製。

## 9. 單頁標註模式

### 9.1 使用者流程

1. 使用者在 Popup 選擇 `單頁標註`，設定是否顯示順序編號並開始。
2. 系統先安裝 snapshot shield，確認 READY 且穩定兩個 animation frame。
3. 隱藏所有 extension UI，擷取乾淨底圖。
4. 在 shield iframe 中顯示標註 preview、crosshair 與控制器，Popup 才關閉。
5. 使用者移動游標預覽目標，按上下方向鍵切換候選層級，點擊加入標註。
6. 每次加入後框保持可見，控制器同步增加計數；重複目標不增加，並宣告 `此項目已標註`。
7. 誤選時按 `復原上一個`，立即移除最後一個框與編號。
8. 按 `完成快照`，保存群組並自動開啟 Editor。

### 9.2 不提供一般暫停

單頁標註的底圖與座標必須對應同一個畫面。若像操作流程一樣暫停並允許使用者改變頁面，再回來加標註，結果可能與底圖不符。因此本模式不顯示 `暫停`，改提供更符合心智模型的 `完成並新增快照`。

### 9.3 完成並新增快照

此動作分成兩個清楚階段：

1. 系統完成目前快照群組並移除 input shield。
2. 頁面右下保留輕量準備控制器：`下一張尚未建立`，primary 為 `建立新快照`，secondary 為 `完成錄製`。
3. 使用者可自由導覽、開啟選單、輸入或捲動，把頁面調整到下一個狀態。
4. 按 `建立新快照` 後，控制器先隱藏，重新安裝 READY shield 並建立新的乾淨底圖。
5. 成功後回到標註狀態，計數從 0 開始；Editor 中建立新的 snapshot group。

這個流程避免使用者為每一張快照重開 Popup，也不會讓新座標寫入舊底圖。

### 9.4 Viewport 或底圖失效

當 resize、DPR、scroll position 或導覽使目前底圖失效時：

- 立即停止加入新標註，既有標註與底圖保持不變。
- 控制器顯示阻斷訊息 `畫面尺寸已改變，需建立新快照才能繼續。`
- Primary：`保留並重建`，完成目前群組後建立新底圖。
- Secondary：`完成錄製`。
- Destructive：`放棄目前快照`，放在更多選單並確認。

頁面 timer 或網路回應造成的內容變化無法完全可靠偵測。不要以大量 DOM mutation 警告干擾使用者；Editor 應以實際底圖為準，產品說明中清楚界定限制。

### 9.5 鍵盤標註

- Tab 與 Shift+Tab 在 shield 內循環瀏覽可標註的語意候選，而不是將焦點送入被隔離的原頁面。
- 目前候選使用與滑鼠相同的 preview 樣式，並由螢幕閱讀器宣告可存取名稱與角色。
- 上下方向鍵切換父子候選；Enter 或 Space 加入標註；Delete 復原最後一筆。
- 控制器本身仍在同一個可預期的 Tab order 中，提供 `跳至錄製控制` skip link。
- 候選數量很大時只遍歷 viewport 內可見、符合探測規則的節點，並延遲建立清單，避免啟動卡頓。

## 10. 共用狀態機

### 10.1 操作流程

```text
idle
  → starting
  → recording ↔ paused
  → finishing
  → editing

starting → start_error → starting | idle
recording → capture_pending → recording
capture_pending → capture_error → recording
recording | paused → discarding → idle
```

狀態要求：

- `starting`：不可重複開始。
- `capture_pending`：同一時間只允許既有 queue 規則處理，不因連點產生重複 capture。
- `paused`：不顯示 preview、不攔截頁面互動，但 recording controller 持續存在。
- `finishing`：停用所有控制，等待 queue、DB 與 storage 完成；成功才開 Editor。
- `start_error`、`capture_error`：保留可恢復路徑與已錄資料。

### 10.2 單頁標註

```text
idle
  → installing_shield
  → capturing_base
  → annotating
  → finishing
  → editing

annotating → preparing_next → installing_shield
annotating → invalidated → installing_shield | finishing
installing_shield | capturing_base → start_error → retry | idle
annotating → discarding → idle
```

狀態要求：

- `installing_shield`：不得讓早期輸入穿透。
- `capturing_base`：所有 extension overlay 隱藏。
- `annotating`：input shield 生效，只有 shield 內的標註與控制器可操作。
- `preparing_next`：舊群組已封存且 shield 已移除，頁面可操作，但尚未建立新底圖。
- `invalidated`：拒絕新增座標，不刪除既有群組。

## 11. Editor 優化

### 11.1 完成後落點

- `FINISH_RECORDING` 成功後建立或聚焦單一 Editor tab，避免每次完成都堆疊新分頁。
- URL 可帶 `sessionId` 與 `entryId/groupId`，Editor 載入後自動選中最新內容。
- 先呈現 skeleton 或 `正在整理內容`，不可短暫顯示「沒有資料」。
- 初始 focus 放在 Editor 主標題；若使用者以鍵盤完成，可提供 live announcement `已開啟編輯器，共 4 個步驟`。

### 11.2 StepRail

每一列增加足夠但不過量的識別資訊：

- 步驟模式：縮圖、序號、一至兩行說明摘要。
- 快照模式：縮圖、`單頁標註`、標註數量。
- 選取狀態同時使用背景、左側 indicator 與 `aria-current`，不只靠顏色。
- 拖曳把手至少 40 × 40px，維持鍵盤排序能力。
- Rail 在窄螢幕改為 bottom sheet 或 drawer，不與固定 400px 標註面板共同擠壓 stage。

### 11.3 說明與儲存

- `onBlur` 才保存改為 500 至 800ms debounce autosave。
- 輸入時顯示 `尚未儲存`，transaction 完成後顯示 `已儲存`；狀態區尺寸固定，避免跳動。
- 切換步驟、關閉頁面或匯出前先 flush pending save。
- 儲存失敗保留使用者文字，顯示 `無法儲存` + `重試`，不可用舊資料覆蓋。
- 說明 textarea 提供清楚 label，不以 placeholder 取代欄位名稱。

### 11.4 可復原編輯

- 刪除步驟、刪除快照群組與排序完成後顯示 5 秒 Undo snackbar。
- 危險操作的 confirmation dialog 僅保留給重置整個 session、放棄整輪錄製等高成本行為。
- 單一步驟刪除可直接執行再 Undo，減少反覆確認。
- Undo 必須對應單一 IndexedDB transaction 或可還原快照，重新整理後不承諾保留 snackbar。

### 11.6 視覺修正、補拍與隱私遮罩（已實作）

- **手動修正框選**：在同一個 Dialog 內提供調整框選、拖曳、8 個 resize handles、CSS px 精確輸入、方向鍵（1 px／Shift 10 px）、Undo/Redo 與還原自動框選。手動值寫入 `manualBounds`，原始偵測值永遠保留。
- **補拍**：普通步驟可回到原始 URL 重新框選；多標註快照拒絕直接替換，單一標註快照才允許 singleton recapture。補拍以來源／分頁／URL／runId／controlVersion 驗證和原子 IndexedDB replacement 結束，並以 durable result + ACK 復原 MV3 worker 中斷。
- **敏感資訊遮罩**：遮罩是圖片 owner 的 opaque solid layer，快照 annotation 不持有遮罩。Preview、Lightbox、Clipboard PNG 與 ZIP/JPEG 共用同一條 render path，redaction 最後繪製並向外擴 2 CSS px。
- **Fail-closed**：補拍後保留舊遮罩為 review draft；格式錯誤的 metadata 不會被視為沒有遮罩。確認前預覽全黑、複製／匯出阻擋，compositor 仍會全圖填黑；只有「確認並儲存」解除封鎖。
- **競態保護**：圖片替換遞增 `captureRevision`，視覺儲存和 Undo 使用 compare-and-set，過期 draft 不可覆寫新圖片或清除 privacy gate。
- **工作流程限制**：補拍／錄製／刪除／排序／重置等資料操作互斥；多標註快照必須重新製作整張底圖，這是避免座標錯配的刻意安全限制。

### 11.5 空狀態與匯出

- 完全無內容：顯示 `尚未建立內容`，primary 為 `開始錄製`，不顯示一排無說明的 disabled 匯出或重置。
- 有內容但正儲存：匯出保持可見並說明 `儲存完成後即可匯出`。
- 匯出中顯示進度與取消能力；成功後以非阻斷 status 回饋檔名與張數。
- 匯出失敗不清除資料，提供重試與可理解原因。

## 12. 日式現代視覺系統

此處的「日式」不是加入和紙紋理、印章、櫻花或書法裝飾，而是以克制、留白、秩序與材質感建立安靜的工作介面。視覺應服務長時間使用，避免成為主角。

### 12.1 原則

- 以「間」建立層級：使用留白與細分隔線，不用卡片包住每一區。
- 一個畫面只有一個高強度 primary。
- 陰影只用於浮在網頁上的錄製控制器與 modal；一般頁面區塊以 border 或背景層次區分。
- 不使用玻璃化、模糊背景、AI 風漸層、裝飾光球或大型行銷式標題。
- 面板與卡片圓角 6 至 8px；只有錄製工具膠囊可用完整 pill。
- 中文字距一律 `0`；不以拉開字距營造「日系感」。

### 12.2 色彩 tokens

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--canvas` | `#fafaf9` | `#1c1917` | 主背景，stone/washi 中性底 |
| `--surface` | `#ffffff` | `#292524` | Popup、控制器、dialog |
| `--text` | `#1c1917` | `#fafaf9` | 主文字，sumi |
| `--text-muted` | `#57534e` | `#d6d3d1` | 次要文字 |
| `--border` | `#d6d3d1` | `#57534e` | 分隔線與控制邊界 |
| `--primary` | `#4d7c0f` | `#a3e635` | 主要動作，moss/lime |
| `--primary-text` | `#ffffff` | `#1c1917` | Primary 文字 |
| `--recording` | `#be123c` | `#fb7185` | 僅錄製狀態與危險操作 |
| `--warning` | `#a16207` | `#facc15` | 權限降級、底圖失效 |
| `--focus` | `#2563eb` | `#60a5fa` | Focus ring，刻意與 primary 分離 |

已驗證的主要 light theme 組合：

- `#4d7c0f` / white：4.99:1
- `#be123c` / white：6.29:1
- `#57534e` / `#fafaf9`：7.30:1
- `#78716c` / `#fafaf9`：4.59:1
- `#a3e635` / `#1c1917`：11.60:1

實作 dark theme 時仍須逐一用自動化工具驗證實際 foreground/background 組合，不能只依 token 名稱推定。

### 12.3 字體與排版

```css
font-family:
  -apple-system,
  BlinkMacSystemFont,
  "Noto Sans TC",
  "PingFang TC",
  "Microsoft JhengHei",
  sans-serif;
letter-spacing: 0;
```

不直接使用 Noto Sans JP 顯示繁體中文，以免台灣慣用字形落入日文字形。建議層級：

| 用途 | 字級 / 行高 | 字重 |
| --- | --- | --- |
| Editor 頁面標題 | 24 / 32px | 600 |
| 區段標題 | 16 / 24px | 600 |
| 主要 UI 文字 | 14 / 22px | 400 或 500 |
| 輔助文字 | 12 / 18px | 400 |
| 數字／狀態 | 12 / 16px | 500，建議 tabular nums |

移除現有 11px 主要說明文字。只有非關鍵 metadata 可使用 11px，且仍須符合對比要求。

### 12.4 間距、尺寸與動態

- 基準 spacing：4、8、16、24、32px；不任意增加相近值。
- 控制高度：一般 40px，錄製控制器 44px，純圖示 hit area 至少 40 × 40px。
- Popup 內容左右 padding 20px；區段距離 24px；相關欄位距離 8px。
- Motion 以 120 至 180ms ease-out 為主，只用於狀態切換、收合與 snackbar。
- 遵守 `prefers-reduced-motion`；移除錄製紅點的持續 ping，改為靜態紅點或低頻 opacity，減少干擾。
- Hover 不得改變元件尺寸；spinner、成功 icon 與 label 使用固定容器避免 layout shift。

## 13. Accessibility 驗收基線

- 所有功能可用鍵盤完成，包括 Popup 設定、錄製控制、快照候選選擇、Editor 排序與匯出。
- focus 順序符合視覺順序；focus ring 至少 2px 且與相鄰色達 3:1。
- 正文與控制文字目標 4.5:1；大型文字 3:1；圖示、邊界與狀態 indicator 3:1。
- 每個 icon-only button 有 `aria-label`；tooltip 不能是唯一名稱來源。
- Segmented control 使用可理解的單選語意；switch 有可見 label 與狀態。
- 非阻斷結果用 `role="status"` / polite live region；需要立即處理的失敗用 `role="alert"`，避免重複宣告。
- 拖曳、顏色、hover 或 pointer gesture 都必須有替代操作。
- 200% zoom 下 Popup 不截斷 primary；Editor 在 320 CSS px 寬度仍可存取所有功能。
- 控制器在 viewport 四角、瀏覽器縮放 80% 至 200%、RTL 頁面與直式 viewport 都不得超出畫面。
- 對作業系統高對比模式、reduced motion、screen reader（VoiceOver 與 NVDA 至少各一）做手動驗證。

## 14. 資料與通訊設計

### 14.1 錄製狀態

`useRecordingSession()` 應向 UI 暴露完整且由背景程序主導的狀態，不只 `isRecording`：

```ts
type RecordingPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'preparing-next'
  | 'invalidated'
  | 'finishing'
  | 'error';

interface RecordingUiState {
  runId: string | null;
  sessionId: string | null;
  mode: 'steps' | 'snapshot' | null;
  phase: RecordingPhase;
  itemCount: number;
  activeGroupId: string | null;
  numbered: boolean;
  recoverableError: { code: string; message: string } | null;
}
```

`itemCount` 可由已提交資料推導，但錄製控制器需要透過 background event 立即更新，不能只依 React 每秒輪詢。IndexedDB 仍是內容真相來源；storage state 是控制狀態，不複製 Blob。

### 14.2 指令與事件

建議擴充 `extension/lib/messages.ts`：

| 指令 | 用途 |
| --- | --- |
| `START_RECORDING` | 以 mode、numbered、permission scope 啟動，等待 UI ready 後回應 |
| `PAUSE_RECORDING` / `RESUME_RECORDING` | 只適用操作流程 |
| `UNDO_LAST_CAPTURE` / `RESTORE_LAST_CAPTURE` | 復原與 snackbar 還原 |
| `FINISH_RECORDING` | flush 後停止，回傳 Editor 定位資訊 |
| `PREPARE_NEXT_SNAPSHOT` | 封存群組、移除 shield，進入準備下一張 |
| `CREATE_NEXT_SNAPSHOT` | 重新安裝 shield 並擷取底圖 |
| `REBUILD_INVALIDATED_SNAPSHOT` | 保留失效群組並以目前 viewport 原子建立新底圖 |
| `DISCARD_CURRENT_RECORDING` | 確認後移除本輪資料 |

事件：

- `RECORDING_STATE_CHANGED`
- `CAPTURE_COMMITTED`
- `CAPTURE_REJECTED`
- `SNAPSHOT_INVALIDATED`
- `RECORDING_FINISHED`

所有會修改狀態的訊息須帶 `runId` 與遞增 control version，背景程序須保持 idempotent。快速重複按 `完成`、舊分頁延遲事件或 Editor 重送都不能造成重複開頁與跨 run 寫入。

### 14.3 Editor 定位

完成回應包含：

```ts
interface FinishResult {
  sessionId: string;
  entryId: string | null;
  groupId: string | null;
  itemCount: number;
}
```

由背景程序尋找或建立 Editor tab，透過 query string 或 runtime message 定位。若瀏覽器阻擋建立分頁，資料仍算完成，控制器顯示 `已儲存` 並提供 `開啟編輯器`。

## 15. 對應現有程式模組

| 模組 | 計畫變更 |
| --- | --- |
| `extension/components/RecordControls.tsx` | 改模式文案、漸進式權限、啟動階段與單一 primary |
| `extension/entrypoints/popup/App.tsx` | 錄製中改摘要與回到分頁；移除依賴 Popup 停止的流程 |
| `extension/lib/useRecordingSession.ts` | 暴露 mode、phase、count、active tab 與 recoverable error；事件驅動更新 |
| `extension/entrypoints/content.ts` | 掛載操作流程控制器、暫停行為、截圖前隱藏與 focus 管理 |
| `extension/entrypoints/snapshot-shield/main.ts` | 在乾淨底圖後掛載標註控制器、鍵盤候選巡覽與 invalidated UI |
| `extension/lib/snapshot-shield-protocol.ts` | 新增 undo、finish、prepare next、create next 與狀態事件 |
| `extension/entrypoints/background.ts` | 作為錄製狀態真相來源，序列化控制指令並管理 Editor tab |
| `extension/lib/messages.ts` | 定義 discriminated union、result 與 error code |
| `extension/components/DescriptionField.tsx` | debounce autosave、flush、saving/saved/error 狀態 |
| `extension/components/StepRail.tsx` | 摘要、模式、標註數、選取語意與 responsive drawer |
| `extension/entrypoints/editor/App.tsx` | 完成後定位、Undo snackbar、空狀態與 responsive layout |

建議新增共用元件與邏輯：

- `extension/components/RecordingToolbar.tsx`
- `extension/components/RecordingStatus.tsx`
- `extension/components/UndoSnackbar.tsx`
- `extension/lib/recording-ui-state.ts`
- `extension/lib/editor-navigation.ts`

控制器視覺可共用，但操作流程與單頁標註的可用 actions 必須由明確 mode/phase 決定，不以散落的 boolean 組合推導。

## 16. 分階段實作

### Phase 0：量測基線（0.5 至 1 天）

- 記錄目前完成一輪錄製所需的開啟 Popup 次數、完成時間與錯誤點。
- 建立 5 個固定手動任務：短流程、跨頁流程、單張快照、多張快照、受限頁面失敗。
- 保存 Chrome 與 Firefox 的桌面錄影，作為改版前比較。

完成條件：有可重跑的 baseline script 與結果表，不需加入遙測 SDK。

### Phase 1：錄製中控制閉環（P0，3 至 5 天）

- 加入背景權威 phase/mode/count 與事件協定。
- 實作操作流程頁面控制器：計數、復原、暫停、完成。
- 將單頁標註控制器放入 shield iframe：計數、復原、完成。
- 完成後自動開啟或聚焦 Editor 並選中最新項目。
- 截圖前隱藏所有 extension UI。

完成條件：兩種模式都不需要重新開 Popup 才能完成；控制器不出現在成品。

#### 實作進度（2026-07-22）

本輪已完成 Phase 1、Phase 3，以及 Phase 2 的多快照核心流程：

- 背景程序成為錄製狀態真相來源，加入 `phase`、`mode`、`itemCount`、`runId` 與 recoverable error。
- 加入 `PAUSE_RECORDING`、`RESUME_RECORDING`、`UNDO_LAST_CAPTURE`、`RESTORE_LAST_CAPTURE`、`FINISH_RECORDING` 控制指令；復原只處理本輪內容，並提供 5 秒還原。
- 操作流程以 closed shadow root 掛載頁面控制器，支援計數、暫停／繼續、復原、還原、收合與完成。
- 單頁標註將同一套控制器放在 shield iframe，支援計數、復原、還原與完成快照。
- 加入 `PREPARE_NEXT_SNAPSHOT` 與 `CREATE_NEXT_SNAPSHOT`：封存目前群組後進入 `preparing-next`、移除 shield 並恢復頁面操作，再以全新 anchor、viewport 契約與歸零計數建立下一張。
- `preparing-next` 可跨頁導覽並重新掛載輕量控制器；快速重複建立只允許一個指令取得狀態轉移，不會建立重複 anchor 或混用 `groupId`。
- 加入 `SNAPSHOT_INVALIDATED` 與 `REBUILD_INVALIDATED_SNAPSHOT`：top frame 偵測 resize、scroll 與 DPR 變動後立即停用標註，background 驗證 tab、`runId`、數值與 anchor viewport 契約後冪等進入 `invalidated`。
- `invalidated` 控制器顯示阻斷訊息、`保留並重建` 與 `完成錄製`；重建會保留舊 anchor／annotations，以新 viewport 建立獨立群組，失敗則恢復舊群組資訊供再次操作。
- 截圖前會隱藏控制器、hover preview 與 shield UI，避免擴充功能介面進入成品。
- Popup 已改用「操作流程／單頁標註」名稱、漸進式跨頁權限及錄製中摘要；完成後會開啟或聚焦單一 Editor tab，並選中本輪最新步驟或群組。
- Editor 的步驟與標註說明改為 650ms debounce autosave，固定顯示尚未儲存、正在儲存、已儲存或失敗狀態；失敗時保留草稿並可重試。
- 切換項目、排序、刪除與匯出前會先 flush 待存說明；匯出重新讀取 IndexedDB，避免畫面 state 尚未刷新時輸出舊內容。
- 單一步驟、快照群組與標註改為直接刪除，排序與刪除皆顯示 5 秒 Undo snackbar；還原使用單一 IndexedDB transaction 回復資料與順序。
- Editor 在 1024px 以下改用固定底部水平 StepRail，支援左右鍵與水平拖曳；stage、快照圖與標註面板改成可捲動單欄，320px 與 768px 不產生水平溢出。
- 空狀態提供主要動作，可回到進行中的錄製分頁，或回到最近使用的網頁並開啟錄製設定。
- 匯出支援處理中取消，取消後不建立下載；成功狀態會回報 ZIP 檔名與實際輸出張數。
- 控制器可用滑鼠拖曳並在放開後 snap 到 viewport 四角，位置以全域偏好保存；方向鍵提供等價移動方式，resize 與窄 viewport 會立即 clamp，避免動畫途中越界。
- 收合與放棄移入更多選單；放棄本輪需二次確認，並以單一 IndexedDB transaction 只刪除目前 `runId` 的資料、保留同一 session 先前內容與連續順序。
- 錄製分頁關閉時會保留已提交內容並寫入 `RECORDED_TAB_CLOSED` 恢復狀態；Popup 改以 `完成並開啟編輯器` 作為唯一主要動作，重試時仍會定位最新項目。
- 完成錄製後若 Editor 分頁無法建立或聚焦，會寫入 `EDITOR_OPEN_FAILED`，Popup 可透過 background 的 `OPEN_EDITOR` 重試；成功後才清除恢復狀態。
- 補齊舊 `runId` 與快速重複 `FINISH_RECORDING` 的真實瀏覽器競態覆蓋，確認舊指令不影響新 run、同一輪只完成一次且只開啟一個 Editor。
- 新增對應 unit／integration 覆蓋；測試套件規模會隨功能演進調整，應以各指令當次輸出確認。完整 E2E、Firefox build 與實機驗收另列為 release gate，本計畫不將其視為已完成。

本計畫仍未完成：

- Phase 0 的量測基線與桌面錄影。
- Phase 5 的可選 Side Panel 工作。
- 真實 Chrome MV3 worker restart、權限 prompt、clipboard、4K/8K ZIP、fractional DPR、320×480、VoiceOver/NVDA/高對比，以及大量步驟 virtualization 的實機驗收。

### Phase 2：多快照與錯誤恢復（P0/P1，2 至 4 天）

- 實作 `完成並新增快照` 與 `preparing-next`。
- 將 viewport invalidation 改為有選項的恢復流程。
- 實作權限失敗、分頁關閉、Editor 開啟失敗等 recoverable error。
- 補齊 `runId`、control version 與雙擊完成的 race tests。

完成條件：使用者可在一輪 session 建立多張快照，且不會把座標寫入錯誤底圖。

### Phase 3：Popup 與 Editor 摩擦（P1，3 至 5 天）

- 模式改名與結果導向說明。
- 跨頁錄製改 optional progressive permission。
- Editor 完成定位、debounced autosave、儲存狀態與 Undo snackbar。
- Responsive rail/drawer、空狀態與匯出狀態。

完成條件：無 blur-only save；刪除與排序可復原；320px 寬仍可完成核心任務。

#### 實作進度（2026-07-22，Guide UX 完整化）

Phase 3 的核心摩擦已以本機優先方案完成：

- 新增作品庫與多 Guide DB v4 migration；Guide selection 與 recording state 分離，Editor URL authoritative，遺失 URL／Guide 不會 fallback。
- 新增首次 onboarding、可重看導覽、精簡／完整模式與完全本機練習頁；自動描述不保存 page text、typed value 或 URL 內容。
- StepRail 完成搜尋／品質／類型篩選、手機展開入口、lazy thumbnail mounting、多選鍵盤模型與章節 heading；hidden selection 會被移除，批次破壞操作不會影響不可見項目。
- 完成 entry-safe CAS 批次刪除、移動、複製、快照編號、章節 CRUD 與 revision-guarded Undo；快照群組不可拆，stale transaction rollback。
- 完成指定位置補錄與手動區域擷取，沿用 sender/session/token 驗證及 durable MV3 restart guards。
- 完成品質 dialog 與 Markdown、HTML、列印/PDF、rich clipboard、ZIP 發佈；所有公開 raster 維持 redaction fail-closed。`.frametrail` v2 備份加入標題、說明、章節，並保留 v1 import 相容。

### Phase 4：Accessibility 與視覺收斂（P1，3 至 5 天）

- 實作快照鍵盤候選巡覽與 browser commands。
- 套用 typography、spacing、color、focus 與 motion tokens。
- 執行 axe、鍵盤、VoiceOver、NVDA、高對比與 reduced-motion 驗證。
- 修正所有低於 12px 的關鍵文字與不合格對比。

完成條件：核心流程無 axe serious/critical issue，並通過第 13 節的手動檢核。

#### 實作進度（2026-07-22）

本輪推進 Phase 4 的視覺 token 收斂與部分無障礙項目：

- `assets/tailwind.css` 改用第 12.2 節的日式現代 token：以 hex 直接對應已驗證對比值，並保留 shadcn 語意名稱（`--primary`、`--muted-foreground` 等）重新映射，讓既有 utility 自動套用新色。新增 `--recording`、`--warning`、`--focus` token 與對應 `color-*`；focus ring 刻意採藍色與 moss primary 分離。
- 導入 Noto Sans TC 優先字型堆疊（避免 JP 字形）、`letter-spacing: 0`，面板圓角收斂為 8px，並加入 `prefers-reduced-motion` 全域降級以移除錄製紅點的持續動畫。
- 修正低於樓地板的關鍵文字：標註序號徽章 11px→12px 並改用 rose 對齊實際 marker 色；StepRail 快照角標 10px→11px（非關鍵 metadata 下限）。
- 加入 browser `commands`：`toggle-pause`、`undo-last-capture`、`finish-recording`，路由到既有背景控制指令；不設預設鍵，改由 chrome://extensions/shortcuts 綁定，暫停切換僅在操作流程生效。Chrome MV3 與 Firefox MV2 build 均含 commands。
- 實作快照鍵盤候選巡覽（§9.5），以 `lib/feature-flags.ts` 的 `snapshotKeyboardNav` 旗標隔離（§19）：
  - 頁面凍結期間 top frame 只列舉一次可標註的語意候選（`isInteractiveElement` 過濾、reading order 排序、去重、上限 150），並在 idle callback 送入 shield，避免拖慢乾淨底圖交接。
  - shield 以 index 驅動既有 probe／preview／commit 引擎：`Tab`／`Shift+Tab` 巡覽候選、`Enter`／`Space` 加入、`Delete`／`Backspace` 復原、方向鍵維持父子層級；`Escape` 回到 skip link。
  - 新增「跳至錄製控制」skip link 與 `aria-live` polite 宣告（候選位置、加入標註、無法標註）。
  - 純邏輯（排序／去重／roving index）與新 `SNAPSHOT_SHIELD_CANDIDATES` 訊息 schema 有 unit 覆蓋；新增鍵盤 only 的 Chromium E2E 驗證 Tab→加入→復原且底層頁面不被觸發。
- 現況確認：產品元件多已直接使用符合計畫值的 Tailwind stone/lime/rose/amber/blue class（lime-700=#4d7c0f、lime-400=#a3e635、rose-700=#be123c），故本輪 token 收斂主要統一 shadcn 預設元件並集中管理。測試套件規模與各驗證結果應以當次指令輸出為準；本計畫不將完整 E2E 視為已完成。

本節尚未實作（需真實瀏覽器與輔助科技手動驗證，非程式碼可自動完成）：

- axe / VoiceOver / NVDA / 高對比 / reduced-motion 的手動驗證與 §17.4 視覺回歸截圖。
- dark theme 各 foreground/background 組合的自動化對比逐一驗證。
- 鍵盤候選巡覽的跨 frame 支援（目前僅 top frame；子 frame 候選維持指標可達）與大型頁面上的實機節奏調校。
- 真實 Chrome MV3 worker restart、權限 prompt、clipboard、4K/8K ZIP、fractional DPR、320×480、VoiceOver/NVDA/高對比，以及大量步驟的 list virtualization 尚未完成實機驗收；目前 `loading=lazy`／`decoding=async` 只能降低，不能消除，大量高解析圖的解碼與記憶體壓力。

### Phase 5：可選增強（不阻擋上線）

- 僅為操作流程評估 Side Panel 即時步驟歷史。
- 讓使用者在設定中選擇 `浮動控制器`、`側欄歷史 + 控制器` 或 `最小控制器`。
- 先做實驗驗證是否真的降低錯誤率，再決定是否長期維護。

> 狀態（2026-07-19）：本階段刻意保留未實作。依計畫，Side Panel 需先以 usability 實驗確認能降低錯誤率，才值得投入跨瀏覽器維護成本；在取得該證據前不預先建置。

## 17. 測試與驗收

### 17.1 Unit

- mode/phase/action matrix：每個狀態只顯示合法控制。
- 計數只在 transaction committed 後增加。
- undo/restore 保持 order、groupId 與 Blob reference 正確。
- permission switch 的 granted、denied、error 與已授權分支。
- toolbar snap、viewport clamp 與保存位置。
- autosave debounce、flush、過期 response 與失敗保留文字。
- message schema 拒絕錯誤 runId、舊 control version 與重複 finish。

### 17.2 Integration

- Popup 等待 recorder ready 後才關閉。
- 操作流程 capture 前隱藏 toolbar，寫入後恢復並更新計數。
- paused 期間不建立步驟，也不影響網站操作。
- snapshot base capture 不包含 toolbar；shield ready 前輸入不穿透。
- undo 立即移除對應的 preview、DB entry 與計數，restore 可還原。
- preparing-next 移除 shield；新快照使用新 groupId 與新 anchor。
- invalidated 期間拒絕 annotation，保留既有群組。
- finish flush 所有 pending work，只開啟一個 Editor tab。

### 17.3 Chromium / Firefox E2E

1. 操作流程：開始、選 3 步、復原 1 步、暫停操作網站、繼續選 1 步、完成，Editor 顯示正確 3 步。
2. 截圖潔淨度：以像素或指定區域檢查，成品不得含控制器與 preview。
3. 單頁標註：加入、去重、父子切換、復原、完成，底圖與座標一致。
4. 多快照：完成第一張、操作頁面、建立第二張，Editor 顯示兩群且各自共用正確底圖。
5. Resize/DPR/scroll invalidation：不能把新標註加入舊 anchor，可保留並重建。
6. 權限拒絕：目前頁面仍可開始，跨來源 iframe 使用既有 fallback。
7. 導覽與分頁關閉：已錄資料不遺失，Popup 能提供完成路徑。
8. Editor：自動定位、autosave、刪除 Undo、排序 Undo、匯出前 flush。
9. 320、768、1280px viewport 與 200% zoom：控制不重疊、不溢出。
10. 鍵盤 only：完成兩模式核心任務，focus 不遺失或被困住。

### 17.4 視覺回歸

至少保存下列狀態的 light/dark screenshot：

- Popup 待命、權限拒絕、準備中、受限頁面。
- 操作流程 recording、paused、success、error、collapsed。
- 單頁標註 annotating、preparing-next、invalidated。
- Editor empty、saving、saved、save error、narrow drawer。

檢查內容不只做 snapshot diff，也要以 Playwright 驗證 bounding boxes 沒有重疊、控制器位於 viewport 內、文字沒有被截斷。

## 18. 成功指標與使用者測試

FrameTrail 不需要立即導入跨站追蹤。可先使用本機、匿名、可清除的產品事件或研究紀錄量測：

| 指標 | 目前假設 | 目標 |
| --- | --- | --- |
| 完成錄製所需 Popup 開啟次數 | 2 次以上 | 中位數 1 次 |
| 開始後成功完成比例 | 待量測 | 提升至少 20% |
| 快照模式找不到停止入口 | 常見風險 | 測試中 0 次 |
| 誤選後到 Editor 才刪除 | 缺少就地復原 | 80% 誤選可在錄製中處理 |
| 完成到看到最新結果的時間 | 多步手動操作 | P50 < 2 秒，P95 < 5 秒 |
| 說明文字遺失 | blur-only 風險 | 自動測試與研究中 0 次 |

建議先進行 5 至 8 人的 task-based usability test，涵蓋初次使用者、熟悉擴充功能者與至少 2 位鍵盤或輔助科技使用者。每人執行：

1. 建立三步驟操作流程，中途誤選一次。
2. 暫停錄製完成一個不想記錄的網站操作，再繼續。
3. 在同一頁建立四個標註。
4. 調整頁面後建立第二張快照。
5. 修改說明、刪除後還原並匯出。

觀察是否能在不提示的情況下說出目前模式、找到完成、理解暫停與下一張差異，以及是否相信內容已保存。若 2 人以上把 `完成並新增快照` 誤解為直接覆蓋底圖，應先改文案與階段回饋，再增加教學。

## 19. 上線策略與風險

- 以 feature flag 分開啟用 `recordingToolbar`、`multiSnapshotFlow`、`editorAutosave`，便於逐步回退。
- 先保留既有 Popup 停止作為一版隱藏 fallback，但正常流程不展示；待 E2E 與 beta 穩定後移除。
- toolbar 注入可能遇到極端 CSP、top layer 或網站自訂熱鍵衝突；closed shadow root、iframe shield 與 browser commands 分層處理。
- 即時事件不可讓 storage 寫入頻率失控；內容仍寫 IndexedDB，UI count event 只傳小型 payload。
- 快照鍵盤候選巡覽可能是本計畫最高複雜度項目。先交付可完整鍵盤操作的控制器，再以 feature flag 上線候選巡覽，但不得把它永久留成未知期限。
- 多快照準備狀態跨導覽時，background 必須是唯一真相來源；不可依賴 content script 記憶體延續。

## 20. 不採用項目

- **不以 Side Panel 取代所有控制**：會改 viewport，且跨瀏覽器成本高；只適合作為操作流程的後續歷史視圖。
- **不讓 Popup 常駐**：瀏覽器 popup 本來就會在失焦後卸載，無法成為可靠錄製控制器。
- **不把兩種模式塞入同一組暫停規則**：快照暫停後改變頁面會破壞底圖不變量。
- **不在控制器同層放放棄、重啟、重置等所有動作**：降低完成主動作的辨識度，也增加誤觸成本。
- **不以 disabled controls 代替空狀態說明**：使用者需要下一步，不是看見不可用功能。
- **不以日式裝飾素材製造風格**：會增加噪音並偏離工作工具的效率定位。

## 21. 決策完成定義

本計畫視為完成實作，必須同時符合：

1. 使用者開始後不必再開 Popup，就能在兩種模式中復原與完成。
2. 任一錄製狀態都有可見且可存取的 mode、phase、count 與 primary action。
3. 操作流程可暫停；單頁標註以「完成並新增快照」維持底圖一致性。
4. 控制器、preview、toast 與 focus UI 永不出現在輸出圖片。
5. 完成後 Editor 自動定位最新內容，說明採 autosave 並顯示保存狀態。
6. 權限拒絕不阻擋目前頁面錄製，跨頁能力採漸進式請求。
7. light/dark、320px、200% zoom、鍵盤與螢幕閱讀器核心流程通過驗收。
8. 新增的 state/message race 有 unit、integration 與 E2E 覆蓋。
9. 視覺修正／補拍／遮罩的資料模型與 fail-closed 輸出路徑已完成；上線前仍須完成真實瀏覽器 lifecycle、權限、clipboard、輔助科技與高解析效能驗收。

## 22. 參考資料

以下資料於 2026-07-19 查閱：

1. Scribe, [*How to capture a Scribe using the extension*](https://support.scribehow.com/hc/en-us/articles/13546388647453-How-to-capture-a-Scribe-using-the-extension)
2. Scribe, [*Basics: How to create a Scribe using Chrome or Edge*](https://support.scribehow.com/hc/en-us/articles/9008025006749-Basics-How-to-create-a-Scribe-using-Chrome-or-Edge)
3. Tango, [*How do I start capturing a workflow?*](https://help.tango.ai/en/articles/5971654-how-do-i-start-capturing-a-workflow)
4. Guidde, [*Getting started with capturing a guidde*](https://help.guidde.com/en/articles/9382933-getting-started-with-capturing-a-guidde)
5. Chrome for Developers, [*chrome.sidePanel API*](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
6. MDN, [*Sidebars*](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Sidebars)
7. Chrome for Developers, [*Declare permissions*](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
8. Digital Agency, Government of Japan, [*Typography*](https://design.digital.go.jp/dads/foundations/typography/)
9. Digital Agency, Government of Japan, [*Color accessibility*](https://design.digital.go.jp/dads/foundations/color/accessibility/)
10. Digital Agency, Government of Japan, [*Spacing*](https://design.digital.go.jp/dads/foundations/spacing/)
11. Digital Agency, Government of Japan, [*Button*](https://design.digital.go.jp/dads/components/button/)
12. Digital Agency, Government of Japan, [*Button accessibility*](https://design.digital.go.jp/dads/components/button/accessibility/)
13. W3C, [*Web Content Accessibility Guidelines (WCAG) 2.2*](https://www.w3.org/TR/WCAG22/)
14. W3C, [*Understanding Success Criterion 2.5.8: Target Size (Minimum)*](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
15. W3C, [*Understanding Success Criterion 4.1.3: Status Messages*](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
