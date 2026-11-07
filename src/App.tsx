import { Route, Routes, useLocation } from 'react-router-dom';
import Home from './components/Home';
import DayPage from './components/DayPage';
import ErrorBoundary from './components/ErrorBoundary';

export default function App() {
  const { pathname } = useLocation();
  return (
    // keyed by path: navigating to another page clears a previous error
    <ErrorBoundary key={pathname}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/day/:n" element={<DayPage />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </ErrorBoundary>
  );
}
