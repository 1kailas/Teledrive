const RELEASE_MARKER = /\b(?:2160p|1440p|1080p|720p|480p|4k|uhd|hdr10\+?|dolby.?vision|web[- .]?dl|webrip|bluray|blu-ray|brrip|bdrip|hdtv|dvdrip|remux|x264|x265|h[ .]?264|h[ .]?265|hevc|avc|10bit|8bit|proper|repack)\b/i;

/**
 * Turn release-style file names into presentable titles. Names that do not
 * look like scene releases are left untouched so punctuation in real titles
 * survives.
 */
export function cleanTitle(filename: string): string {
  const raw = filename.replace(/\.[^.]+$/, '') || filename;
  if (!RELEASE_MARKER.test(raw)) return raw;

  const normalized = raw.replace(/[._]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const releaseYear = /\b(?:19|20)\d{2}\b(?=\s*(?:2160p|1440p|1080p|720p|480p|4k|uhd|hdr|dolby|web[- .]?dl|bluray|blu-ray|brrip|bdrip|hdtv|dvdrip|remux|x26[45]|h[ .]?26[45]|hevc|avc|repack|proper|nf|amzn|dsnp|hmax|atvp|pcok|hulu|itunes))\b/i.exec(normalized);
  const marker = RELEASE_MARKER.exec(normalized);
  const cutoff = releaseYear?.index ?? marker?.index ?? normalized.length;
  const cleaned = normalized
    .slice(0, cutoff)
    .replace(/\s*[\(\[](?:19|20)\d{2}[\)\]]\s*$/, '')
    .replace(/[\s\-–—]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return cleaned.length >= 2 ? cleaned : raw;
}
