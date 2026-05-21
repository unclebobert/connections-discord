export interface GameCategory {
  title: string;
  cards: Array<{
    content: string;
    position: number;
  }>
}

export interface GameData {
  status: string;
  id: number;
  print_date: string;
  editor: string;
  categories: GameCategory[];
}

export interface PlayCard {
  id: string;
  content: string;
  position: number;
  categoryIndex: number;
}

export const API_BASE_URL = import.meta.env.DEV ?
  'https://connections-discord-server.unclebobert.workers.dev' :
  '/api';

export function getProgressWebSocketUrl(guildId: string, date: string) {
  const baseUrl = new URL(API_BASE_URL, window.location.origin);

  baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, '')}/progress/${encodeURIComponent(guildId)}/${date}`;
  baseUrl.search = '';

  return baseUrl.toString();
}
