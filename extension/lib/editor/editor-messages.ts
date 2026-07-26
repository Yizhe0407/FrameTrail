import { UNTITLED_GUIDE_BASE } from '../storage/db';

/**
 * Load-bearing user-facing strings that more than one editor surface renders.
 * Each of these used to be duplicated inline and had already started to drift
 * into near-identical wordings for the same state; keeping the single copy
 * here makes the next wording change land everywhere at once.
 */

/** Why recapture refuses a snapshot that carries more than one annotation. */
export const MULTI_ANNOTATION_RECAPTURE_BLOCKED =
  '此快照包含多個標註；更換底圖會使其他框選失效，請重新製作整張快照。';

/** Full impact statement shown on the stage while an old image's privacy
 * masks are unreviewed: preview stays black, copy and export are blocked. */
export const PRIVACY_REVIEW_REQUIRED_NOTICE =
  '此舊圖片的敏感資訊遮罩尚未確認，因此預覽會保持全黑，複製與匯出也會被阻擋。請使用補拍取代這張圖片。';

/** Shorter variant for surfaces that only need to explain the hidden image. */
export const PRIVACY_REVIEW_REQUIRED_HIDDEN =
  '此舊圖片的敏感資訊遮罩尚未確認，因此暫時隱藏。請使用補拍取代這張圖片。';

/** Variant for a blocked action (e.g. copying the image to the clipboard). */
export const PRIVACY_REVIEW_REQUIRED_ACTION_BLOCKED =
  '此舊圖片的敏感資訊遮罩尚未確認，請先使用補拍取代圖片。';

/** Where continued recording appends its captures. Composed into longer
 * sentences by the continuation dialog and the rail's 接續錄製 button. */
export const NEW_STEPS_APPEND_NOTE = '新步驟會接在最後';

/** Display fallback for a Guide whose title is empty. Re-exported under the
 * name editor surfaces already import; the storage layer's base string is the
 * single source so display and persistence can never drift. */
export const UNTITLED_GUIDE_TITLE = UNTITLED_GUIDE_BASE;
