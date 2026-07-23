import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import App from './App'
import { DialogProvider } from './dialogs'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DialogProvider>
      <App />
      <Toaster
        position="top-center"
        richColors
        closeButton
        duration={4200}
        toastOptions={{
          className: 'app-toast',
        }}
      />
    </DialogProvider>
  </StrictMode>,
)
