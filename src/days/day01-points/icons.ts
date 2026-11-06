// Original line-drawn glyphs (24x24), white on a coloured round badge. No third-party icon licences involved.

export const KINDS: Record<string, { label: string; color: string }> = {
  hospital: { label: 'Hospital', color: '#e11d48' },
  clinic: { label: 'Clinic / health centre', color: '#f97316' },
  school: { label: 'School', color: '#2563eb' },
  fire_station: { label: 'Fire station', color: '#b91c1c' },
  police: { label: 'Police', color: '#334155' },
};

// c = badge colour, used for the cut-outs inside the glyph
const GLYPHS: Record<string, (c: string) => string> = {
  hospital: () => `<path fill="#fff" d="M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5z"/>`,
  clinic: (c) =>
    `<path fill="#fff" d="M12 3.2 21 10.4V20.5H3V10.4z"/><path fill="${c}" d="M10.8 11h2.4v2.2h2.2v2.4h-2.2v2.2h-2.4v-2.2H8.6v-2.4h2.2z"/>`,
  school: () =>
    `<path fill="#fff" d="M12 4 23 9.2 12 14.4 1 9.2z"/><path fill="#fff" d="M5.5 12.6v4.2c1.6 1.9 11.4 1.9 13 0v-4.2L12 15.7z"/><rect fill="#fff" x="21" y="9.6" width="1.4" height="6" rx=".7"/>`,
  fire_station: (c) =>
    `<path fill="#fff" d="M12.5 2.5c.3 3-1.2 4.6-2.7 6.3C8.3 10.5 6.5 12.4 6.5 15.2a5.5 5.5 0 0 0 11 0c0-2-.9-3.5-2-4.8-.2 1.3-.8 2.1-1.7 2.6.5-3.6-.3-7.4-1.3-10.5z"/><path fill="${c}" d="M12 20a2.6 2.6 0 0 1-2.6-2.6c0-1.5 1.1-2.3 2-3.4.3 1 1.2 1.4 1.7 2.2.7 1.1.6 2.3-.1 3.2-.3.4-.6.6-1 .6z"/>`,
  police: (c) =>
    `<path fill="#fff" d="M12 2.2 19.6 5v6.1c0 4.7-3.2 8.6-7.6 10.7C7.6 19.7 4.4 15.8 4.4 11.1V5z"/><path fill="${c}" d="M12 7.5 12.94 10.21 15.8 10.26 13.52 11.99 14.35 14.74 12 13.1 9.65 14.74 10.48 11.99 8.2 10.26 11.06 10.21z"/>`,
};

export function badgeSvg(kind: string, px = 64): string {
  const c = KINDS[kind]?.color ?? '#555';
  const g = (GLYPHS[kind] ?? GLYPHS.hospital)(c);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 32 32">` +
    `<circle cx="16" cy="16" r="14.5" fill="${c}" stroke="#fff" stroke-width="2"/>` +
    `<g transform="translate(6 6) scale(0.8333)">${g}</g></svg>`
  );
}

export const badgeUrl = (kind: string, px = 64) =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(badgeSvg(kind, px));

export const imageId = (kind: string) => `d01-${kind}`;

export function loadBadge(kind: string, px = 64): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image(px, px);
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = badgeUrl(kind, px);
  });
}
