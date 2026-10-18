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

interface ICatalogSong {
  id?: string;
  slides?: { text: string }[];
  [key: string]: unknown;
}

/** Quantas chamadas GetLyrics ficam em andamento ao mesmo tempo durante a sincronização. */
const LETRAS_EM_PARALELO = 5;

/** Linha (ou slide inteiro) começando com `//` é anotação do operador, não vai pro telão. */
const isComentario = (linha: string): boolean => linha.trim().startsWith('//');

/**
 * Texto de um slide pronto pra exibição: quebras de linha padronizadas em `\n`, linhas `//`
 * fora, espaços sobrando no fim de cada linha e linhas em branco nas pontas removidos.
 * Slide que começa com `//` vira null (descartado inteiro).
 */
function limparTextoSlide(texto: unknown): string | null {
  if (typeof texto !== 'string') return null;
  const linhas = texto.replace(/\r\n?/g, '\n').split('\n');
  const primeira = linhas.find((linha) => linha.trim());
  if (!primeira || isComentario(primeira)) return null;
  const limpo = linhas
    .filter((linha) => !isComentario(linha))
    .map((linha) => linha.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return limpo || null;
}

/**
 * GetLyrics de uma música, reduzido a `{ text }` por slide. Falha (ou música sem slides)
 * vira null — a sincronização segue e a música é salva sem letra.
 */
async function buscarSlides(client: HolyricsClient, id: string): Promise<{ text: string }[] | null> {
  try {
    const letra = await client.request<{ slides?: { text?: unknown }[] } | null>('GetLyrics', { id });
    const slides = (letra?.slides || [])
      .map((slide) => limparTextoSlide(slide?.text))
      .filter((texto): texto is string => !!texto)
      .map((text) => ({ text }));
    return slides.length ? slides : null;
  } catch (err) {
    console.warn(`Letra da música ${id} não carregada:`, err);
    return null;
  }
}

/** Preenche `slides` de cada música via GetLyrics, em lotes de LETRAS_EM_PARALELO. */
async function carregarLetras(client: HolyricsClient, musicas: ICatalogSong[]): Promise<ICatalogSong[]> {
  const resultado: ICatalogSong[] = new Array(musicas.length);
  let proxima = 0;

  const worker = async () => {
    while (proxima < musicas.length) {
      const indice = proxima++;
      const musica = musicas[indice];
      const slides = musica.id ? await buscarSlides(client, String(musica.id)) : null;
      resultado[indice] = slides ? { ...musica, slides } : musica;
    }
  };

  await Promise.all(Array.from({ length: Math.min(LETRAS_EM_PARALELO, musicas.length) }, worker));
  return resultado;
}

/**
 * Espelha o catálogo do Holyrics pro S3 — ver docs/integracao-holyrics.md
 * seção 11. GetBibleVersions é deprecated (usa GetBibleVersionsV2). GetSongs não traz os
 * slides, então a letra de cada música vem de um GetLyrics por música (ver carregarLetras);
 * erro numa letra não derruba a sincronização, só deixa aquela música sem `slides`.
 */
export async function sincronizarCatalogo(urls: ICatalogUrls): Promise<{ status: string }> {
  const client = new HolyricsClient(state.requireConnection());

  const [musicasSemLetra, textos, temas, scripts, backgrounds, gruposMusica, versoesBiblia] = await Promise.all([
    client.request<ICatalogSong[]>('GetSongs', { fields: 'id,title,artist,author,key,bpm,groups,extras' }),
    client.request<unknown[]>('GetTexts', { fields: 'id,title,folder,slides' }),
    client.request<unknown[]>('GetThemes', {}),
    client.request<unknown[]>('GetScripts', {}),
    client.request<unknown[]>('GetBackgrounds', {}),
    client.request<unknown[]>('GetSongGroups', {}),
    client.request<unknown[]>('GetBibleVersionsV2', {}),
  ]);

  const musicas = await carregarLetras(client, musicasSemLetra || []);

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
