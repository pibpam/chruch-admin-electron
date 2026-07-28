import { HolyricsClient } from '../holyricsClient';
import { state } from '../state';
import { ICriarMusicaPendenteResult, IPendingSong } from '../types';

interface ICatalogSong {
  id: string;
  extras?: Record<string, unknown>;
}

/**
 * Ver docs/integracao-holyrics.md seção 9. O marcador extras.musica_id dentro
 * do próprio Holyrics garante idempotência mesmo se a página cair ou o
 * /liturgy/pending-songs/resolve falhar depois — a próxima tentativa encontra
 * a música pelo marcador (via catalogoLocal, carregado desde configurarIntegracao)
 * e não duplica.
 */
export async function criarMusicasPendentes(pendentes: IPendingSong[]): Promise<ICriarMusicaPendenteResult[]> {
  const client = new HolyricsClient(state.requireConnection());
  const musicas = (state.catalogoLocal.musicas || []) as ICatalogSong[];
  const criadas: ICriarMusicaPendenteResult[] = [];

  for (const musica of pendentes) {
    const existente = musicas.find((item) => item.extras?.musica_id === musica.musica_id);

    const holyricsId = existente
      ? existente.id
      : (
          await client.request<{ id: string }>('CreateSong', {
            title: musica.titulo,
            artist: musica.artista,
            slides: musica.slides,
            extras: { musica_id: musica.musica_id },
          })
        ).id;

    criadas.push({ musica_id: musica.musica_id, holyrics_id: holyricsId });
  }

  return criadas;
}
