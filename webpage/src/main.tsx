import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AuthPage from './AuthPage';
import './styles.css';

const Root = window.location.pathname.startsWith('/auth') ? AuthPage : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
