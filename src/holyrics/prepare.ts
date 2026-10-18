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
  IPrepararProgresso,
} from '../types';

/**
 * Baixa o asset referenciado pro disco local (pasta que o Holyrics também usa,
 * ver mediaPaths.ts), rebaixando só se o etag mudou desde a última vez — o
 * etag conhecido fica num arquivo .etag ao lado do arquivo baixado.
 */
async function baixarAsset(item: IManifestItem, asset?: IManifestAsset): Promise<'baixado' | 'em-cache'> {
  if (!asset?.metadata) {
    throw new Error(`O arquivo "${item.arquivo}" não foi encontrado. Reanexe-o na tela do plano.`);
  }

  const filePath = await getMediaFilePath(item.type, item.arquivo as string);
  const etagFile = `${filePath}.etag`;
  const etagConhecido = await fs.readFile(etagFile, 'utf8').catch((): null => null);

  if (etagConhecido === asset.metadata.etag && (await fileExists(filePath))) {
    return 'em-cache';
  }

  const response = await fetch(asset.metadata.url).catch((err) => {
    console.error(`Falha de rede ao baixar "${item.arquivo}":`, err);
    throw new Error(`Sem conexão com a internet para baixar o arquivo "${item.arquivo}".`);
  });
  if (!response.ok) {
    console.error(`Falha ao baixar "${item.arquivo}" (HTTP ${response.status})`);
    throw new Error(`Não foi possível baixar o arquivo "${item.arquivo}".`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buffer).catch((err) => {
    console.error(`Falha ao gravar "${filePath}":`, err);
    throw new Error(`Não foi possível salvar "${item.arquivo}" na pasta de mídia do Holyrics (${filePath}). Verifique o espaço em disco e as permissões da pasta.`);
  });
  await fs.writeFile(etagFile, asset.metadata.etag);
  return 'baixado';
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

interface IPlaylistEntry {
  id: string;
  type?: string;
  name?: string;
}

interface ISchedule {
  media_playlist: IPlaylistEntry[];
  metadata?: { event?: { id?: string | number } | null };
}

/** O Holyrics pode devolver o id do evento como número em um lugar e texto em outro. */
const mesmoEvento = (schedule: ISchedule | null | undefined, eventId: string) =>
  schedule?.metadata?.event?.id !== undefined && String(schedule.metadata.event.id) === String(eventId);

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
): Promise<IPlaylistEntry[]> {
  const [ano, mes] = eventDateTime.split('-').map(Number);
  const agora = new Date();
  const meses = [
    { year: ano, month: mes },
    { year: agora.getFullYear(), month: agora.getMonth() + 1 },
  ].filter((m, i, arr) => m.year && m.month && arr.findIndex((o) => o.year === m.year && o.month === m.month) === i);

  for (const { year, month } of meses) {
    const schedules = await client.request<ISchedule[]>('GetSchedules', { month, year });
    const schedule = schedules.find((s) => mesmoEvento(s, eventId));
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
 * Casa cada item enviado com o id que ele ganhou na playlist do Holyrics. Lê a playlist do culto
 * selecionado (o evento recém-preparado) e, se não for ele, procura pelo GetSchedules. Casa por
 * posição, conferindo o tipo de cada item — pra nunca executar o item errado.
 */
async function vincularItens(
  client: HolyricsClient,
  args: {
    manifest: IManifestItem[];
    holyricsEventId: string;
    eventDateTime: string;
    ordens: number[][];
    tipoDe: (index: number) => string;
    onProgresso: (progresso: IPrepararProgresso) => void;
  },
): Promise<IPreparedManifestItem[]> {
  const key = 'vinculo';
  const label = 'Vinculando os itens para executar pela tela';
  args.onProgresso({ key, status: 'running', label });

  let playlist: IPlaylistEntry[] = [];
  try {
    const resposta = await client.request<ISchedule | ISchedule[]>('GetCurrentSchedule', {});
    const atual = Array.isArray(resposta) ? resposta[0] : resposta;
    playlist = mesmoEvento(atual, args.holyricsEventId)
      ? atual.media_playlist ?? []
      : await getEventMediaPlaylist(client, args.holyricsEventId, args.eventDateTime);
  } catch (err) {
    console.error('Falha ao ler a playlist após preparar:', err);
  }

  // Mesma quantidade de itens: escolhe a ordem (direta ou invertida) em que mais tipos batem e
  // vincula só as posições cujo tipo bate — um item que o Holyrics reporte com outro tipo fica sem
  // botão, mas não derruba o vínculo dos demais nem arrisca executar o item errado.
  const acertos = (indices: number[]) =>
    indices.filter((index, posicao) => playlist[posicao]?.type === args.tipoDe(index)).length;
  const ordem = args.ordens
    .filter((indices) => indices.length > 0 && indices.length === playlist.length)
    .sort((a, b) => acertos(b) - acertos(a))
    .find((indices) => acertos(indices) * 2 >= indices.length);

  const idPorIndice = new Map<number, string>();
  ordem?.forEach((index, posicao) => {
    if (playlist[posicao]?.type === args.tipoDe(index)) idPorIndice.set(index, String(playlist[posicao].id));
  });

  const semVinculo = ordem ? ordem.length - idPorIndice.size : 0;
  if (ordem && !semVinculo) {
    args.onProgresso({ key, status: 'done', label, detail: `${idPorIndice.size} item(ns) vinculado(s)` });
  } else if (ordem) {
    console.error('Itens com tipo diferente na playlist do Holyrics:', playlist);
    args.onProgresso({
      key,
      status: 'warning',
      label,
      detail: `${idPorIndice.size} item(ns) vinculado(s) · ${semVinculo} sem o botão Executar (tipo diferente no Holyrics)`,
    });
  } else {
    console.error('Playlist do Holyrics não bate com os itens enviados:', playlist);
    args.onProgresso({
      key,
      status: 'warning',
      label,
      detail: playlist.length
        ? 'A playlist do Holyrics não bate com o roteiro enviado — o botão Executar não ficará disponível.'
        : 'Não foi possível ler a playlist do Holyrics — o botão Executar não ficará disponível.',
    });
  }

  return args.manifest.map((item, index) => {
    const holyricsItemId = idPorIndice.get(index);
    return holyricsItemId ? { ...item, holyricsItemId } : { ...item };
  });
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
export async function prepararEvento(
  params: IPrepararEventoParams,
  onProgresso: (progresso: IPrepararProgresso) => void = () => undefined,
): Promise<IPrepararEventoResult> {
  /** Roda um passo reportando running → done/error. Erro é repassado com a mesma mensagem. */
  async function etapa<T>(key: string, label: string, fn: () => Promise<T>, detalheOk?: (r: T) => string): Promise<T> {
    onProgresso({ key, status: 'running', label });
    try {
      const resultado = await fn();
      onProgresso({ key, status: 'done', label, detail: detalheOk?.(resultado) });
      return resultado;
    } catch (err) {
      onProgresso({ key, status: 'error', label, detail: (err as Error).message });
      throw err;
    }
  }

  const client = new HolyricsClient(state.requireConnection());

  await etapa('pendencias', 'Conferindo músicas novas', async () => {
    const pendencias = params.manifest.filter(
      (item) => !item.hidden && item.type === 'song' && item.musica_id && !item.song_id,
    );
    if (pendencias.length > 0) {
      throw new Error(
        `${pendencias.length} letra(s) nova(s) ainda não foram criadas no Holyrics. Crie-as na tela de Músicas Pendentes antes de preparar.`,
      );
    }
  });

  await etapa('versao', 'Verificando a versão do Holyrics', () => garantirVersaoComEventId(client), () => 'Compatível');

  // Sempre cria um evento novo (playlist vazia) em vez de limpar a playlist do anterior —
  // o id novo volta no resultado pra página persistir no lugar do antigo.
  const created = await etapa(
    'evento',
    'Criando o culto no Holyrics',
    () =>
      client.request<{ id: string }>('CreateEvent', {
        name: params.eventName,
        // datetime: '2026-09-16 21:00:00',
      }),
    () => params.eventName,
  );
  const holyricsEventId = created.id;

  const assetsByIndex = new Map(params.assets.map((asset) => [asset.index, asset]));
  const errosDownload = new Map<number, string>();

  const comArquivo = params.manifest
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.hidden && item.arquivo);

  if (comArquivo.length > 0) {
    const labelDownload = 'Baixando arquivos de mídia';
    onProgresso({ key: 'downloads', status: 'running', label: labelDownload, detail: `0 de ${comArquivo.length}` });
    let baixados = 0;
    let emCache = 0;
    for (let posicao = 0; posicao < comArquivo.length; posicao++) {
      const { item, index } = comArquivo[posicao];
      const key = `download:${index}`;
      onProgresso({
        key: 'downloads',
        status: 'running',
        label: labelDownload,
        detail: `${posicao + 1} de ${comArquivo.length} · ${item.arquivo}`,
      });
      onProgresso({ key, status: 'running', label: item.arquivo as string, sub: true });
      try {
        const resultado = await baixarAsset(item, assetsByIndex.get(index));
        if (resultado === 'baixado') baixados++;
        else emCache++;
        onProgresso({
          key,
          status: 'done',
          label: item.arquivo as string,
          detail: resultado === 'baixado' ? 'Baixado' : 'Já estava atualizado no computador',
          sub: true,
        });
      } catch (err) {
        errosDownload.set(index, (err as Error).message);
        onProgresso({ key, status: 'error', label: item.arquivo as string, detail: (err as Error).message, sub: true });
      }
    }
    const resumo = [
      baixados ? `${baixados} baixado(s)` : '',
      emCache ? `${emCache} já atualizado(s)` : '',
      errosDownload.size ? `${errosDownload.size} com falha` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    onProgresso({
      key: 'downloads',
      status: errosDownload.size ? 'warning' : 'done',
      label: labelDownload,
      detail: resumo,
    });
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
    const comAlerta = results.filter((r) => r.status === 'error').length;
    await etapa(
      'playlist',
      'Montando a playlist do culto',
      () => client.request('AddToPlaylist', { items: itemsToAdd, event_id: holyricsEventId }),
      () =>
        `${itemsToAdd.length} item(ns) enviados` + (comAlerta ? ` · ${comAlerta} como alerta de item faltando` : ''),
    );
  }

  // Só no fim, com a playlist já montada: deixa o evento preparado selecionado na interface.
  // Não pode ir antes — durante a montagem o culto selecionado não deve mudar.
  await etapa('selecionar', 'Selecionando o culto na tela do Holyrics', () =>
    client.request('SetCurrentSchedule', { event_id: holyricsEventId }),
  );

  // Snapshot pra lastPreparedManifest: o id que o Holyrics deu a cada item da playlist é o que o
  // botão "Executar" da página usa (MediaPlaylistAction). Lido depois de selecionar, pelo culto
  // selecionado (GetCurrentSchedule) — o GetSchedules por mês nem sempre acha o evento recém-criado.
  // Best-effort: se não der pra vincular, a preparação não falha, só avisa.
  const preparedManifest = await vincularItens(client, {
    manifest: params.manifest,
    holyricsEventId,
    eventDateTime: params.eventDateTime,
    // Ordem do manifest e ordem de envio (invertida) — a playlist pode estar em qualquer uma.
    ordens: [resolvedIndexes, sendOrderIndexes],
    tipoDe: (index) => String((resolved[index] as Record<string, unknown>).type || ''),
    onProgresso,
  });

  // Apaga o evento da preparação anterior só depois do novo estar montado e selecionado —
  // assim nunca se apaga o que está selecionado. Best-effort: se falhar, o novo já está pronto
  // e o antigo só fica sobrando no Holyrics.
  if (params.holyricsEventId && params.holyricsEventId !== holyricsEventId) {
    const label = 'Removendo a preparação anterior';
    onProgresso({ key: 'limpeza', status: 'running', label });
    await client
      .request('DeleteEvent', { id: params.holyricsEventId })
      .then(() => onProgresso({ key: 'limpeza', status: 'done', label }))
      .catch((err) => {
        console.error('Falha ao apagar o evento anterior no Holyrics:', err);
        onProgresso({
          key: 'limpeza',
          status: 'warning',
          label,
          detail: 'O culto antigo continua na lista do Holyrics — pode ser apagado manualmente.',
        });
      });
  }

  return { holyricsEventId, items: results, preparedManifest };
}
