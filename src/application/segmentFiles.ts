import type { SegmentDescriptor } from "./OrderedSegmentQueue";

export interface SegmentFileEntry {
  name: string;
  path: string;
  mtimeMs: number;
  isFile: boolean;
}

export function collectSegmentDescriptors(entries: SegmentFileEntry[], now: number, allowNewestOpenSegment: boolean): SegmentDescriptor[] {
  const parsed = entries
    .map((entry) => {
      const match = entry.name.match(/^segment-(\d{4})\.mp3$/i);
      if (!match || !entry.isFile) return null;
      return {
        index: Number(match[1]),
        path: entry.path,
        mtimeMs: entry.mtimeMs,
      };
    })
    .filter((entry): entry is { index: number; path: string; mtimeMs: number } => Boolean(entry))
    .sort((left, right) => left.index - right.index);

  if (parsed.length === 0) return [];

  const newestIndex = parsed[parsed.length - 1]?.index ?? -1;
  return parsed
    .filter((entry) => {
      if (allowNewestOpenSegment) return true;
      if (entry.index === newestIndex) return false;
      return now - entry.mtimeMs >= 1_500;
    })
    .map(({ index, path }) => ({ index, path }));
}
