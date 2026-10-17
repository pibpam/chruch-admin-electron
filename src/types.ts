export interface IHolyricsConnection {
  token: string;
  ip: string;
  port: string;
}

export type TCatalogFile =
  | 'musicas'
  | 'textos'
  | 'temas'
  | 'scripts'
  | 'backgrounds'
  | 'grupos_musica'
  | 'versoes_biblia';

export type ICatalogUrls = Record<TCatalogFile, string>;

export interface IConfigurarIntegracaoParams {
  token: string;
  ip: string;
  port: string;
  alertTemaId?: string;
  mediaBasePath?: string;
  catalogoUrls: ICatalogUrls;
}

/**
 * Item do manifest no formato armazenado pelo backend (LiturgyManifestItem) —
 * NÃO é o formato que o Holyrics espera (ver holyrics/mapManifestItem.ts pra
 * tradução: arquivo->name, song_id->id, text_id->id, script_id->id, text->references).
 */
export interface IManifestItem {
  type: 'video' | 'script' | 'image' | 'song' | 'verse' | 'file' | 'text' | 'title' | 'plain_text' | 'audio';
  /** Id estável do item (uuid) — usado pro diff do Preparar incremental (ver holyrics/prepare.ts). */
  id?: string;
  name?: string;
  background_color?: string;
  origem?: 'base' | 'evento';
  arquivo?: string;
  settings?: { repeat?: boolean };
  script_id?: string;
  song_id?: string;
  musica_id?: string;
  text_id?: string;
  text?: string;
  theme?: string;
  version?: string;
  fromTemplate?: boolean;
  hidden?: boolean;
  [key: string]: unknown;
}

export interface IManifestAsset {
  index: number;
  arquivo: string;
  origem: string;
  metadata: { url: string; etag: string; lastModified: string } | null;
}

/** Item do manifest tal como enviado na última preparação bem-sucedida, com o id que o
 * Holyrics atribuiu na playlist — snapshot salvo em LiturgyPlan.lastPreparedManifest. */
export interface IPreparedManifestItem extends IManifestItem {
  holyricsItemId?: string;
}

export interface IPrepararEventoParams {
  planUuid: string;
  liturgyTypeSlug: string;
  eventName: string;
  /** "YYYY-MM-DD HH:MM", formato que o Holyrics espera pra Event.datetime */
  eventDateTime: string;
  holyricsEventId?: string;
  manifest: IManifestItem[];
  assets: IManifestAsset[];
  /** Snapshot da preparação anterior (LiturgyPlan.lastPreparedManifest) — permite um Preparar
   * incremental (só remove/adiciona o que mudou) em vez de sempre reconstruir a playlist
   * inteira. Ausente/incompleto sempre cai no fallback seguro de reconstrução total. */
  previousManifest?: IPreparedManifestItem[];
}

export interface IPrepararEventoItemResult {
  index: number;
  status: 'ok' | 'error' | 'skipped';
  message?: string;
}

export interface IPrepararEventoResult {
  holyricsEventId: string;
  items: IPrepararEventoItemResult[];
  /** Novo snapshot pra página persistir em LiturgyPlan.lastPreparedManifest. */
  preparedManifest: IPreparedManifestItem[];
}

/**
 * Passo da preparação reportado em tempo real pra página (canal 'holyrics:preparar:progresso').
 * Mesmo `key` = mesma linha do log na tela (running → done/error/warning); `sub` indenta como
 * detalhe do passo anterior (ex.: um arquivo dentro de "Baixando arquivos").
 */
export interface IPrepararProgresso {
  key: string;
  status: 'running' | 'done' | 'warning' | 'error';
  label: string;
  detail?: string;
  sub?: boolean;
}

export interface IPendingSong {
  musica_id: string;
  titulo: string;
  artista?: string;
  slides: { text: string }[];
}

export interface ICriarMusicaPendenteResult {
  musica_id: string;
  holyrics_id: string;
}

export interface IHealthcheckResult {
  connected: boolean;
  version?: string;
  planType?: string;
  apiEnabledLocal?: boolean;
  error?: string;
}

/**
 * Preparação que o processo principal está rodando (ou acabou de rodar) — sobrevive a um reload
 * da página, que usa isso pra se reconectar ao log e registrar o resultado no sistema.
 */
export interface IPreparacaoStatus {
  planUuid: string;
  startedAt: number;
  status: 'running' | 'done' | 'error';
  /** Último estado de cada passo (por key), na ordem em que apareceram. */
  progresso: IPrepararProgresso[];
  result?: IPrepararEventoResult;
  error?: string;
}
