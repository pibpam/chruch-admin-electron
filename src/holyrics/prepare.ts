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

/**
 * Ver docs/integracao-holyrics.md seção 7. O Evento (holyricsEventId) nunca é recriado
 * depois da primeira vez — só a playlist é sempre apagada e reconstruída do zero a partir
 * do manifest atual (idempotente, único jeito confirmado como confiável: uma tentativa
 * anterior de fazer isso incrementalmente, só removendo/adicionando o que mudou, causou
 * itens duplicados na playlist em teste real — revertida).
 *
 * Ordem: `AddToPlaylist` é chamado com os itens em ordem INVERSA à do manifest. Isso é uma
 * correção empírica — a documentação da API (github.com/holyrics/API-Server) diz que os
 * itens são adicionados ao FIM da lista por padrão, o que deveria preservar a ordem do
 * manifest sem precisar inverter nada, mas em teste real (ver feedback do usuário) a ordem
 * no Holyrics saía invertida enviando na ordem direta. Se isso for corrigido/mudar do lado
 * do Holyrics no futuro, ajustar aqui.
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

  const existentes = await client.request<{ id: string }[]>('GetMediaPlaylist', {});
  if (existentes.length > 0) {
    await client.request('RemoveFromMediaPlaylist', {
      ids: existentes.map((existente) => existente.id),
      event_id: holyricsEventId,
    });
  }

  // resolvedIndexes: índices (em params.manifest) dos itens que entram na playlist, na ordem
  // do manifest. sendOrderIndexes: mesma coisa, mas na ordem em que são de fato enviados pro
  // Holyrics (invertida — ver comentário da função).
  const resolvedIndexes = resolved.map((_, index) => index).filter((index) => resolved[index] !== null);
  const sendOrderIndexes = [...resolvedIndexes].reverse();

  if (sendOrderIndexes.length > 0) {
    const itemsToAdd = sendOrderIndexes.map((index) => resolved[index] as Record<string, unknown>);
    await client.request('AddToPlaylist', { items: itemsToAdd, event_id: holyricsEventId });
  }

  // Snapshot pra lastPreparedManifest — não usado hoje pra decidir nada (preparação incremental
  // foi revertida), mas mantido pra eventual uso futuro. Casa GetMediaPlaylist com a ordem em
  // que os itens foram efetivamente enviados (sendOrderIndexes), não a ordem do manifest.
  const playlistDepois = await client.request<{ id: string }[]>('GetMediaPlaylist', {});
  const holyricsIdByIndex = new Map<number, string>();
  sendOrderIndexes.forEach((index, position) => {
    const entry = playlistDepois[position];
    if (entry) holyricsIdByIndex.set(index, entry.id);
  });

  const preparedManifest: IPreparedManifestItem[] = params.manifest.map((item, index) => {
    const holyricsItemId = holyricsIdByIndex.get(index);
    return holyricsItemId ? { ...item, holyricsItemId } : { ...item };
  });

  return { holyricsEventId, items: results, preparedManifest };
}
