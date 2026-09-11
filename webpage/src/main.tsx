import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AuthPage from './AuthPage';
import Dashboard from './Dashboard';
import Billing from './Billing';
import CheckoutResult from './CheckoutResult';
import './styles.css';

const { pathname } = window.location;
// Order matters: /billing/success and /billing/cancelled must be matched
// before the /billing prefix catches them.
const Root = pathname.startsWith('/auth')
  ? AuthPage
  : /^\/billing\/(success|cancelled)/.test(pathname)
    ? CheckoutResult
    : pathname.startsWith('/billing')
      ? Billing
      : pathname.startsWith('/dashboard')
        ? Dashboard
        : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
