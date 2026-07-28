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
  catalogoUrls: ICatalogUrls;
}

/**
 * Item do manifest no formato armazenado pelo backend (LiturgyManifestItem) —
 * NÃO é o formato que o Holyrics espera (ver holyrics/mapManifestItem.ts pra
 * tradução: arquivo->name, song_id->id, text_id->id, script_id->id, text->references).
 */
export interface IManifestItem {
  type: 'video' | 'script' | 'image' | 'song' | 'verse' | 'file' | 'text' | 'title' | 'plain_text' | 'audio';
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

export interface IPrepararEventoParams {
  planUuid: string;
  liturgyTypeSlug: string;
  eventName: string;
  /** "YYYY-MM-DD HH:MM", formato que o Holyrics espera pra Event.datetime */
  eventDateTime: string;
  holyricsEventId?: string;
  manifest: IManifestItem[];
  assets: IManifestAsset[];
}

export interface IPrepararEventoItemResult {
  index: number;
  status: 'ok' | 'error' | 'skipped';
  message?: string;
}

export interface IPrepararEventoResult {
  holyricsEventId: string;
  items: IPrepararEventoItemResult[];
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
