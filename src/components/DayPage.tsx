import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import BaseMap from '../core/BaseMap';
import { DAYS, getDay } from '../days/registry';

const KEY = 'butuan-panel-open';

export default function DayPage() {
  const { n } = useParams();
  const day = getDay(Number(n));

  // The side panel can be hidden to give the map the whole screen. The choice is remembered.
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, open ? '1' : '0');
    } catch {
      /* private mode: just do not remember */
    }
  }, [open]);

  // Hiding is two steps: the panel slides out (cheap, map untouched), then the layout changes once.
  // Animating the layout itself would resize the map on every frame, which is what makes it flicker.
  const [closing, setClosing] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const hide = useCallback(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setOpen(false);
      return;
    }
    setClosing(true);
    timer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 200);
  }, []);
  const show = useCallback(() => setOpen(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (open && !closing) hide();
      else if (!open) show();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closing, hide, show]);

  if (!day) {
    return (
      <div className="page">
        <p>No such day.</p>
        <Link to="/">Back to the calendar</Link>
      </div>
    );
  }

  const prev = DAYS.find((d) => d.day === day.day - 1);
  const next = DAYS.find((d) => d.day === day.day + 1);
  const Day = day.Component;

  return (
    <div className={`day-layout${open ? '' : ' collapsed'}${closing ? ' closing' : ''}`}>
      <aside className="panel" aria-hidden={!open}>
        <div className="panel-head">
          <Link to="/" className="back">
            ← All days
          </Link>
          <button className="panel-toggle" onClick={hide} title="Hide panel ( [ )" aria-label="Hide panel" tabIndex={open ? 0 : -1}>
            ‹ Hide
          </button>
        </div>

        <nav className="daystrip" aria-label="All days">
          {DAYS.map((d) => (
            <Link
              key={d.day}
              to={`/day/${d.day}`}
              title={`Day ${d.day}: ${d.title}${d.Component ? '' : ' (planned)'}`}
              className={`${d.Component ? 'built' : ''}${d.day === day.day ? ' current' : ''}`}
              tabIndex={open ? 0 : -1}
            >
              {d.day}
            </Link>
          ))}
        </nav>

        <p className="eyebrow">
          Day {day.day} · {day.theme}
        </p>
        <h2>{day.title}</h2>
        <p className="prompt">{day.prompt}</p>
        <p className="insight">{day.insight}</p>

        {!Day && <p className="warn">This chapter has not been built yet.</p>}
        {day.needsHuman && <p className="muted">This day needs real-world input (people, field data or paper), not just online data.</p>}

        <details open>
          <summary>Data and methods</summary>
          <ul>{day.sources.length ? day.sources.map((s) => <li key={s}>{s}</li>) : <li>Not applicable</li>}</ul>
        </details>

        <nav className="pager" aria-label="Previous and next day">
          {prev ? (
            <Link to={`/day/${prev.day}`} tabIndex={open ? 0 : -1}>
              ← Day {prev.day}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link to={`/day/${next.day}`} tabIndex={open ? 0 : -1}>
              Day {next.day} →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </aside>

      <main className="map-area">
        {!open && (
          <button className="panel-open" onClick={show} title="Show panel ( [ )" aria-label="Show panel">
            › Day {day.day}
          </button>
        )}
        {/* key forces a fresh map per day so layers never leak between chapters */}
        <BaseMap key={day.day}>
          {(map) =>
            Day ? (
              <Suspense fallback={null}>
                <Day map={map} />
              </Suspense>
            ) : null
          }
        </BaseMap>
      </main>
    </div>
  );
}