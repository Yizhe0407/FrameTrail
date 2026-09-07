// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { INTERACTIVE_CANDIDATE_SELECTOR, isInteractiveElement } from '@/lib/capture/selector/interactive-element';
import { makeVisible, resetSelectorDom } from '../setup/selector-dom';

afterEach(resetSelectorDom);
describe('isInteractiveElement', () => {
  it('requires image-map areas to have an action', () => {
    const area = document.createElement('area');
    expect(isInteractiveElement(area)).toBe(false);
    area.href = '/details';
    expect(isInteractiveElement(area)).toBe(true);
  });

  it('recognizes delegated click bindings and rejects other event types', () => {
    const element = document.createElement('div');
    document.body.append(element);
    makeVisible(element);

    // jsaction and Stimulus data-action name the event before their separator;
    // an entry without one defaults to click.
    expect(isInteractiveElement(element)).toBe(false);
    element.setAttribute('jsaction', 'keydown:menu.key');
    expect(isInteractiveElement(element)).toBe(false);
    element.setAttribute('jsaction', 'keydown:menu.key;click:menu.toggle');
    expect(isInteractiveElement(element)).toBe(true);
    element.setAttribute('jsaction', 'menu.toggle');
    expect(isInteractiveElement(element)).toBe(true);

    element.removeAttribute('jsaction');
    element.setAttribute('data-action', 'mouseenter->menu#preview');
    expect(isInteractiveElement(element)).toBe(false);
    element.setAttribute('data-action', 'menu#toggle');
    expect(isInteractiveElement(element)).toBe(true);

    element.removeAttribute('data-action');
    for (const attribute of ['ng-click', 'v-on:click', 'wire:click', 'hx-post', 'onpointerdown']) {
      element.setAttribute(attribute, 'noop');
      expect(isInteractiveElement(element), attribute).toBe(true);
      element.removeAttribute(attribute);
    }

    // Vue's @click shorthand cannot go through setAttribute — jsdom enforces
    // the XML Name production — but the HTML parser accepts it, which is how
    // it reaches a real page.
    const parsed = document.createElement('div');
    parsed.innerHTML = '<span @click="submit()">送出</span>';
    const shorthand = parsed.firstElementChild!;
    document.body.append(parsed);
    makeVisible(shorthand);
    expect(shorthand.hasAttribute('@click')).toBe(true);
    expect(isInteractiveElement(shorthand)).toBe(true);
    expect(parsed.querySelectorAll(INTERACTIVE_CANDIDATE_SELECTOR)).toHaveLength(1);
  });

  it('treats widget state attributes as controls, except an explicit no-popup', () => {
    const element = document.createElement('div');
    document.body.append(element);
    makeVisible(element);

    element.setAttribute('aria-haspopup', 'false');
    expect(isInteractiveElement(element)).toBe(false);
    element.setAttribute('aria-haspopup', 'menu');
    expect(isInteractiveElement(element)).toBe(true);

    element.removeAttribute('aria-haspopup');
    // A collapsed toggle is still a toggle, so "false" stays interactive here.
    element.setAttribute('aria-expanded', 'false');
    expect(isInteractiveElement(element)).toBe(true);
  });

  it('accepts natively actionable tags that carry no role or handler', () => {
    for (const tag of ['details', 'object', 'embed']) {
      const element = document.createElement(tag);
      document.body.append(element);
      makeVisible(element);
      expect(isInteractiveElement(element), tag).toBe(true);
    }
  });
});
