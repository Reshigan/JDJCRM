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
  {
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/tickets" replace /> },
      { path: 'tickets', element: <Tickets /> },
      { path: 'tickets/new', element: <NewTicket /> },
      { path: 'tickets/:id', element: <Ticket /> },
      { path: 'admin/:tab?', element: <Admin /> },
      { path: 'account', element: <Account /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
