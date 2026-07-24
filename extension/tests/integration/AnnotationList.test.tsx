// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Step } from '@/lib/storage/db';

vi.mock('@/lib/editor/editor-autosave', () => ({
  useStepDescriptionAutosave: (step: Step) => ({
    description: step.description,
    setDescription: vi.fn(),
    status: 'saved',
    error: null,
    recoveries: [],
    restoreRecovery: vi.fn(),
    discardRecovery: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
  }),
}));

import AnnotationList from '@/components/editor/AnnotationList';

function makeAnnotation(): Step {
  return {
    id: 'annotation-1',
    sessionId: 'session-1',
    order: 0,
    bounds: { x: 10, y: 10, width: 20, height: 20 },
    devicePixelRatio: 1,
    description: '標註內容',
    url: 'https://example.com/',
    timestamp: 1,
    groupId: 'snapshot-1',
  };
}

afterEach(cleanup);

describe('AnnotationList', () => {
  it('不在已儲存的標註說明下方顯示打勾圖示或已儲存文字', () => {
    const { container } = render(
      <AnnotationList
        annotations={[makeAnnotation()]}
        onChange={vi.fn()}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        onReorder={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText('標註 1 說明')).toBeTruthy();
    expect(screen.queryByText('已儲存')).toBeNull();
    expect(container.querySelector('.lucide-check')).toBeNull();
  });
});
