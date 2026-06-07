import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AuthPage from './AuthPage';
import Dashboard from './Dashboard';
import './styles.css';

const { pathname } = window.location;
const Root = pathname.startsWith('/auth')
  ? AuthPage
  : pathname.startsWith('/dashboard')
    ? Dashboard
    : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
