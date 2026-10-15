import type { ClickCapture } from '../runtime/messages';
import { t } from '@/lib/shared/i18n';

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
 * capture.text's provenance (visible text, aria-label, placeholder, etc.) is
 * unknown, so it is only matched against a fixed vocabulary of action hints
 * and never interpolated into the result; capture.url is excluded for the
 * same reason. capture.tagName also carries no input type or ARIA role, so
 * anything not identifiable from the text hints falls back to a generic,
 * conservative description.
 */
export function generateActionDescription(capture: ActionDescriptionCapture): string {
  if (capture.intent === 'mark') return t().capture.markRegion;

  const tagName = normalize(capture.tagName);
  const text = normalize(capture.text);

  // Prefer native element semantics over label hints. A link whose label
  // happens to mention a checkbox is still more reliably a link.
  if (tagName === 'a' || tagName === 'area' || tagHasToken(tagName, 'link')) {
    return NEW_TAB_HINT.test(text) ? t().capture.openNewTab : t().capture.openLink;
  }

  if (tagName === 'select' || tagName === 'option' || tagHasToken(tagName, 'select')) {
    return t().capture.selectOption;
  }

  if (tagName === 'textarea' || tagHasToken(tagName, 'textarea')) {
    return t().capture.typeInField;
  }

  if (tagName === 'input') {
    if (describesCheckbox(tagName, text)) return t().capture.toggleCheckbox;
    if (describesRadio(tagName, text)) return t().capture.selectRadio;
    if (SUBMIT_HINT.test(text)) return t().capture.submitForm;
    return t().capture.useInput;
  }

  if (tagName === 'button') {
    return SUBMIT_HINT.test(text) ? t().capture.submitForm : t().capture.clickButton;
  }

  if (tagName === 'summary') return t().capture.toggleDisclosure;
  if (tagName === 'label') {
    if (describesCheckbox(tagName, text)) return t().capture.toggleCheckbox;
    if (describesRadio(tagName, text)) return t().capture.selectRadio;
    return t().capture.clickLabel;
  }

  // Custom controls can expose semantics in their tag name. For generic
  // role-based controls, an explicit fixed action label is the only remaining
  // signal because ClickCapture does not carry the role itself.
  if (describesCheckbox(tagName, text)) return t().capture.toggleCheckbox;
  if (describesRadio(tagName, text)) return t().capture.selectRadio;
  if (SUBMIT_HINT.test(text) || tagHasToken(tagName, 'submit')) return t().capture.submitForm;
  if (tagHasToken(tagName, 'button')) return t().capture.clickButton;

  return t().capture.clickElement;
}
