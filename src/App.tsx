import { Route, Routes } from 'react-router-dom';
import Home from './components/Home';
import DayPage from './components/DayPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/day/:n" element={<DayPage />} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
