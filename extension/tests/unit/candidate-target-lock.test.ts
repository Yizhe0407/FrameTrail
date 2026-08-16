// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCandidateTargetLock } from '@/lib/capture/candidate-target-lock';
import { ACTIVATION_TARGETING_POLICY } from '@/lib/capture/selector-utils';

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

  it('releases a retained target whose layout moves away from the pointer', () => {
    const replacement = document.createElement('button');
    document.body.append(replacement);
    makeVisible(replacement, { x: 0, y: 20, width: 18, height: 40 });
    const target = createCandidateTargetLock();

    expect(target.adjustAt(40, 40, 1)?.element).toBe(card);

    makeVisible(card, { x: 500, y: 20, width: 300, height: 120 });
    makeVisible(text, { x: 510, y: 30, width: 90, height: 24 });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => replacement });

    // x=15 remains inside the previous 6px spill zone, but not the target's
    // current one. A stale lock must not teleport the selection to x=500.
    expect(target.resolveAt(15, 40)?.element).toBe(replacement);
    expect(target.hasLock()).toBe(false);
  });

  it('does not cycle to a retained chain member whose layout moved away', () => {
    const target = createCandidateTargetLock();

    expect(target.adjustAt(40, 40, 1)?.element).toBe(card);

    makeVisible(article, { x: 500, y: 0, width: 600, height: 400 });

    expect(target.adjustAt(40, 40, 1)?.element).toBe(text);
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

  it('releases the old lock when a new top hit surface appears', () => {
    const overlay = document.createElement('div');
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
    document.body.append(overlay);
    makeVisible(overlay, { x: 20, y: 20, width: 300, height: 120 });
    const target = createCandidateTargetLock();

    expect(target.adjustAt(40, 40, 1)?.element).toBe(card);
    expect(target.hasLock()).toBe(true);

    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => overlay });

    expect(target.resolveAt(40, 40)?.element).toBe(overlay);
    expect(target.hasLock()).toBe(false);
  });

  it('uses the activation policy for fresh cycling instead of piercing a transparent overlay', () => {
    const overlay = document.createElement('div');
    const underneath = document.createElement('button');
    overlay.style.opacity = '0';
    underneath.textContent = '底下按鈕';
    document.body.append(overlay, underneath);
    makeVisible(overlay, { x: 10, y: 10, width: 140, height: 60 });
    makeVisible(underneath, { x: 20, y: 20, width: 120, height: 40 });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => overlay });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [overlay, underneath, document.body],
    });
    const target = createCandidateTargetLock(ACTIVATION_TARGETING_POLICY);

    expect(target.adjustAt(30, 30, 1)?.element).toBe(overlay);
  });
});
