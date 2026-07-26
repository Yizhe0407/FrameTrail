import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

import {
  isStepFrameClickPayload,
  isStepFrameClickResponse,
  respondToStepFrameClick,
  snapshotFrameScrollPingType,
  stepFrameClickMessageType,
} from '@/lib/recording/frame-relay';

describe('step frame relay protocol', () => {
  const messageType = stepFrameClickMessageType('test-extension');
  const validPayload = {
    type: messageType,
    rect: { x: 10, y: 20, width: 30, height: 40 },
    text: 'Submit',
    tagName: 'button',
    interactive: true,
  };

  it('namespaces message types by extension id', () => {
    expect(stepFrameClickMessageType('a')).not.toBe(stepFrameClickMessageType('b'));
    expect(snapshotFrameScrollPingType('a')).not.toBe(snapshotFrameScrollPingType('b'));
    expect(stepFrameClickMessageType('a')).not.toBe(snapshotFrameScrollPingType('a'));
  });

  it('accepts a well-formed relayed click payload', () => {
    expect(isStepFrameClickPayload(validPayload, messageType)).toBe(true);
    expect(isStepFrameClickPayload({ ...validPayload, interactive: false }, messageType)).toBe(true);
    expect(isStepFrameClickPayload({ ...validPayload, text: '' }, messageType)).toBe(true);
  });

  it('rejects wrong types, malformed rects and oversized metadata', () => {
    expect(isStepFrameClickPayload(null, messageType)).toBe(false);
    expect(isStepFrameClickPayload({ ...validPayload, type: 'other' }, messageType)).toBe(false);
    for (const rect of [
      null,
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: -1 },
      { x: 2_000_000, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 2_000_000, height: 10 },
    ]) {
      expect(isStepFrameClickPayload({ ...validPayload, rect }, messageType)).toBe(false);
    }
    expect(isStepFrameClickPayload({ ...validPayload, text: 'x'.repeat(201) }, messageType)).toBe(false);
    expect(isStepFrameClickPayload({ ...validPayload, tagName: '' }, messageType)).toBe(false);
    expect(isStepFrameClickPayload({ ...validPayload, tagName: 'x'.repeat(101) }, messageType)).toBe(false);
    expect(isStepFrameClickPayload({ ...validPayload, interactive: 'yes' }, messageType)).toBe(false);
    expect(isStepFrameClickPayload({ ...validPayload, text: 42 }, messageType)).toBe(false);
  });

  it('validates replay responses strictly', () => {
    expect(isStepFrameClickResponse({ replay: true })).toBe(true);
    expect(isStepFrameClickResponse({ replay: false })).toBe(true);
    expect(isStepFrameClickResponse({ replay: 'true' })).toBe(false);
    expect(isStepFrameClickResponse({})).toBe(false);
    expect(isStepFrameClickResponse(null)).toBe(false);
  });

  it('answers and closes the response port, tolerating detached ports', () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    respondToStepFrameClick({ postMessage, close } as unknown as MessagePort, true);
    expect(postMessage).toHaveBeenCalledWith({ replay: true });
    expect(close).toHaveBeenCalledOnce();

    // A port whose peer is gone must not throw out of the responder.
    const throwing = {
      postMessage: vi.fn(() => {
        throw new Error('detached');
      }),
      close: vi.fn(() => {
        throw new Error('detached');
      }),
    } as unknown as MessagePort;
    expect(() => respondToStepFrameClick(throwing, false)).not.toThrow();
  });
});
