import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DiscordSDK } from '@discord/embedded-app-sdk'

import './index.css'
import App from './App.tsx'

// Will eventually store the authenticated user's access_token
let auth: null | Awaited<ReturnType<typeof discordSDK.commands.authenticate>> = null;

const discordSDK = new DiscordSDK(import.meta.env.VITE_CLIENT_ID)

setupDiscordSDK().then(() => {
  console.log("Discord SDK is authenticated");
});

async function setupDiscordSDK() {
  await discordSDK.ready()
  console.log('Discord SDK is ready!')

  const { code } = await discordSDK.commands.authorize({
    client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: [
      "identify",
      "guilds",
      "applications.commands"
    ],
  });

  // Retrieve an access_token from your activity's server
  const response = await fetch("/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
    }),
  });
  const { access_token } = await response.json();

  auth = await discordSDK.commands.authenticate({ access_token });
  if (!auth) {
    throw new Error("Failed to authenticate with Discord SDK");
  }

  console.log("Authenticated with Discord SDK", auth);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
