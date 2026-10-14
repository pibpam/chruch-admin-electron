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
        // Sempre explícito pra vídeo — sem isso, um vídeo sem "settings" (nunca mexido no
        // toggle "Repetir em loop") não manda nada pro Holyrics, que cai no próprio default
        // de player em vez de respeitar "não é loop".
        ...(item.type === 'video' ? { settings: { repeat: !!item.settings?.repeat } } : {}),
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

interface ISchedule {
  media_playlist: { id: string }[];
  metadata?: { event?: { id?: string } | null };
}

/**
 * Lê a playlist de mídia de um evento específico sem mexer no culto selecionado na interface
 * do Holyrics — GetMediaPlaylist não aceita event_id e só lê o que está selecionado, e
 * SetCurrentSchedule não pode ser chamado na preparação (trocaria o culto em andamento).
 * GetSchedules é por mês, então procura no mês do evento e, se não achar (evento criado sem
 * datetime cai na data de criação), no mês atual.
 */
async function getEventMediaPlaylist(
  client: HolyricsClient,
  eventId: string,
  eventDateTime: string,
): Promise<{ id: string }[]> {
  const [ano, mes] = eventDateTime.split('-').map(Number);
  const agora = new Date();
  const meses = [
    { year: ano, month: mes },
    { year: agora.getFullYear(), month: agora.getMonth() + 1 },
  ].filter((m, i, arr) => m.year && m.month && arr.findIndex((o) => o.year === m.year && o.month === m.month) === i);

  for (const { year, month } of meses) {
    const schedules = await client.request<ISchedule[]>('GetSchedules', { month, year });
    const schedule = schedules.find((s) => s.metadata?.event?.id === eventId);
    if (schedule) return schedule.media_playlist ?? [];
  }

  throw new Error('Não foi possível encontrar o evento no Holyrics para atualizar a playlist.');
}

/**
 * Antes da 2.26.0 o Holyrics ignora event_id em AddToPlaylist e edita
 * a playlist selecionada na interface — ou seja, apagaria o culto que está no ar.
 */
async function garantirVersaoComEventId(client: HolyricsClient): Promise<void> {
  const { version } = await client.request<{ version: string }>('GetVersion', {});
  const [major = 0, minor = 0] = version.split('.').map((parte) => parseInt(parte, 10) || 0);
  if (major < 2 || (major === 2 && minor < 26)) {
    throw new Error(
      `O Holyrics ${version} não permite preparar um culto sem tirar do ar o que está selecionado. Atualize para a versão 2.26.0 ou superior.`,
    );
  }
}

/**
 * Ver docs/integracao-holyrics.md seção 7. A cada preparação um Evento novo é criado e a
 * playlist é montada do zero a partir do manifest atual — o holyricsEventId anterior não é
 * reaproveitado (uma tentativa anterior de atualizar a playlist incrementalmente, só
 * removendo/adicionando o que mudou, causou itens duplicados em teste real — revertida).
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

  await garantirVersaoComEventId(client);

  // Sempre cria um evento novo (playlist vazia) em vez de limpar a playlist do anterior —
  // o id novo volta no resultado pra página persistir no lugar do antigo.
  const created = await client.request<{ id: string }>('CreateEvent', {
    name: params.eventName,
    // datetime: '2026-09-16 21:00:00',
  });
  const holyricsEventId = created.id;

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
  // foi revertida), mas mantido pra eventual uso futuro. Casa a playlist do evento com a ordem em
  // que os itens foram efetivamente enviados (sendOrderIndexes), não a ordem do manifest.
  // Snapshot é best-effort: se não achar o evento, salva sem holyricsItemId em vez de falhar
  // uma preparação que já foi concluída.
  const playlistDepois = await getEventMediaPlaylist(client, holyricsEventId, params.eventDateTime).catch(
    (err): { id: string }[] => {
      console.error('Falha ao ler a playlist após preparar:', err);
      return [];
    },
  );
  const holyricsIdByIndex = new Map<number, string>();
  sendOrderIndexes.forEach((index, position) => {
    const entry = playlistDepois[position];
    if (entry) holyricsIdByIndex.set(index, entry.id);
  });

  const preparedManifest: IPreparedManifestItem[] = params.manifest.map((item, index) => {
    const holyricsItemId = holyricsIdByIndex.get(index);
    return holyricsItemId ? { ...item, holyricsItemId } : { ...item };
  });

  // Só no fim, com a playlist já montada: deixa o evento preparado selecionado na interface.
  // Não pode ir antes — durante a montagem o culto selecionado não deve mudar.
  await client.request('SetCurrentSchedule', { event_id: holyricsEventId });

  // Apaga o evento da preparação anterior só depois do novo estar montado e selecionado —
  // assim nunca se apaga o que está selecionado. Best-effort: se falhar, o novo já está pronto
  // e o antigo só fica sobrando no Holyrics.
  if (params.holyricsEventId && params.holyricsEventId !== holyricsEventId) {
    await client.request('DeleteEvent', { id: params.holyricsEventId }).catch((err) => {
      console.error('Falha ao apagar o evento anterior no Holyrics:', err);
    });
  }

  return { holyricsEventId, items: results, preparedManifest };
}
