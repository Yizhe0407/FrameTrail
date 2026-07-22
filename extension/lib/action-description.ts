import type { ClickCapture } from './messages';

export type ActionDescriptionCapture = Pick<ClickCapture, 'intent' | 'tagName' | 'text'>;

const CHECKBOX_HINT = /(?:^|\s)(?:check\s*box|checkbox)(?:\s|$)|核取方塊|勾選框|複選框/iu;
const RADIO_HINT = /(?:^|\s)(?:radio(?:\s+button)?)(?:\s|$)|單選按鈕|選項按鈕/iu;
const SUBMIT_HINT = /^(?:submit|submit form|send form|提交|提交表單|送出|送出表單)$/iu;
const NEW_TAB_HINT = /(?:^|\s)(?:open\s+in\s+(?:a\s+)?new\s+tab|new\s+tab)(?:\s|$)|(?:在)?新分頁(?:中)?開啟|開啟新分頁/iu;

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' ');
}

function tagHasToken(tagName: string, token: string): boolean {
  return tagName === token || tagName.split(/[-_:]/u).includes(token);
}

function describesCheckbox(tagName: string, text: string): boolean {
  return tagHasToken(tagName, 'checkbox') || CHECKBOX_HINT.test(text);
}

function describesRadio(tagName: string, text: string): boolean {
  return tagHasToken(tagName, 'radio') || RADIO_HINT.test(text);
}

/**
 * Generates a short action description without copying page text into storage.
 *
 * Privacy boundary: ClickCapture.text can come from visible text, aria-label,
 * placeholder, or editable content. Its provenance is unavailable here, so it
 * is used only to recognize a small fixed vocabulary of action hints and is
 * never interpolated into the returned description. ClickCapture.url is also
 * intentionally excluded because it may contain private paths or query data.
 *
 * Inference gaps in the current message contract:
 * - <input> does not include its type, so text fields, checkboxes, radios, and
 *   submit controls cannot generally be distinguished. Only explicit semantic
 *   hints can safely specialize the generic input-field description.
 * - ARIA role/state, href/target, modifier keys, form ownership, and the action
 *   result are absent. Therefore custom controls and whether a link actually
 *   opens a new tab cannot be known unless the captured label explicitly says
 *   so. These cases deliberately fall back to conservative descriptions.
 */
export function generateActionDescription(capture: ActionDescriptionCapture): string {
  if (capture.intent === 'mark') return '標記頁面區域';

  const tagName = normalize(capture.tagName);
  const text = normalize(capture.text);

  // Prefer native element semantics over label hints. A link whose label
  // happens to mention a checkbox is still more reliably a link.
  if (tagName === 'a' || tagName === 'area' || tagHasToken(tagName, 'link')) {
    return NEW_TAB_HINT.test(text) ? '開啟新分頁' : '開啟連結';
  }

  if (tagName === 'select' || tagName === 'option' || tagHasToken(tagName, 'select')) {
    return '選擇選項';
  }

  if (tagName === 'textarea' || tagHasToken(tagName, 'textarea')) {
    return '在文字欄位中輸入';
  }

  if (tagName === 'input') {
    if (describesCheckbox(tagName, text)) return '切換核取方塊';
    if (describesRadio(tagName, text)) return '選取單選按鈕';
    if (SUBMIT_HINT.test(text)) return '提交表單';
    return '操作輸入欄位';
  }

  if (tagName === 'button') {
    return SUBMIT_HINT.test(text) ? '提交表單' : '點擊按鈕';
  }

  if (tagName === 'summary') return '展開或收合區段';
  if (tagName === 'label') {
    if (describesCheckbox(tagName, text)) return '切換核取方塊';
    if (describesRadio(tagName, text)) return '選取單選按鈕';
    return '點擊欄位標籤';
  }

  // Custom controls can expose semantics in their tag name. For generic
  // role-based controls, an explicit fixed action label is the only remaining
  // signal because ClickCapture does not carry the role itself.
  if (describesCheckbox(tagName, text)) return '切換核取方塊';
  if (describesRadio(tagName, text)) return '選取單選按鈕';
  if (SUBMIT_HINT.test(text) || tagHasToken(tagName, 'submit')) return '提交表單';
  if (tagHasToken(tagName, 'button')) return '點擊按鈕';

  return '點擊互動元素';
}
