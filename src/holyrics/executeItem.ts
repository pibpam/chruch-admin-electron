import { HolyricsClient } from '../holyricsClient';
import { state } from '../state';
import { statusPreparacao } from './preparacaoAtual';
import { IExecutarItemParams, IExecutarItemResult } from '../types';

interface ICurrentSchedule {
  media_playlist?: { id: string; type?: string; name?: string }[];
  metadata?: { event?: { id?: string | number } | null };
}

/**
 * Executa um item do plano na playlist do culto selecionado no Holyrics. Nunca troca o culto
 * selecionado (SetCurrentSchedule): se o selecionado não for o evento do plano, bloqueia —
 * trocar no meio do culto tiraria do ar o que está sendo exibido.
 */
export async function executarItem({ holyricsEventId, holyricsItemId }: IExecutarItemParams): Promise<IExecutarItemResult> {
  // Durante a preparação a playlist ainda está sendo montada e o culto selecionado vai mudar no fim.
  if (statusPreparacao()?.status === 'running') {
    throw new Error('Há uma preparação em andamento neste computador. Aguarde ela terminar.');
  }

  const client = new HolyricsClient(state.requireConnection());

  // A doc da API diz Array<Schedule>, mas o exemplo (e o Holyrics) devolve um objeto só.
  const resposta = await client.request<ICurrentSchedule | ICurrentSchedule[]>('GetCurrentSchedule', {});
  const schedule = Array.isArray(resposta) ? resposta[0] : resposta;

  // String(): o Holyrics pode devolver o id do evento como número.
  if (String(schedule?.metadata?.event?.id ?? '') !== String(holyricsEventId)) {
    throw new Error(
      'O Holyrics está com outro culto selecionado. Selecione o culto deste plano no Holyrics ou prepare novamente.',
    );
  }

  const item = schedule.media_playlist?.find((entry) => String(entry.id) === String(holyricsItemId));
  if (!item) {
    throw new Error(
      'Este item não está mais na playlist do Holyrics (alguém pode ter mexido direto lá). Prepare o plano novamente.',
    );
  }

  await client.request('MediaPlaylistAction', { id: holyricsItemId });
  return { status: 'ok', name: item.name };
}
