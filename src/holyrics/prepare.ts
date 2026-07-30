import fs from 'node:fs/promises';
import { HolyricsClient } from '../holyricsClient';
import { state } from '../state';
import { fileExists, getMediaFilePath } from '../mediaPaths';
import {
  IManifestAsset,
  IManifestItem,
  IPreparedManifestItem,
  IPrepararEventoItemResult,
  IPrepararEventoParams,
  IPrepararEventoResult,
} from '../types';

/**
 * Baixa o asset referenciado pro disco local (pasta que o Holyrics também usa,
 * ver mediaPaths.ts), rebaixando só se o etag mudou desde a última vez — o
 * etag conhecido fica num arquivo .etag ao lado do arquivo baixado.
 */
async function baixarAsset(item: IManifestItem, asset?: IManifestAsset): Promise<void> {
  if (!asset?.metadata) {
    throw new Error(`O arquivo "${item.arquivo}" não foi encontrado. Reanexe-o na tela do plano.`);
  }

  const filePath = await getMediaFilePath(item.type, item.arquivo as string);
  const etagFile = `${filePath}.etag`;
  const etagConhecido = await fs.readFile(etagFile, 'utf8').catch((): null => null);

  if (etagConhecido === asset.metadata.etag && (await fileExists(filePath))) {
    return;
  }

  const response = await fetch(asset.metadata.url);
  if (!response.ok) {
    console.error(`Falha ao baixar "${item.arquivo}" (HTTP ${response.status})`);
    throw new Error(`Não foi possível baixar o arquivo "${item.arquivo}".`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buffer);
  await fs.writeFile(etagFile, asset.metadata.etag);
}

/**
 * Traduz um item do nosso manifest (LiturgyManifestItem) pro formato AddItem*
 * que o Holyrics realmente espera (confirmado contra github.com/holyrics/API-Server):
 * arquivo->name, song_id/text_id/script_id->id, verse.text->references.
 * Retorna null se o item não tiver o suficiente pra ser resolvido.
 */
function mapManifestItemToAddItem(item: IManifestItem): Record<string, unknown> | null {
  switch (item.type) {
    case 'title':
      return {
        type: 'title',
        name: item.name || '',
        ...(item.background_color ? { background_color: item.background_color } : {}),
      };

    case 'video':
    case 'image':
    case 'file':
    case 'audio':
      if (!item.arquivo) return null;
      return {
        type: item.type,
        name: item.arquivo,
        ...(item.type === 'video' && item.settings ? { settings: item.settings } : {}),
      };

    case 'script':
      if (!item.script_id) return null;
      return { type: 'script', id: item.script_id, description: item.name || item.script_id };

    case 'song':
      if (!item.song_id) return null;
      return { type: 'song', id: item.song_id };

    case 'verse':
      if (!item.text) return null;
      return { type: 'verse', references: item.text, ...(item.version ? { version: item.version } : {}) };

    case 'text':
      if (!item.text_id) return null;
      return { type: 'text', id: item.text_id };

    case 'plain_text':
      return {
        type: 'plain_text',
        name: item.name || '',
        text: item.text || '',
        ...(item.theme ? { theme: item.theme } : {}),
      };

    default:
      return null;
  }
}

const TYPE_LABEL: Record<string, string> = {
  title: 'separador',
  video: 'vídeo',
  image: 'imagem',
  file: 'arquivo',
  audio: 'áudio',
  script: 'script',
  song: 'música',
  verse: 'texto bíblico',
  text: 'template de texto',
  plain_text: 'texto simples',
};

function itemAlerta(mensagem: string): Record<string, unknown> {
  return {
    type: 'plain_text',
    name: '⚠ ITEM FALTANDO',
    text: mensagem,
    ...(state.alertTemaId ? { theme: state.alertTemaId } : {}),
  };
}

interface IIncrementalPlan {
  /** holyricsItemId (da preparação anterior) dos itens que saíram ou mudaram de conteúdo. */
  toRemoveHolyricsIds: string[];
  /** Índices em `manifest`/`resolved` dos itens novos/alterados a adicionar (só no fim). */
  toAddIndexes: number[];
  /** Índices em `manifest` dos itens que não mudaram — mantêm o holyricsItemId anterior. */
  unchangedIndexes: number[];
}

/**
 * Decide se dá pra fazer um Preparar incremental (só remove/adiciona o que mudou) em vez de
 * sempre apagar e reconstruir a playlist inteira — ver item 3+12 do plano de correções do
 * Holyrics. Só retorna um plano quando é seguro; qualquer incerteza cai no fallback de
 * reconstrução total (`null`), que é sempre correto.
 *
 * Exige, nessa ordem: (1) existe um snapshot anterior com pelo menos um item realmente
 * adicionado à playlist da vez passada (`holyricsItemId`); (2) os itens que sobrevivem
 * (mesmo id, mesmo conteúdo mapeado pro Holyrics) mantêm a MESMA ordem relativa antes/depois;
 * (3) tudo que é novo ou mudou de conteúdo vem DEPOIS de todos os sobreviventes na ordem atual
 * — só assim dá pra confiar que um `AddToPlaylist` (que só sabe colocar no fim) reproduz a
 * ordem certa sem precisar mover nada.
 *
 * Limitação aceita: só remove pelos `holyricsItemId` que o próprio snapshot conhece — se
 * alguém mexeu na playlist direto no Holyrics fora do fluxo de Preparar desde a última vez,
 * esse ajuste manual não é limpo (diferente do fallback, que sempre limpa TUDO que encontrar
 * via GetMediaPlaylist). Ver seção de riscos do plano de correções.
 */
function canUseIncrementalPath(
  manifest: IManifestItem[],
  resolved: (Record<string, unknown> | null)[],
  previousManifest?: IPreparedManifestItem[],
): IIncrementalPlan | null {
  if (!previousManifest || previousManifest.length === 0) return null;

  const currentLive = manifest
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => !!item.id && resolved[index] !== null);
  if (currentLive.length === 0) return null;

  const previousLive = previousManifest.filter((item) => !!item.id && !!item.holyricsItemId);
  if (previousLive.length === 0) return null;

  const previousById = new Map(previousLive.map((item) => [item.id as string, item]));

  const unchangedIndexes: number[] = [];
  const unchangedIds = new Set<string>();
  for (const { item, index } of currentLive) {
    const previousItem = previousById.get(item.id as string);
    if (!previousItem) continue;
    if (JSON.stringify(resolved[index]) !== JSON.stringify(mapManifestItemToAddItem(previousItem))) continue;
    unchangedIndexes.push(index);
    unchangedIds.add(item.id as string);
  }
  if (unchangedIndexes.length === 0) return null; // nada aproveitável — reconstrução total é igual de eficiente

  const previousSurvivorOrder = previousLive
    .filter((item) => unchangedIds.has(item.id as string))
    .map((item) => item.id as string);
  const currentLiveIds = currentLive.map(({ item }) => item.id as string);
  const currentSurvivorOrder = currentLiveIds.filter((id) => unchangedIds.has(id));
  if (JSON.stringify(previousSurvivorOrder) !== JSON.stringify(currentSurvivorOrder)) return null;

  const lastSurvivorPos = currentLiveIds.lastIndexOf(currentSurvivorOrder[currentSurvivorOrder.length - 1]);
  const firstNonSurvivorPos = currentLiveIds.findIndex((id) => !unchangedIds.has(id));
  if (firstNonSurvivorPos !== -1 && firstNonSurvivorPos < lastSurvivorPos) return null;

  const toAddIndexes = currentLive.filter(({ item }) => !unchangedIds.has(item.id as string)).map(({ index }) => index);
  const toRemoveHolyricsIds = previousLive
    .filter((item) => !unchangedIds.has(item.id as string))
    .map((item) => item.holyricsItemId as string);

  return { toRemoveHolyricsIds, toAddIndexes, unchangedIndexes };
}

