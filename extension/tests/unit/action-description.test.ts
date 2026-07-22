import { describe, expect, it } from 'vitest';
import { generateActionDescription, type ActionDescriptionCapture } from '@/lib/action-description';

function capture(overrides: Partial<ActionDescriptionCapture> = {}): ActionDescriptionCapture {
  return {
    intent: 'click',
    tagName: 'div',
    text: '',
    ...overrides,
  };
}

describe('generateActionDescription', () => {
  it('describes marks without persisting selected page content', () => {
    const sensitiveText = 'Account 8842 has a balance of $9,999';

    const description = generateActionDescription(capture({
      intent: 'mark',
      tagName: 'section',
      text: sensitiveText,
    }));

    expect(description).toBe('標記頁面區域');
    expect(description).not.toContain(sensitiveText);
  });

  it.each([
    ['button', 'Customer secret', '點擊按鈕'],
    ['textarea', 'typed medical notes', '在文字欄位中輸入'],
    ['select', 'Private selection', '選擇選項'],
    ['option', 'Private selection', '選擇選項'],
    ['summary', 'Private heading', '展開或收合區段'],
    ['label', 'Private field name', '點擊欄位標籤'],
  ])('uses the <%s> semantic without copying its text', (tagName, text, expected) => {
    const description = generateActionDescription(capture({ tagName, text }));

    expect(description).toBe(expected);
    expect(description).not.toContain(text);
  });

  it('describes links and only claims a new tab when the label explicitly says so', () => {
    expect(generateActionDescription(capture({
      tagName: 'a',
      text: 'Private customer portal',
    }))).toBe('開啟連結');

    expect(generateActionDescription(capture({
      tagName: 'A',
      text: 'Open in a new tab',
    }))).toBe('開啟新分頁');
  });

  it('prefers reliable native tag semantics over incidental words in a label', () => {
    expect(generateActionDescription(capture({
      tagName: 'a',
      text: 'Checkbox documentation',
    }))).toBe('開啟連結');

    expect(generateActionDescription(capture({
      tagName: 'button',
      text: 'Radio settings',
    }))).toBe('點擊按鈕');
  });

  it.each([
    ['button', 'Submit', '提交表單'],
    ['input', '核取方塊', '切換核取方塊'],
    ['label', 'Radio button', '選取單選按鈕'],
    ['x-checkbox', 'Enable private feature', '切換核取方塊'],
  ])('recognizes an explicit fixed action hint for <%s>', (tagName, text, expected) => {
    expect(generateActionDescription(capture({ tagName, text }))).toBe(expected);
  });

  it('keeps a plain input generic because ClickCapture has no input type', () => {
    const typedValue = 'alice@example.com';
    const description = generateActionDescription(capture({ tagName: 'input', text: typedValue }));

    expect(description).toBe('操作輸入欄位');
    expect(description).not.toContain(typedValue);
  });

  it('falls back conservatively for custom controls whose role is not captured', () => {
    const sensitiveText = 'Transfer $5,000 to savings';
    const description = generateActionDescription(capture({
      tagName: 'div',
      text: sensitiveText,
    }));

    expect(description).toBe('點擊互動元素');
    expect(description).not.toContain(sensitiveText);
  });
});
