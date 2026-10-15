// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import ImageEditLayer from '@/components/editor/ImageEditLayer';
import type { ImageEditItem } from '@/lib/editor/image-edit-items';

const size = { width: 400, height: 200 };
const item: ImageEditItem = { id: 'mask-1', kind: 'redaction', bounds: { x: 100, y: 50, width: 80, height: 40 } };

beforeAll(() => {
  // jsdom has no layout or pointer capture: 1 CSS px of image == 1 client px.
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.setPointerCapture = () => undefined;
});
afterEach(cleanup);

function setup(overrides: Partial<React.ComponentProps<typeof ImageEditLayer>> = {}) {
  const handlers = { onSelect: vi.fn(), onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn() };
  const view = render(
    <ImageEditLayer items={[item]} tool="redact" size={size} selectedId={null} {...handlers} {...overrides} />,
  );
  const layer = view.container.querySelector('[data-stepmark-image-edit-layer]') as HTMLElement;
  return { ...handlers, layer };
}

describe('ImageEditLayer', () => {
  it('creates an item from a drag on empty image with the mask tool', () => {
    const { layer, onCreate } = setup();
    fireEvent.pointerDown(layer, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 60, clientY: 40 });
    fireEvent.pointerUp(layer);
    expect(onCreate).toHaveBeenCalledWith('redaction', { x: 10, y: 10, width: 50, height: 30 });
  });

  it('ignores a stray click that is too small to be a mask', () => {
    const { layer, onCreate } = setup();
    fireEvent.pointerDown(layer, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerUp(layer);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('does not create items with the select tool', () => {
    const { layer, onCreate, onSelect } = setup({ tool: 'select' });
    fireEvent.pointerDown(layer, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 60, clientY: 40 });
    fireEvent.pointerUp(layer);
    expect(onCreate).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('moves an item by dragging it and reports the final bounds once', () => {
    const { layer, onUpdate, onSelect } = setup();
    fireEvent.pointerDown(screen.getByRole('button', { name: /./ }), { clientX: 120, clientY: 60, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 150, clientY: 80 });
    fireEvent.pointerUp(layer);
    expect(onSelect).toHaveBeenCalledWith('mask-1');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith('mask-1', { x: 130, y: 70, width: 80, height: 40 });
  });

  it('resizes through a handle of the selected item', () => {
    const { layer, onUpdate } = setup({ selectedId: 'mask-1' });
    const handle = layer.querySelector('[data-stepmark-edit-handle="se"]') as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 180, clientY: 90, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(layer);
    expect(onUpdate).toHaveBeenCalledWith('mask-1', { x: 100, y: 50, width: 100, height: 50 });
  });

  it('supports keyboard nudge and delete on a focused item', () => {
    const { onUpdate, onDelete } = setup({ selectedId: 'mask-1' });
    const button = screen.getByRole('button', { name: /./ });
    fireEvent.keyDown(button, { key: 'ArrowRight', shiftKey: true });
    expect(onUpdate).toHaveBeenCalledWith('mask-1', { x: 110, y: 50, width: 80, height: 40 });
    fireEvent.keyDown(button, { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledWith('mask-1');
  });

  it('is inert while disabled', () => {
    const { layer, onCreate, onUpdate, onDelete } = setup({ disabled: true });
    fireEvent.pointerDown(layer, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(layer, { clientX: 90, clientY: 90 });
    fireEvent.pointerUp(layer);
    fireEvent.keyDown(screen.getByRole('button', { name: /./ }), { key: 'Delete' });
    expect(onCreate).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