/**
 * Monta o snapshot pra persistir em LiturgyPlan.lastPreparedManifest, associando o
 * holyricsItemId de cada item que efetivamente entrou na playlist. Não confirmado contra a
 * API real do Holyrics se `AddToPlaylist` devolve os ids atribuídos — por isso, em vez de
 * confiar no retorno desse request (descartado), consulta `GetMediaPlaylist` de novo depois
 * e casa por posição, assumindo que a playlist reflete a ordem em que os itens foram
 * adicionados. Ver seção de riscos do plano de correções do Holyrics.
 */
function buildPreparedManifest(
  manifest: IManifestItem[],
  resolved: (Record<string, unknown> | null)[],
  playlistDepois: { id: string }[],
  incremental: IIncrementalPlan | null,
  previousManifest?: IPreparedManifestItem[],
): IPreparedManifestItem[] {
  const holyricsIdByIndex = new Map<number, string>();

  if (incremental) {
    const previousById = new Map((previousManifest || []).map((item) => [item.id, item]));
    for (const index of incremental.unchangedIndexes) {
      const previousItem = previousById.get(manifest[index].id);
      if (previousItem?.holyricsItemId) holyricsIdByIndex.set(index, previousItem.holyricsItemId);
    }
    const knownHolyricsIds = new Set(holyricsIdByIndex.values());
    const newEntries = playlistDepois.filter((entry) => !knownHolyricsIds.has(entry.id));
    incremental.toAddIndexes.forEach((index, position) => {
      const entry = newEntries[position];
      if (entry) holyricsIdByIndex.set(index, entry.id);
    });
  } else {
    const resolvedIndexes = manifest.map((_, index) => index).filter((index) => resolved[index] !== null);
    resolvedIndexes.forEach((index, position) => {
      const entry = playlistDepois[position];
      if (entry) holyricsIdByIndex.set(index, entry.id);
    });
  }

  return manifest.map((item, index) => {
    const holyricsItemId = holyricsIdByIndex.get(index);
    return holyricsItemId ? { ...item, holyricsItemId } : { ...item };
  });
}

