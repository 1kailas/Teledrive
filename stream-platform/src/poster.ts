export type PosterShape = 'wide' | 'square' | 'monogram' | 'backdrop';

export interface PosterOptions {
  seed: string;
  title: string;
  subtitle?: string;
  label?: string;
  category?: 'video' | 'audio';
  shape?: PosterShape;
  dense?: boolean;
}

interface Palette {
  base: string;
  deep: string;
  glow: string;
  ink: string;
}

const PALETTES: Palette[] = [
  { base: '#202a33', deep: '#070a0d', glow: '#587383', ink: '#f1ede4' },
  { base: '#2d2328', deep: '#0c080a', glow: '#754b58', ink: '#f4ebe7' },
  { base: '#1d2a23', deep: '#070c09', glow: '#4b6654', ink: '#ecf0e8' },
  { base: '#2d271d', deep: '#0e0b07', glow: '#7a6547', ink: '#f5eee2' },
  { base: '#232438', deep: '#090a10', glow: '#565c90', ink: '#ececf6' },
  { base: '#2c2722', deep: '#0c0a09', glow: '#716353', ink: '#f3ede4' },
];

const ACCENT = '#ff4d33';
const FONT = "Geist, 'Helvetica Neue', Arial, sans-serif";

function hashOf(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&apos;';
    }
  });
}

function trimTo(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function wrapTitle(title: string, maxChars: number, maxLines: number): string[] {
  const words = title.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return ['Untitled'];

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines) {
      const last = lines[maxLines - 1]!;
      lines[maxLines - 1] = `${last.replace(/[\s,.;:!?–—-]+$/, '')}…`;
      return lines;
    }
  }

  if (current) {
    if (lines.length >= maxLines) {
      const last = lines[maxLines - 1]!;
      lines[maxLines - 1] = `${last.replace(/[\s,.;:!?–—-]+$/, '')}…`;
    } else {
      lines.push(current);
    }
  }

  return lines.slice(0, maxLines);
}

function ringMotif(width: number, height: number, ink: string): string {
  const cx = width * 0.76;
  const cy = height * 0.29;
  return `<g fill="none" stroke="${ink}" stroke-opacity=".18">
    <circle cx="${cx}" cy="${cy}" r="${height * 0.25}" stroke-width="1.6"/>
    <circle cx="${cx}" cy="${cy}" r="${height * 0.38}" stroke-width="1.2"/>
    <circle cx="${cx}" cy="${cy}" r="${height * 0.52}" stroke-width="1"/>
    <circle cx="${cx}" cy="${cy}" r="${height * 0.68}" stroke-width=".8" stroke-opacity=".12"/>
  </g>
  <circle cx="${cx}" cy="${cy}" r="${height * 0.085}" fill="${ink}" fill-opacity=".08"/>`;
}

function horizonMotif(width: number, height: number, ink: string, glow: string): string {
  return `<circle cx="${width * 0.78}" cy="${height * 0.24}" r="${height * 0.12}" fill="${glow}" opacity=".34"/>
  <g fill="none" stroke="${ink}" stroke-opacity=".2" stroke-width="1.4">
    <path d="M0 ${height * 0.6} C ${width * 0.18} ${height * 0.48}, ${width * 0.39} ${height * 0.74}, ${width * 0.58} ${height * 0.57} S ${width * 0.85} ${height * 0.4}, ${width} ${height * 0.52}"/>
    <path d="M0 ${height * 0.7} C ${width * 0.2} ${height * 0.58}, ${width * 0.41} ${height * 0.84}, ${width * 0.61} ${height * 0.67} S ${width * 0.86} ${height * 0.5}, ${width} ${height * 0.62}"/>
    <path d="M0 ${height * 0.8} C ${width * 0.22} ${height * 0.68}, ${width * 0.43} ${height * 0.94}, ${width * 0.64} ${height * 0.77} S ${width * 0.88} ${height * 0.6}, ${width} ${height * 0.72}" stroke-opacity=".12"/>
  </g>`;
}

