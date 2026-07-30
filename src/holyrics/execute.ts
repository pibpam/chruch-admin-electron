import { HolyricsClient } from '../holyricsClient';
import { state } from '../state';

interface IMediaPlaylistItem {
  id: string;
  type: string;
  name?: string;
}

/**
 * Ver docs/integracao-holyrics.md seção 8. GetMediaPlaylist/MediaPlaylistAction
 * não têm parâmetro event_id — operam sobre o culto atualmente selecionado na
 * interface, por isso o SetCurrentSchedule antes é o que garante o alvo certo.
 * itens[0] pode ser um separador "title" (não projeta nada) — pula pro
 * primeiro item real antes de tocar.
 */
export async function executarEvento(eventId: string): Promise<{ status: string }> {
  const client = new HolyricsClient(state.requireConnection());

  await client.request('SetCurrentSchedule', { event_id: eventId });
  await client.request('MediaPlayerAction', { execute_single: false, repeat: false });

  const itens = await client.request<IMediaPlaylistItem[]>('GetMediaPlaylist', {});
  const primeiroReal = itens.find((item) => item.type !== 'title');
  if (primeiroReal) {
    await client.request('MediaPlaylistAction', { id: primeiroReal.id });
  }

  return { status: 'ok' };
}
