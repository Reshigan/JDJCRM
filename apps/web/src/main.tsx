import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import './index.css';
import { Shell } from './Shell';
import { Login } from './pages/Login';
import { Tickets } from './pages/Tickets';
import { NewTicket } from './pages/NewTicket';
import { Ticket } from './pages/Ticket';
import { Admin } from './pages/Admin';
import { Account } from './pages/Account';
import { Bleeds } from './pages/Bleeds';
import { NewBleed } from './pages/NewBleed';
import { Bleed } from './pages/Bleed';
import { Samples } from './pages/Samples';
import { FieldHome, FieldRequest, FieldShell } from './pages/Field';

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: (n, e: any) => e?.status !== 401 && e?.status !== 403 && e?.status !== 404 && n < 2,
    },
  },
});

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/field', element: <FieldShell />, children: [{ index: true, element: <FieldHome /> }, { path: 'r/:id', element: <FieldRequest /> }] },
  {
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/tickets" replace /> },
      { path: 'tickets', element: <Tickets /> },
      { path: 'tickets/new', element: <NewTicket /> },
      { path: 'tickets/:id', element: <Ticket /> },
      { path: 'admin/:tab?', element: <Admin /> },
      { path: 'account', element: <Account /> },
      { path: 'bleeds', element: <Bleeds /> },
      { path: 'bleeds/new', element: <NewBleed /> },
      { path: 'bleeds/:id', element: <Bleed /> },
      { path: 'samples', element: <Samples /> },
    ],
  },
]);

if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