function beamMotif(width: number, height: number, ink: string): string {
  return `<g opacity=".2" stroke="${ink}" stroke-width="1">
    <path d="M${-width * 0.1} ${height} L${width * 0.46} 0"/>
    <path d="M${width * 0.04} ${height} L${width * 0.6} 0"/>
    <path d="M${width * 0.18} ${height} L${width * 0.74} 0"/>
    <path d="M${width * 0.32} ${height} L${width * 0.88} 0"/>
    <path d="M${width * 0.46} ${height} L${width * 1.02} 0"/>
  </g>
  <rect x="${width * 0.63}" y="${height * 0.16}" width="${width * 0.22}" height="1" fill="${ink}" opacity=".24"/>`;
}

function slatMotif(width: number, height: number, ink: string): string {
  const count = 7;
  const gap = width * 0.047;
  const start = width * 0.55;
  let bars = '';
  for (let index = 0; index < count; index += 1) {
    const barHeight = height * (0.16 + ((index * 37) % 41) / 100);
    bars += `<rect x="${start + index * gap}" y="${height * 0.19}" width="${Math.max(2, width * 0.012)}" height="${barHeight}" fill="${ink}" opacity="${0.06 + (index % 3) * 0.035}"/>`;
  }
  return `<g>${bars}</g>`;
}

function waveformMotif(width: number, height: number, ink: string, hash: number, shape: PosterShape): string {
  const count = shape === 'square' ? 16 : 26;
  const step = width * (shape === 'square' ? 0.024 : 0.016);
  const barWidth = Math.max(3, step * 0.42);
  const start = width * 0.54;
  const center = height * 0.37;
  let bars = '';
  for (let index = 0; index < count; index += 1) {
    const value = ((hash >>> (index % 24)) & 31) / 31;
    const barHeight = height * (0.06 + value * 0.3);
    bars += `<rect x="${start + index * step}" y="${center - barHeight / 2}" width="${barWidth}" height="${barHeight}" rx="${barWidth / 2}" fill="${ink}" opacity="${0.1 + value * 0.18}"/>`;
  }
  return `<g>${bars}</g>`;
}

function monogram(width: number, height: number, ink: string, title: string): string {
  const initial = escapeXml((title.trim().charAt(0) || 'F').toUpperCase());
  return `<g>
    <circle cx="${width / 2}" cy="${height / 2}" r="${width * 0.3}" fill="none" stroke="${ink}" stroke-opacity=".2" stroke-width="1.5"/>
    <circle cx="${width / 2}" cy="${height / 2}" r="${width * 0.39}" fill="none" stroke="${ink}" stroke-opacity=".1" stroke-width="1"/>
    <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="${FONT}" font-size="${width * 0.4}" font-weight="650" letter-spacing="-8" fill="${ink}" fill-opacity=".9">${initial}</text>
    <circle cx="${width * 0.72}" cy="${height * 0.28}" r="4" fill="${ACCENT}"/>
  </g>`;
}

function titleBlock(options: {
  width: number;
  height: number;
  ink: string;
  title: string;
  subtitle?: string;
  label?: string;
  dense: boolean;
  shape: PosterShape;
}): string {
  const { width, height, ink, title, subtitle, label, dense, shape } = options;
  const square = shape === 'square';
  const pad = square ? 64 : 84;
  const badge = label ? trimTo(label.toUpperCase(), 22) : '';
  const badgeWidth = badge ? Math.max(96, 38 + badge.length * 11.5) : 0;

  const lines = wrapTitle(
    title,
    dense ? (square ? 20 : 34) : (square ? 24 : 34),
    dense ? 1 : 2,
  );
  const fontSize = dense ? (square ? 42 : 54) : (square ? 56 : 74);
  const lineHeight = Math.round(fontSize * 1.14);
  const subtitleText = subtitle ? trimTo(subtitle, square ? 34 : 52) : '';
  const subtitleSize = square ? 19 : 21;
  const subtitleGap = subtitleText ? 36 : 0;
  const lastBaseline = height - pad - subtitleGap;
  const firstBaseline = lastBaseline - (lines.length - 1) * lineHeight;

  const badgeMarkup = badge ? `<g transform="translate(${pad}, ${pad})">
    <rect width="${badgeWidth}" height="40" rx="20" fill="#05070a" fill-opacity=".44" stroke="${ink}" stroke-opacity=".2"/>
    <text x="${badgeWidth / 2}" y="26" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="600" letter-spacing="2.4" fill="${ink}" fill-opacity=".78">${escapeXml(badge)}</text>
  </g>` : '';

  const titleLines = lines.map((line, index) => (
    `<text x="${pad}" y="${firstBaseline + index * lineHeight}" font-family="${FONT}" font-size="${fontSize}" font-weight="600" letter-spacing="${square ? -2.2 : -3.2}" fill="${ink}" fill-opacity=".96">${escapeXml(line)}</text>`
  )).join('');

  const subtitleMarkup = subtitleText
    ? `<text x="${pad + 1}" y="${height - pad}" font-family="${FONT}" font-size="${subtitleSize}" font-weight="500" letter-spacing="1.6" fill="${ink}" fill-opacity=".58">${escapeXml(subtitleText.toUpperCase())}</text>`
    : '';

  return `${badgeMarkup}
  <rect x="${pad}" y="${firstBaseline - lineHeight - 22}" width="36" height="3" rx="1.5" fill="${ACCENT}" fill-opacity=".92"/>
  ${titleLines}
  ${subtitleMarkup}
  <text x="${width - pad}" y="${pad + 22}" text-anchor="end" font-family="${FONT}" font-size="14" font-weight="600" letter-spacing="4" fill="${ink}" fill-opacity=".42">FOLIO</text>`;
}

