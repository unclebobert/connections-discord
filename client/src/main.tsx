import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
import App from './App.tsx'
import { discordSessionPromise } from './discord.ts'

discordSessionPromise
  .then((session) => {
    if (session) {
      console.log('Discord SDK is authenticated')
    }
  })
  .catch((error) => console.error('Discord SDK authentication failed', error))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
