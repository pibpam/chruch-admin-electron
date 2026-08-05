import { HolyricsClient } from '../holyricsClient';
import { state } from '../state';
import { ICatalogUrls } from '../types';

interface IMusicaCatalogEntry {
  id: string | number;
  slides?: unknown;
  [key: string]: unknown;
}

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
 * Preserva `slides` das músicas já conhecidas — confirmado contra a documentação oficial
 * da API do Holyrics (github.com/holyrics/API-Server) que GetSongs não devolve conteúdo de
 * letra (o tipo "Lyrics" só tem metadados: id/title/artist/author/note/key/bpm/groups/...);
 * só GetText tem `slides`. A única letra real que temos vem de PendingSongService.resolve()
 * no backend, gravada em musicas.json quando a música deixa de ser pendente. Sem esse merge,
 * um "Sincronizar catálogo" comum sobrescreve musicas.json inteiro com dados frescos do
 * Holyrics e apaga essa letra.
 */
function preservarSlidesConhecidos(musicasFrescas: IMusicaCatalogEntry[]): IMusicaCatalogEntry[] {
  const anteriores = (state.catalogoLocal.musicas as IMusicaCatalogEntry[] | undefined) ?? [];
  const anteriorPorId = new Map(anteriores.map((entry) => [String(entry.id), entry]));

  return musicasFrescas.map((entry) => {
    const anterior = anteriorPorId.get(String(entry.id));
    return anterior?.slides ? { ...entry, slides: anterior.slides } : entry;
  });
}

/**
 * Espelha o catálogo do Holyrics pro S3 — ver docs/integracao-holyrics.md
 * seção 11. GetBibleVersions é deprecated (usa GetBibleVersionsV2).
 */
export async function sincronizarCatalogo(urls: ICatalogUrls): Promise<{ status: string }> {
  const client = new HolyricsClient(state.requireConnection());

  const [musicasFrescas, textos, temas, scripts, backgrounds, gruposMusica, versoesBiblia] = await Promise.all([
    client.request<IMusicaCatalogEntry[]>('GetSongs', { fields: 'id,title,artist,author,key,bpm,groups,extras' }),
    client.request<unknown[]>('GetTexts', { fields: 'id,title,folder,slides' }),
    client.request<unknown[]>('GetThemes', {}),
    client.request<unknown[]>('GetScripts', {}),
    client.request<unknown[]>('GetBackgrounds', {}),
    client.request<unknown[]>('GetSongGroups', {}),
    client.request<unknown[]>('GetBibleVersionsV2', {}),
  ]);

  const musicas = preservarSlidesConhecidos(musicasFrescas);

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
