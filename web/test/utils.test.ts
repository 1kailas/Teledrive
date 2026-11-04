import { describe, it, expect } from 'vitest';
import {
  fmtBytes,
  fmtDate,
  fmtDuration,
  typeLabel,
  relDate,
  sortItems,
  isTextEditable,
  cmLanguageExt,
} from '../src/utils';
import type { FileDTO } from '../src/api';

describe('Web Utility Functions', () => {
  describe('fmtBytes', () => {
    it('handles zero bytes', () => {
      expect(fmtBytes(0)).toBe('0 B');
    });

    it('formats exact byte counts', () => {
      expect(fmtBytes(500)).toBe('500 B');
      expect(fmtBytes(1023)).toBe('1023 B');
    });

    it('formats KiB and MiB correctly', () => {
      expect(fmtBytes(1024)).toBe('1.0 KiB');
      expect(fmtBytes(1536)).toBe('1.5 KiB');
      expect(fmtBytes(1048576)).toBe('1.0 MiB');
      expect(fmtBytes(5242880)).toBe('5.0 MiB');
    });

    it('formats GiB and TiB correctly', () => {
      expect(fmtBytes(1073741824)).toBe('1.0 GiB');
      expect(fmtBytes(1099511627776)).toBe('1.0 TiB');
    });
  });

  describe('fmtDuration', () => {
    it('returns empty string on null/undefined', () => {
      expect(fmtDuration(null)).toBe('');
    });

    it('formats zero seconds', () => {
      expect(fmtDuration(0)).toBe('0:00');
    });

    it('formats seconds with zero padding', () => {
      expect(fmtDuration(5)).toBe('0:05');
      expect(fmtDuration(59)).toBe('0:59');
    });

    it('formats minutes and seconds', () => {
      expect(fmtDuration(60)).toBe('1:00');
      expect(fmtDuration(125)).toBe('2:05');
      expect(fmtDuration(3665)).toBe('61:05');
    });
  });

  describe('typeLabel', () => {
    it('resolves specific file extensions', () => {
      expect(typeLabel({ ext: 'png', category: 'image' })).toBe('PNG image');
      expect(typeLabel({ ext: 'pdf', category: 'document' })).toBe('PDF');
      expect(typeLabel({ ext: 'mp4', category: 'video' })).toBe('MP4 video');
      expect(typeLabel({ ext: 'zip', category: 'archive' })).toBe('ZIP archive');
      expect(typeLabel({ ext: 'rs', category: 'code' })).toBe('Rust');
      expect(typeLabel({ ext: 'ts', category: 'code' })).toBe('TypeScript');
    });

    it('falls back to category when extension is unknown', () => {
      expect(typeLabel({ ext: 'xyz123', category: 'image' })).toBe('Image');
      expect(typeLabel({ ext: 'unknown', category: 'video' })).toBe('Video');
      expect(typeLabel({ ext: '', category: 'other' })).toBe('File');
    });
  });

  describe('relDate & fmtDate', () => {
    it('returns em dash for null or zero', () => {
      expect(relDate(null)).toBe('—');
      expect(fmtDate(null)).toBe('—');
    });

    it('formats valid timestamp properly', () => {
      const ts = new Date('2025-05-15T12:00:00Z').getTime();
      expect(relDate(ts)).toContain('2025');
    });
  });

  describe('sortItems', () => {
    const items = [
      { name: 'file10.txt', size: 1000, updatedAt: 100, category: 'document' },
      { name: 'file2.txt', size: 200, updatedAt: 300, category: 'document' },
      { name: 'file1.txt', size: 50, updatedAt: 200, category: 'code' },
    ];

    it('sorts numerically by name ascending', () => {
      const sorted = sortItems(items, 'name', 'asc');
      expect(sorted.map((i) => i.name)).toEqual(['file1.txt', 'file2.txt', 'file10.txt']);
    });

    it('sorts numerically by name descending', () => {
      const sorted = sortItems(items, 'name', 'desc');
      expect(sorted.map((i) => i.name)).toEqual(['file10.txt', 'file2.txt', 'file1.txt']);
    });

    it('sorts by size ascending', () => {
      const sorted = sortItems(items, 'size', 'asc');
      expect(sorted.map((i) => i.size)).toEqual([50, 200, 1000]);
    });

    it('sorts by size descending', () => {
      const sorted = sortItems(items, 'size', 'desc');
      expect(sorted.map((i) => i.size)).toEqual([1000, 200, 50]);
    });

    it('sorts by updatedAt ascending', () => {
      const sorted = sortItems(items, 'updatedAt', 'asc');
      expect(sorted.map((i) => i.updatedAt)).toEqual([100, 200, 300]);
    });
  });

  describe('isTextEditable', () => {
    it('identifies code and text files as editable', () => {
      const codeFile = {
        id: '1',
        name: 'app.ts',
        extension: 'ts',
        category: 'code',
        mimeType: 'application/typescript',
      } as FileDTO;
      expect(isTextEditable(codeFile)).toBe(true);

      const markdownFile = {
        id: '2',
        name: 'notes.md',
        extension: 'md',
        category: 'document',
        mimeType: 'text/markdown',
      } as FileDTO;
      expect(isTextEditable(markdownFile)).toBe(true);

      const binaryFile = {
        id: '3',
        name: 'app.exe',
        extension: 'exe',
        category: 'other',
        mimeType: 'application/octet-stream',
      } as FileDTO;
      expect(isTextEditable(binaryFile)).toBe(false);
    });
  });

  describe('cmLanguageExt', () => {
    it('returns appropriate CodeMirror language extension modes', () => {
      expect(cmLanguageExt('ts')).toEqual(['javascript']);
      expect(cmLanguageExt('py')).toEqual(['python']);
      expect(cmLanguageExt('md')).toEqual(['markdown']);
      expect(cmLanguageExt('unknown')).toEqual([]);
    });
  });
});
