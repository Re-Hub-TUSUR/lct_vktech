import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'

import { ApiError } from './api/client'
import { App } from './App'
import { AuthProvider } from './auth/AuthProvider'
import { ToastProvider } from './components/Toast'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/global.css'
import './styles/slide.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Ошибки 4xx повторять бессмысленно; сетевые и 5xx — один раз.
      retry: (failureCount, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 1,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
