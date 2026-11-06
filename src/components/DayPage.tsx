import { Suspense } from 'react';
import { Link, useParams } from 'react-router-dom';
import BaseMap from '../core/BaseMap';
import { DAYS, getDay } from '../days/registry';

export default function DayPage() {
  const { n } = useParams();
  const day = getDay(Number(n));

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
    <div className="day-layout">
      <aside className="panel">
        <Link to="/" className="back">← All days</Link>
        <p className="eyebrow">Day {day.day} · {day.theme}</p>
        <h2>{day.title}</h2>
        <p className="prompt">{day.prompt}</p>
        <p>{day.insight}</p>

        {!Day && <p className="warn">This chapter has not been built yet.</p>}
        {day.needsHuman && (
          <p className="muted">This day needs real-world input (people, field data or paper), not just online data.</p>
        )}

        <details open>
          <summary>Data and methods</summary>
          <ul>
            {day.sources.length ? day.sources.map((s) => <li key={s}>{s}</li>) : <li>Not applicable</li>}
          </ul>
        </details>

        <nav className="pager">
          {prev ? <Link to={`/day/${prev.day}`}>← Day {prev.day}</Link> : <span />}
          {next ? <Link to={`/day/${next.day}`}>Day {next.day} →</Link> : <span />}
        </nav>
      </aside>

      <main className="map-area">
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
