import { HolyricsClient } from '../holyricsClient';
import { state } from '../state';
import { ICatalogUrls } from '../types';

async function putJson(url: string, data: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(`Falha ao gravar catálogo no S3 (${response.status})`);
  }
}

/**
 * Espelha o catálogo do Holyrics pro S3 — ver docs/integracao-holyrics.md
 * seção 11. GetBibleVersions é deprecated (usa GetBibleVersionsV2). `slides` em GetSongs
 * (Lyrics.slides, v2.21.0+) já traz o texto de cada slide direto do Holyrics — fonte de
 * verdade mais atual que qualquer cópia nossa, sem precisar preservar/mesclar nada.
 */
export async function sincronizarCatalogo(urls: ICatalogUrls): Promise<{ status: string }> {
  const client = new HolyricsClient(state.requireConnection());

  const [musicas, textos, temas, scripts, backgrounds, gruposMusica, versoesBiblia] = await Promise.all([
    client.request<unknown[]>('GetSongs', { fields: 'id,title,artist,author,key,bpm,slides,groups,extras' }),
    client.request<unknown[]>('GetTexts', { fields: 'id,title,folder,slides' }),
    client.request<unknown[]>('GetThemes', {}),
    client.request<unknown[]>('GetScripts', {}),
    client.request<unknown[]>('GetBackgrounds', {}),
    client.request<unknown[]>('GetSongGroups', {}),
    client.request<unknown[]>('GetBibleVersionsV2', {}),
  ]);

  state.catalogoLocal = {
    musicas,
    textos,
    temas,
    scripts,
    backgrounds,
    grupos_musica: gruposMusica,
    versoes_biblia: versoesBiblia,
  };

  await Promise.all([
    putJson(urls.musicas, musicas),
    putJson(urls.textos, textos),
    putJson(urls.temas, temas),
    putJson(urls.scripts, scripts),
    putJson(urls.backgrounds, backgrounds),
    putJson(urls.grupos_musica, gruposMusica),
    putJson(urls.versoes_biblia, versoesBiblia),
  ]);

  return { status: 'ok' };
}

/**
 * Carrega o catálogo a partir das URLs públicas (sem passar pelo Holyrics) —
 * usado em configurarIntegracao, pra catalogoLocal já estar disponível desde
 * o início da sessão (ver docs/integracao-holyrics.md seção 9).
 */
export async function carregarCatalogoDeUrls(urls: ICatalogUrls): Promise<void> {
  const entries = await Promise.all(
    (Object.keys(urls) as (keyof ICatalogUrls)[]).map(async (key) => {
      try {
        const response = await fetch(urls[key]);
        if (!response.ok) return [key, []] as const;
        const data = await response.json();
        return [key, Array.isArray(data) ? data : []] as const;
      } catch {
        return [key, []] as const;
      }
    }),
  );
  state.catalogoLocal = Object.fromEntries(entries);
}
