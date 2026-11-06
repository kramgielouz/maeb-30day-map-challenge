import { Link } from 'react-router-dom';
import { DAYS, builtCount } from '../days/registry';

export default function Home() {
  return (
    <div className="page">
      <p className="eyebrow">#30DayMapChallenge 2026</p>
      <h1>Butuan Unfolded</h1>
      <p className="lede">
        Thirty maps, one app. A thread through all of them: how water, heat, access and people interact in Butuan City and Caraga.
        Built on open data. {builtCount} of 30 chapters published so far.
      </p>

      <ol className="grid">
        {DAYS.map((d) => {
          const built = !!d.Component;
          return (
            <li key={d.day} className={built ? 'card built' : 'card'}>
              <Link to={`/day/${d.day}`}>
                <span className="num">{String(d.day).padStart(2, '0')}</span>
                <span className="theme">{d.theme}</span>
                <span className="title">{d.title}</span>
                <span className="status">{built ? 'Live' : 'Planned'}</span>
              </Link>
            </li>
          );
        })}
      </ol>

      <footer className="foot">
        Map data © OpenStreetMap contributors (ODbL). Basemap by OpenFreeMap. Each chapter lists its own sources.
      </footer>
    </div>
  );
}
