import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DiscordSDK } from '@discord/embedded-app-sdk'

import './index.css'
import App from './App.tsx'

const discordSDK = new DiscordSDK(import.meta.env.VITE_CLIENT_ID)

await discordSDK.ready()
console.log('Discord SDK is ready!')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