export function posterSvg(options: PosterOptions): string {
  const {
    seed, title, subtitle, label,
    category = 'video',
    shape = 'wide',
    dense = false,
  } = options;

  const hash = hashOf(`${seed}:${title}`);
  const palette = PALETTES[hash % PALETTES.length]!;
  const monogramShape = shape === 'monogram';
  const width = monogramShape ? 512 : shape === 'square' ? 900 : 1600;
  const height = monogramShape ? 512 : shape === 'square' ? 900 : 900;

  if (monogramShape) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${palette.base}"/>
          <stop offset=".72" stop-color="${palette.deep}"/>
        </linearGradient>
        <radialGradient id="glow" cx="78%" cy="8%" r="90%">
          <stop offset="0" stop-color="${palette.glow}" stop-opacity=".78"/>
          <stop offset="1" stop-color="${palette.deep}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#base)"/>
      <rect width="${width}" height="${height}" fill="url(#glow)"/>
      ${monogram(width, height, palette.ink, title)}
    </svg>`;
  }

  const motif = category === 'audio'
    ? waveformMotif(width, height, palette.ink, hash, shape)
    : [ringMotif(width, height, palette.ink), horizonMotif(width, height, palette.ink, palette.glow),
      beamMotif(width, height, palette.ink), slatMotif(width, height, palette.ink)][hash % 4]!;

  const backdropLetter = shape === 'backdrop'
    ? `<text x="${width * 0.95}" y="${height * 1.02}" text-anchor="end" font-family="${FONT}" font-size="${height * 0.92}" font-weight="700" letter-spacing="${-height * 0.07}" fill="${palette.ink}" fill-opacity=".045">${escapeXml((title.trim().charAt(0) || 'F').toUpperCase())}</text>`
    : '';

  const copy = shape === 'backdrop'
    ? ''
    : titleBlock({ width, height, ink: palette.ink, title, subtitle, label, dense, shape });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${palette.base}"/>
        <stop offset=".72" stop-color="${palette.deep}"/>
      </linearGradient>
      <radialGradient id="glow" cx="76%" cy="10%" r="92%">
        <stop offset="0" stop-color="${palette.glow}" stop-opacity=".82"/>
        <stop offset=".58" stop-color="${palette.base}" stop-opacity=".38"/>
        <stop offset="1" stop-color="${palette.deep}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#050608" stop-opacity=".04"/>
        <stop offset=".54" stop-color="#050608" stop-opacity=".18"/>
        <stop offset="1" stop-color="#050608" stop-opacity=".9"/>
      </linearGradient>
      <pattern id="grain" width="7" height="7" patternUnits="userSpaceOnUse">
        <circle cx="1" cy="1" r=".65" fill="${palette.ink}" fill-opacity=".055"/>
      </pattern>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#base)"/>
    <rect width="${width}" height="${height}" fill="url(#glow)"/>
    ${motif}
    ${backdropLetter}
    <rect width="${width}" height="${height}" fill="url(#shade)"/>
    <rect width="${width}" height="${height}" fill="url(#grain)"/>
    ${copy}
  </svg>`;
}

export function posterDataUrl(options: PosterOptions): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(posterSvg(options))}`;
}
