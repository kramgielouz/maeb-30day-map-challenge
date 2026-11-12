import type maplibregl from 'maplibre-gl';

// Reusable "download the run-through as a video" for any day.
// startVideo() copies the map canvas, crops it to the chosen shape (3:4 by default), lets the day draw its own title,
// year and legend on top, records the result, and resolves with the finished file when it is stopped.
// The day decides what plays while it records (years stepping, a line being walked) and when to call stop().

export type Ratio = '3:4' | '9:16' | '1:1' | '16:9' | 'screen';
export const RATIOS: Ratio[] = ['3:4', '9:16', '1:1', '16:9', 'screen'];
const ASPECT: Record<Exclude<Ratio, 'screen'>, number> = { '3:4': 3 / 4, '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 }; // width / height

export interface VideoOptions {
  map: maplibregl.Map;
  ratio?: Ratio; // default '3:4'
  shortSide?: number; // pixels along the shorter side of the video, default 1080 (so 3:4 is 1080 x 1440)
  focus?: { x: number; y: number }; // where the crop is centred, as fractions of the map canvas (default the middle)
  fps?: number; // default 30
  background?: string; // default black
  audio?: MediaStream | null; // optional sound track (Day 11)
  drawOverlay: (g: CanvasRenderingContext2D, w: number, h: number) => void; // draws on top of the map, in video pixels
}
export interface VideoResult {
  blob: Blob;
  ext: 'mp4' | 'webm';
  width: number;
  height: number;
}
export interface VideoSession {
  stop: () => void; // finish and resolve `done` with the video
  cancel: () => void; // throw the recording away (`done` resolves null)
  done: Promise<VideoResult | null>;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

// MP4 (H.264) where the browser can make it (Chrome/Edge 126+, Safari), otherwise WebM.
function pickMime(withAudio: boolean): { type: string; ext: 'mp4' | 'webm' } | null {
  const list = withAudio
    ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  if (typeof MediaRecorder === 'undefined') return null;
  const type = list.find((t) => MediaRecorder.isTypeSupported(t));
  return type ? { type, ext: type.startsWith('video/mp4') ? 'mp4' : 'webm' } : null;
}

export function startVideo(o: VideoOptions): VideoSession | null {
  const { map } = o;
  const src = map.getCanvas();
  const pick = pickMime(!!o.audio);
  if (!pick) return null;

  const outAspect = o.ratio && o.ratio !== 'screen' ? ASPECT[o.ratio] : src.width / src.height;
  const short = o.shortSide ?? 1080;
  const w = (outAspect >= 1 ? Math.round(short * outAspect) : short) & ~1; // even sizes suit video encoders
  const h = (outAspect >= 1 ? short : Math.round(short / outAspect)) & ~1;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  if (!('captureStream' in off)) return null;
  const g = off.getContext('2d')!;
  const fps = o.fps ?? 30;
  const stream = (off as any).captureStream(fps) as MediaStream;
  o.audio?.getAudioTracks().forEach((t) => stream.addTrack(t));
  const mr = new MediaRecorder(stream, { mimeType: pick.type, videoBitsPerSecond: 10_000_000 });
  const chunks: Blob[] = [];

  // Runs right after the map renders, while its WebGL buffer is still readable.
  const frame = () => {
    const sw = src.width;
    const sh = src.height;
    const cropW = sw / sh > outAspect ? sh * outAspect : sw; // the biggest crop of the map with the video's shape
    const cropH = sw / sh > outAspect ? sh : sw / outAspect;
    const sx = clamp((o.focus?.x ?? 0.5) * sw - cropW / 2, 0, sw - cropW);
    const sy = clamp((o.focus?.y ?? 0.5) * sh - cropH / 2, 0, sh - cropH);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = o.background ?? '#000';
    g.fillRect(0, 0, w, h);
    g.drawImage(src, sx, sy, cropW, cropH, 0, 0, w, h);
    o.drawOverlay(g, w, h);
  };
  map.on('render', frame);
  const timer = window.setInterval(() => map.triggerRepaint(), 1000 / fps); // keep frames flowing while the picture is still

  let cancelled = false;
  const done = new Promise<VideoResult | null>((resolve) => {
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      map.off('render', frame);
      clearInterval(timer);
      resolve(cancelled || !chunks.length ? null : { blob: new Blob(chunks, { type: pick.type.split(';')[0] }), ext: pick.ext, width: w, height: h });
    };
  });
  mr.start();
  return {
    stop: () => mr.state !== 'inactive' && mr.stop(),
    cancel: () => {
      cancelled = true;
      if (mr.state !== 'inactive') mr.stop();
    },
    done,
  };
}

export function downloadVideo(v: VideoResult, fileName: string) {
  const url = URL.createObjectURL(v.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName}.${v.ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Draw text with a dark outline, wrapped to maxW. Returns the y position for the next line.
export function drawWrapped(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number): number {
  const words = text.split(' ');
  let line = '';
  const out: string[] = [];
  for (const wd of words) {
    const test = line ? `${line} ${wd}` : wd;
    if (g.measureText(test).width > maxW && line) {
      out.push(line);
      line = wd;
    } else line = test;
  }
  if (line) out.push(line);
  out.forEach((l, i) => {
    g.strokeText(l, x, y + i * lineH);
    g.fillText(l, x, y + i * lineH);
  });
  return y + out.length * lineH;
}