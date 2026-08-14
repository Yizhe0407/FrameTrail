import { UNTITLED_GUIDE_BASE } from '../storage/models';

/** 集中管理共用編輯器文案，避免措辭分歧。 */

export const MULTI_ANNOTATION_RECAPTURE_BLOCKED =
  '此快照包含多個標註；更換底圖會使其他框選失效，請重新製作整張快照。';

export const PRIVACY_REVIEW_REQUIRED_NOTICE =
  '此舊圖片的敏感資訊遮罩尚未確認，因此預覽會保持全黑，複製與匯出也會被阻擋。請使用補拍取代這張圖片。';

export const PRIVACY_REVIEW_REQUIRED_HIDDEN =
  '此舊圖片的敏感資訊遮罩尚未確認，因此暫時隱藏。請使用補拍取代這張圖片。';

export const PRIVACY_REVIEW_REQUIRED_ACTION_BLOCKED =
  '此舊圖片的敏感資訊遮罩尚未確認，請先使用補拍取代圖片。';

export const NEW_STEPS_APPEND_NOTE = '新步驟會接在最後';

/** 從 storage 重新匯出，避免顯示與持久化名稱分歧。 */
export const UNTITLED_GUIDE_TITLE = UNTITLED_GUIDE_BASE;
