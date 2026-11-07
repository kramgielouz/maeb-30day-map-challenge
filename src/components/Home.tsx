import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, RefObject } from 'react';
import { Link } from 'react-router-dom';
import { DAYS, builtCount } from '../days/registry';
import type { DayEntry } from '../days/registry';
import HeroMap from './HeroMap';
import { reducedMotion } from './motion';
import './home.css';

const TOTAL = 30;
const START = Date.UTC(2026, 10, 1); // 1 November 2026

/** Challenge day for a given date: below 1 before the start, above 30 after the end. */
function challengeDay(now = new Date()): number {
  const ms = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - START;
  return Math.round(ms / 86400000) + 1;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const statusOf = (d: DayEntry) => (d.Component ? 'Live' : 'Planned');

function useCountUp(target: number, ms = 900): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (reducedMotion()) {
      setV(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function useInView<T extends Element>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

export default function Home() {
  const today = challengeDay();
  // highest-numbered chapter that exists
  const latest = useMemo(() => [...DAYS].reverse().find((d) => d.Component) ?? null, []);
  return (
    <div className="home">
      <Hero today={today} latest={latest} />
      <Marquee />
      <Calendar today={today} latest={latest} />
      <Footer />
    </div>
  );
}

function Hero({ today, latest }: { today: number; latest: DayEntry | null }) {
  const live = useCountUp(builtCount);
  const dayNow = useCountUp(Math.min(Math.max(today, 0), TOTAL));
  const left = Math.max(0, TOTAL - Math.max(today, 0));
  const status = today < 1 ? 'Starts 1 November' : today > TOTAL ? 'Challenge complete' : `Day ${today} of ${TOTAL}`;
  const toCalendar = () =>
    document.getElementById('calendar')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });

  return (
    <header className="h-hero">
      <HeroMap />
      <div className="h-shade" />

      <nav className="h-nav">
        <span className="h-brand">Butuan Unfolded</span>
        <span className="h-nav-links">
          <button type="button" onClick={toCalendar}>
            Calendar
          </button>
          {latest && <Link to={`/day/${latest.day}`}>Latest: Day {latest.day}</Link>}
        </span>
      </nav>

      <div className="h-content">
        <p className="h-tag">
          <i /> #30DayMapChallenge 2026 · {status}
        </p>
        <h1>
          Butuan
          <br />
          <span>Unfolded</span>
        </h1>
        <p className="h-lede">
          Thirty maps, one app. A thread through all of them: how water, heat, access and people interact in Butuan City
          and Caraga. Built on open data.
        </p>
        <ul className="h-thread" aria-label="The thread">
          <li data-k="water">Water</li>
          <li data-k="heat">Heat</li>
          <li data-k="access">Access</li>
          <li data-k="people">People</li>
        </ul>

        <div className="h-cta">
          {latest ? (
            <Link className="h-btn primary" to={`/day/${latest.day}`}>
              Open Day {latest.day}: {latest.title}
            </Link>
          ) : (
            <Link className="h-btn primary" to="/day/1">
              Start with Day 1
            </Link>
          )}
          <button type="button" className="h-btn" onClick={toCalendar}>
            Browse all 30 days
          </button>
        </div>

        <dl className="h-stats">
          <div>
            <dt>Live chapters</dt>
            <dd>{live}</dd>
          </div>
          <div>
            <dt>Challenge day</dt>
            <dd>{today < 1 ? '—' : dayNow}</dd>
          </div>
          <div>
            <dt>Days left</dt>
            <dd>{left}</dd>
          </div>
        </dl>

        <nav className="h-ticks" aria-label="Jump to a day">
          {DAYS.map((d) => (
            <Link
              key={d.day}
              to={`/day/${d.day}`}
              className={`${d.Component ? 'live' : ''}${d.day === today ? ' today' : ''}`}
              title={`Day ${d.day} · ${d.theme} · ${statusOf(d)}`}
              aria-label={`Day ${d.day}, ${d.theme}, ${statusOf(d)}`}
            />
          ))}
        </nav>
      </div>
    </header>
  );
}

function Marquee() {
  const words = DAYS.map((d) => d.theme);
  return (
    <div className="h-marquee" aria-hidden="true">
      <div className="h-marquee-track">
        {[...words, ...words].map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
    </div>
  );
}

type Filter = 'all' | 'live' | 'planned' | 'people';

const matches = (d: DayEntry, f: Filter): boolean =>
  f === 'all' || (f === 'live' && !!d.Component) || (f === 'planned' && !d.Component) || (f === 'people' && !!d.needsHuman);

function Calendar({ today, latest }: { today: number; latest: DayEntry | null }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [active, setActive] = useState<number>(latest?.day ?? 1);
  const [ref, seen] = useInView<HTMLOListElement>();

  const filters: { id: Filter; label: string; n: number }[] = [
    { id: 'all', label: 'All', n: DAYS.length },
    { id: 'live', label: 'Live', n: DAYS.filter((d) => d.Component).length },
    { id: 'planned', label: 'Planned', n: DAYS.filter((d) => !d.Component).length },
    { id: 'people', label: 'Needs people', n: DAYS.filter((d) => d.needsHuman).length },
  ];
  const current = DAYS.find((d) => d.day === active) ?? DAYS[0];

  return (
    <section id="calendar" className="h-cal">
      <div className="h-cal-head">
        <div>
          <p className="eyebrow">The calendar</p>
          <h2>Thirty days, thirty maps</h2>
          <p className="h-sub">
            Hover or focus a day to read its prompt. Filled tiles are live. Dashed tiles need real-world input that online data
            alone cannot supply.
          </p>
        </div>
        <div className="h-filters" role="group" aria-label="Filter days">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              className={filter === f.id ? 'on' : ''}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label} <b>{f.n}</b>
            </button>
          ))}
        </div>
      </div>

      <ol ref={ref} className={`h-grid${seen ? ' in' : ''}`}>
        {DAYS.map((d, i) => (
          <Tile
            key={d.day}
            d={d}
            i={i}
            dim={!matches(d, filter)}
            isToday={d.day === today}
            isActive={d.day === active}
            onActive={() => setActive(d.day)}
          />
        ))}
      </ol>

      <Preview d={current} />
    </section>
  );
}

