// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCandidateTargetLock } from '@/lib/capture/candidate-target-lock';

function makeVisible(element: Element, rect: { x: number; y: number; width: number; height: number }): void {
  const box = {
    ...rect,
    top: rect.y,
    left: rect.x,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => rect,
  };
  Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => box });
  Object.defineProperty(element, 'getClientRects', { configurable: true, value: () => [box] });
}

describe('createCandidateTargetLock', () => {
  let article: HTMLElement;
  let card: HTMLElement;
  let text: HTMLElement;

  beforeEach(() => {
    article = document.createElement('article');
    card = document.createElement('div');
    text = document.createElement('span');
    card.append(text);
    article.append(card);
    document.body.append(article);
    makeVisible(article, { x: 0, y: 0, width: 600, height: 400 });
    makeVisible(card, { x: 20, y: 20, width: 300, height: 120 });
    makeVisible(text, { x: 30, y: 30, width: 90, height: 24 });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => text });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('keeps ordinary offset-zero hover fluid instead of creating a lock', () => {
    const target = createCandidateTargetLock();

    expect(target.resolveAt(40, 40)?.element).toBe(text);
    expect(target.hasLock()).toBe(false);
  });

  it('locks a widened candidate by concrete Element identity', () => {
    const target = createCandidateTargetLock();

    expect(target.adjustAt(40, 40, 1)?.element).toBe(card);
    expect(target.hasLock()).toBe(true);
  });

  it('keeps the same Element across descendants with different wrapper depths', () => {
    const wrapper = document.createElement('div');
    const nestedText = document.createElement('span');
    wrapper.append(nestedText);
    card.append(wrapper);
    makeVisible(wrapper, { x: 180, y: 30, width: 100, height: 50 });
    makeVisible(nestedText, { x: 190, y: 40, width: 60, height: 20 });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: (clientX: number) => (clientX < 150 ? text : nestedText),
    });
    const target = createCandidateTargetLock();

    expect(target.adjustAt(40, 40, 1)?.element).toBe(card);
    expect(target.resolveAt(200, 50)?.element).toBe(card);
  });

  it('narrows through the original retained chain rather than a new hit chain', () => {
    const wrapper = document.createElement('div');
    const nestedText = document.createElement('span');
    wrapper.append(nestedText);
    card.append(wrapper);
    makeVisible(wrapper, { x: 180, y: 30, width: 100, height: 50 });
    makeVisible(nestedText, { x: 190, y: 40, width: 60, height: 20 });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: (clientX: number) => (clientX < 150 ? text : nestedText),
    });
    const target = createCandidateTargetLock();

    expect(target.adjustAt(40, 40, 1)?.element).toBe(card);
    expect(target.resolveAt(200, 50)?.element).toBe(card);
    expect(target.adjustAt(40, 40, -1)?.element).toBe(text);
  });

  it('retains six pixels beyond the bounds and releases on the seventh', () => {
    const target = createCandidateTargetLock();
    target.adjustAt(40, 40, 1);

    expect(target.resolveAt(14, 40)?.element).toBe(card);
    expect(target.resolveAt(13, 40)?.element).toBe(text);
    expect(target.hasLock()).toBe(false);
  });

  it('releases a detached selection and resolves the current hit normally', () => {
    const replacement = document.createElement('button');
    document.body.append(replacement);
    makeVisible(replacement, { x: 350, y: 20, width: 100, height: 40 });
    const target = createCandidateTargetLock();
    target.adjustAt(40, 40, 1);
    card.remove();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => replacement });

    expect(target.resolveAt(370, 30)?.element).toBe(replacement);
    expect(target.hasLock()).toBe(false);
  });
});
