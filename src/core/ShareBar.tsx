import { useState } from 'react';
import type { VideoResult } from './videoExport';

// Share buttons for a day: the phone's own share sheet (which can attach the video), Facebook, X, WhatsApp, Telegram,
// LinkedIn, a copy-link button and a re-download button.
// Social sites only take a link, not a video file, so those buttons share the page's address. The page must be on
// a public address for that to work (not localhost). To post the video itself, use "Share…" on a phone, or save it
// and upload it in the app (Instagram, TikTok, Facebook).
export default function ShareBar({ title, text, url, video, fileName }: { title: string; text?: string; url?: string; video?: VideoResult | null; fileName: string }) {
  const [note, setNote] = useState('');
  const link = url ?? window.location.href.split('#')[0];
  const local = /^(localhost|127\.|192\.168\.|10\.)/.test(window.location.hostname);
  const msg = text ?? title;
  const enc = encodeURIComponent;
  const open = (u: string) => window.open(u, '_blank', 'noopener,noreferrer');
  const file = video ? new File([video.blob], `${fileName}.${video.ext}`, { type: video.blob.type }) : null;
  const canShareFile = !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  const canShareLink = typeof navigator.share === 'function';

  const nativeShare = async () => {
    try {
      await navigator.share({ title, text: `${msg} ${link}`, ...(canShareFile && file ? { files: [file] } : {}) });
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') setNote('Sharing did not work here. Try the buttons beside it.');
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setNote('Link copied.');
    } catch {
      setNote(link);
    }
  };
  const save = () => {
    if (!video) return;
    const u = URL.createObjectURL(video.blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = `${fileName}.${video.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  };

  const btn: React.CSSProperties = { padding: '6px 10px', borderRadius: 14, border: '1px solid var(--line, #cbd5e1)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12.5, cursor: 'pointer' };
  return (
    <div style={{ margin: '8px 0 4px' }}>
      <p className="sub" style={{ marginBottom: 4 }}>
        Share {video ? 'the video' : 'this map'}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {video && (
          <button style={{ ...btn, background: 'var(--accent)', color: 'var(--on-accent, #fff)', border: 0, fontWeight: 700 }} onClick={save}>
            Save video
          </button>
        )}
        {(canShareFile || canShareLink) && (
          <button style={btn} onClick={nativeShare}>
            {canShareFile ? 'Share video…' : 'Share…'}
          </button>
        )}
        <button style={btn} onClick={() => open(`https://www.facebook.com/sharer/sharer.php?u=${enc(link)}`)}>
          Facebook
        </button>
        <button style={btn} onClick={() => open(`https://twitter.com/intent/tweet?text=${enc(msg)}&url=${enc(link)}`)}>
          X
        </button>
        <button style={btn} onClick={() => open(`https://wa.me/?text=${enc(`${msg} ${link}`)}`)}>
          WhatsApp
        </button>
        <button style={btn} onClick={() => open(`https://t.me/share/url?url=${enc(link)}&text=${enc(msg)}`)}>
          Telegram
        </button>
        <button style={btn} onClick={() => open(`https://www.linkedin.com/sharing/share-offsite/?url=${enc(link)}`)}>
          LinkedIn
        </button>
        <button style={btn} onClick={copy}>
          Copy link
        </button>
      </div>
      {note && (
        <p className="muted" style={{ margin: '4px 0 0' }}>
          {note}
        </p>
      )}
      <p className="muted" style={{ margin: '4px 0 0', fontSize: 11 }}>
        {local ? 'This address is only on your computer, so a shared link would not open for anyone else. Deploy the site first. ' : ''}
        The social buttons share a link, not the video file. For Instagram or TikTok, save the video and upload it in the app.
      </p>
    </div>
  );
}