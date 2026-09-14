import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AuthPage from './AuthPage';
import Dashboard from './Dashboard';
import Billing from './Billing';
import CheckoutResult from './CheckoutResult';
import Subscription from './Subscription';
import Profile from './Profile';
import Support from './Support';
import './styles.css';

const { pathname } = window.location;
// Order matters: the specific /billing/* screens must be matched before the
// bare /billing prefix catches them.
const Root = pathname.startsWith('/auth')
  ? AuthPage
  : pathname.startsWith('/support')
    ? Support
    : pathname.startsWith('/profile')
      ? Profile
      : /^\/(subscription|billing\/manage)/.test(pathname)
        ? Subscription
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