/**
 * Ver docs/integracao-holyrics.md seção 7 e o plano de correções do Holyrics (itens 3+12).
 * O Evento (holyricsEventId) nunca é recriado depois da primeira vez. A partir daí, se
 * houver um snapshot da preparação anterior utilizável, só remove/adiciona o que mudou
 * (canUseIncrementalPath); caso contrário, cai no comportamento antigo — sempre idempotente,
 * já que reconstrói do zero a partir do manifest atual.
 */
export async function prepararEvento(params: IPrepararEventoParams): Promise<IPrepararEventoResult> {
  const client = new HolyricsClient(state.requireConnection());

  const pendencias = params.manifest.filter(
    (item) => item.type === 'song' && item.musica_id && !item.song_id,
  );
  if (pendencias.length > 0) {
    throw new Error(
      'Este plano tem letra(s) nova(s) que ainda não foram criadas no Holyrics. Crie-as na tela de Músicas Pendentes antes de preparar.',
    );
  }

  let holyricsEventId = params.holyricsEventId;

  if (!holyricsEventId) {
    const created = await client.request<{ id: string }>('CreateEvent', {
      name: params.eventName,
      // datetime: '2026-09-16 21:00:00',
    });
    holyricsEventId = created.id;
  }

  await client.request('SetCurrentSchedule', { event_id: holyricsEventId });

  const assetsByIndex = new Map(params.assets.map((asset) => [asset.index, asset]));
  const errosDownload = new Map<number, string>();

  for (let index = 0; index < params.manifest.length; index++) {
    const item = params.manifest[index];
    if (item.hidden || !item.arquivo) continue;
    try {
      await baixarAsset(item, assetsByIndex.get(index));
    } catch (err) {
      errosDownload.set(index, (err as Error).message);
    }
  }

  const results: IPrepararEventoItemResult[] = [];
  const resolved: (Record<string, unknown> | null)[] = [];

  for (let index = 0; index < params.manifest.length; index++) {
    const item = params.manifest[index];

    if (item.hidden) {
      results.push({ index, status: 'skipped', message: 'Item oculto' });
      resolved.push(null);
      continue;
    }

    const erroDownload = errosDownload.get(index);
    if (erroDownload) {
      resolved.push(itemAlerta(erroDownload));
      results.push({ index, status: 'error', message: erroDownload });
      continue;
    }

    const mapped = mapManifestItemToAddItem(item);
    if (!mapped) {
      const mensagem = `Este item de ${TYPE_LABEL[item.type] || item.type} está com informações faltando e não pôde ser montado.`;
      resolved.push(itemAlerta(mensagem));
      results.push({ index, status: 'error', message: mensagem });
      continue;
    }

    resolved.push(mapped);
    results.push({ index, status: 'ok' });
  }

  const incremental = canUseIncrementalPath(params.manifest, resolved, params.previousManifest);

  if (incremental) {
    if (incremental.toRemoveHolyricsIds.length > 0) {
      await client.request('RemoveFromMediaPlaylist', {
        ids: incremental.toRemoveHolyricsIds,
        event_id: holyricsEventId,
      });
    }
    if (incremental.toAddIndexes.length > 0) {
      const itemsToAdd = incremental.toAddIndexes.map((index) => resolved[index] as Record<string, unknown>);
      await client.request('AddToPlaylist', { items: itemsToAdd, event_id: holyricsEventId });
    }
  } else {
    const existentes = await client.request<{ id: string }[]>('GetMediaPlaylist', {});
    if (existentes.length > 0) {
      await client.request('RemoveFromMediaPlaylist', {
        ids: existentes.map((existente) => existente.id),
        event_id: holyricsEventId,
      });
    }
    const itemsToAdd = resolved.filter((item): item is Record<string, unknown> => item !== null);
    if (itemsToAdd.length > 0) {
      await client.request('AddToPlaylist', { items: itemsToAdd, event_id: holyricsEventId });
    }
  }

  const playlistDepois = await client.request<{ id: string }[]>('GetMediaPlaylist', {});
  const preparedManifest = buildPreparedManifest(
    params.manifest,
    resolved,
    playlistDepois,
    incremental,
    params.previousManifest,
  );

  return { holyricsEventId, items: results, preparedManifest };
}