function Tile({
  d,
  i,
  dim,
  isToday,
  isActive,
  onActive,
}: {
  d: DayEntry;
  i: number;
  dim: boolean;
  isToday: boolean;
  isActive: boolean;
  onActive: () => void;
}) {
  const onMove = (e: PointerEvent<HTMLAnchorElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
  };
  const cls = [
    'h-tile',
    d.Component ? 'live' : '',
    d.needsHuman ? 'people' : '',
    dim ? 'dim' : '',
    isToday ? 'today' : '',
    isActive ? 'active' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li className={cls} style={{ '--i': i } as CSSProperties}>
      <Link
        to={`/day/${d.day}`}
        onPointerMove={onMove}
        onPointerEnter={onActive}
        onFocus={onActive}
        aria-label={`Day ${d.day}: ${d.theme}. ${d.title}. ${statusOf(d)}${isToday ? ', today' : ''}`}
      >
        <span className="t-num">{pad2(d.day)}</span>
        <span className="t-theme">{d.theme}</span>
        <span className="t-title">{d.title}</span>
        <span className="t-status">{isToday ? 'Today' : statusOf(d)}</span>
      </Link>
    </li>
  );
}

function Preview({ d }: { d: DayEntry }) {
  return (
    <aside className="h-prev" key={d.day}>
      <div className="p-day">
        <small>Day</small>
        {pad2(d.day)}
      </div>
      <div className="p-body">
        <p className="eyebrow">{d.theme}</p>
        <h3>{d.title}</h3>
        <p className="p-prompt">{d.prompt}</p>
        <p className="p-insight">{d.insight}</p>
      </div>
      <div className="p-side">
        <span className={d.Component ? 'chip live' : 'chip'}>{statusOf(d)}</span>
        {d.needsHuman && <span className="chip warn">Needs people</span>}
        <Link to={`/day/${d.day}`}>Open chapter →</Link>
      </div>
    </aside>
  );
}

function Footer() {
  return (
    <footer className="h-foot">
      <p>
        #30DayMapChallenge is a community project started by Topi Tjukanov. See{' '}
        <a href="https://30daymapchallenge.com" target="_blank" rel="noreferrer">
          30daymapchallenge.com
        </a>
        .
      </p>
      <p>Map data © OpenStreetMap contributors (ODbL). Basemap by OpenFreeMap. Each chapter lists its own sources.</p>
    </footer>
  );
}
