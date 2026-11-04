import { describe, it, expect, beforeEach } from 'vitest';
import { useUi, usePreview, useClipboard, useDialog, useToasts } from '../src/store';
import type { FileDTO } from '../src/api';

describe('Web Zustand Stores', () => {
  beforeEach(() => {
    useUi.setState({
      theme: 'system',
      viewMode: 'grid',
      cardSize: 'standard',
      nameDisplay: 'full',
      sortBy: 'name',
      sortDir: 'asc',
      detailsOpen: false,
    });
    usePreview.setState({ files: [], index: 0, open: false });
    useClipboard.setState({ items: [], mode: null });
    useDialog.setState({ dialog: null });
  });

  describe('useUi', () => {
    it('updates view mode between grid and list', () => {
      expect(useUi.getState().viewMode).toBe('grid');
      useUi.getState().setViewMode('list');
      expect(useUi.getState().viewMode).toBe('list');
    });

    it('updates card size across scale tiers', () => {
      useUi.getState().setCardSize('compact');
      expect(useUi.getState().cardSize).toBe('compact');
      useUi.getState().setCardSize('tiny');
      expect(useUi.getState().cardSize).toBe('tiny');
      useUi.getState().setCardSize('large');
      expect(useUi.getState().cardSize).toBe('large');
    });

    it('updates sorting parameters', () => {
      useUi.getState().setSort('size', 'desc');
      expect(useUi.getState().sortBy).toBe('size');
      expect(useUi.getState().sortDir).toBe('desc');
    });

    it('toggles details drawer and sidebar', () => {
      useUi.getState().setDetailsOpen(true);
      expect(useUi.getState().detailsOpen).toBe(true);
      useUi.getState().setDetailsOpen(false);
      expect(useUi.getState().detailsOpen).toBe(false);
    });
  });

  describe('usePreview', () => {
    const dummyFiles = [
      { id: '1', name: 'photo1.jpg' } as FileDTO,
      { id: '2', name: 'photo2.jpg' } as FileDTO,
      { id: '3', name: 'photo3.jpg' } as FileDTO,
    ];

    it('starts preview at given index and clamps navigation', () => {
      usePreview.getState().start(dummyFiles, 1);
      expect(usePreview.getState().open).toBe(true);
      expect(usePreview.getState().index).toBe(1);

      // Nav forward
      usePreview.getState().nav(1);
      expect(usePreview.getState().index).toBe(2);

      // Nav forward beyond end -> should clamp
      usePreview.getState().nav(1);
      expect(usePreview.getState().index).toBe(2);

      // Nav backward beyond start -> should clamp to 0
      usePreview.getState().nav(-5);
      expect(usePreview.getState().index).toBe(0);

      usePreview.getState().close();
      expect(usePreview.getState().open).toBe(false);
    });
  });

  describe('useClipboard', () => {
    it('sets and clears clipboard items', () => {
      useClipboard.getState().setClipboard([{ id: 'f-1', kind: 'file', name: 'document.pdf' }], 'cut');
      expect(useClipboard.getState().items.length).toBe(1);
      expect(useClipboard.getState().mode).toBe('cut');

      useClipboard.getState().clearClipboard();
      expect(useClipboard.getState().items.length).toBe(0);
      expect(useClipboard.getState().mode).toBeNull();
    });
  });

  describe('useDialog', () => {
    it('opens and closes dialogs', () => {
      useDialog.getState().open({ kind: 'newFolder', parentId: 'root' });
      expect(useDialog.getState().dialog).toEqual({ kind: 'newFolder', parentId: 'root' });

      useDialog.getState().close();
      expect(useDialog.getState().dialog).toBeNull();
    });
  });

  describe('useToasts', () => {
    it('pushes and dismisses notifications', () => {
      useToasts.getState().push({ text: 'File uploaded successfully', kind: 'success' });
      const currentToasts = useToasts.getState().toasts;
      expect(currentToasts.length).toBeGreaterThan(0);
      const id = currentToasts[currentToasts.length - 1]!.id;

      useToasts.getState().dismiss(id);
      expect(useToasts.getState().toasts.some((t) => t.id === id)).toBe(false);
    });
  });
});
